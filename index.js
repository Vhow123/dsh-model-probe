import { performance } from 'node:perf_hooks';

export const name = 'dsh-model-probe';
export const inject = ['webServer', 'llm'];

const API = '/api/dsh-model-probe';
const DEFAULT_TIMEOUT = 45000;
const DEFAULT_MAX_TOKENS = 32;
const PROMPT = 'Reply with OK only.';

function textOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***')
    .slice(0, 1200);
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function loopback(req) {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let local;
  try { local = new URL(`http://${host}`); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin === undefined) return true;
  try { return new URL(req.headers.origin).host === local.host; } catch { return false; }
}

function guard(req, res) {
  if (!loopback(req)) {
    writeJson(res, 403, { ok: false, message: '仅允许本机同源请求' });
    return false;
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, message: '仅支持 POST' });
    return false;
  }
  return true;
}

export async function readCatalog(llm) {
  const providers = llm.listProviders();
  const groups = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await llm.listModels(provider.id);
      return {
        provider: provider.id,
        name: provider.name || provider.displayName || provider.id,
        models: models.map((model) => ({ id: model.id, name: model.name || model.id })),
      };
    } catch (error) {
      return { provider: provider.id, name: provider.name || provider.id, models: [], error: redact(textOf(error)) };
    }
  }));
  return { groups, total: groups.reduce((sum, group) => sum + group.models.length, 0) };
}

export async function probeModel(llm, input, signal) {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!provider || !model) throw new Error('provider 和 model 不能为空');
  const timeoutMs = Math.max(3000, Math.min(120000, Number(input.timeoutMs) || DEFAULT_TIMEOUT));
  const maxTokens = Math.max(1, Math.min(512, Number(input.maxTokens) || DEFAULT_MAX_TOKENS));
  const startedAt = Date.now();
  const started = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('测试已停止'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`连接测试超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
  let firstTokenMs;
  let reply = '';
  let reasoning = '';
  let usage;
  let failure;
  let finishKind;
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
      maxTokens,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (firstTokenMs === undefined && ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text || chunk.type === 'tool-call-delta')) {
        firstTokenMs = Math.round(performance.now() - started);
      }
      if (chunk.type === 'text-delta') reply += chunk.text;
      if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') {
        finishKind = chunk.reason?.kind;
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure;
      }
    }
    if (failure) {
      return {
        ok: false, provider, model, startedAt, elapsedMs: Math.round(performance.now() - started),
        firstTokenMs, mode: 'stream', code: failure.code || (finishKind === 'aborted' ? 'ABORTED' : 'UNKNOWN'),
        status: failure.status, message: redact(failure.message || '模型请求失败'), reply: reply.slice(0, 1000), usage,
      };
    }
    if (!['stop', 'tool-calls', 'max-tokens'].includes(finishKind)) {
      return {
        ok: false, provider, model, startedAt, elapsedMs: Math.round(performance.now() - started), firstTokenMs,
        mode: 'stream', code: 'INCOMPLETE_STREAM', message: `流未正常结束（${finishKind || '无 finish'}）`, reply: reply.slice(0, 1000), usage,
      };
    }
    return {
      ok: true, provider, model, startedAt, elapsedMs: Math.round(performance.now() - started), firstTokenMs,
      mode: 'stream', reply: reply.trim().slice(0, 1000), reasoning: reasoning.trim().slice(0, 1000), usage,
      exactReply: reply.trim().toUpperCase() === 'OK',
      request: { provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }], maxTokens, stream: true },
    };
  } catch (error) {
    return {
      ok: false, provider, model, startedAt, elapsedMs: Math.round(performance.now() - started), firstTokenMs,
      mode: 'stream', code: error?.code || (controller.signal.aborted ? 'TIMEOUT' : 'REQUEST_ERROR'),
      status: error?.status, message: redact(textOf(error)), reply: reply.slice(0, 1000), usage,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const activeTests = new Map();
const runTimes = new Map();
const MAX_RUN_HISTORY = 1000;

function beginRun(runId) {
  const now = Date.now();
  if (runTimes.size >= MAX_RUN_HISTORY) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [id, time] of runTimes) {
      if (time < cutoff || runTimes.size >= MAX_RUN_HISTORY) runTimes.delete(id);
      if (runTimes.size < MAX_RUN_HISTORY) break;
    }
  }
  runTimes.set(runId, now);
  activeTests.get(runId)?.abort(new Error('已被新的测试取代'));
  const controller = new AbortController();
  activeTests.set(runId, controller);
  return controller;
}

function route(path, handler) {
  return {
    kind: 'exact', path,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try { await handler(req, res); } catch (error) {
        writeJson(res, 200, { ok: false, code: error?.code || 'PLUGIN_ERROR', message: redact(textOf(error)) });
      }
    },
  };
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register(route(`${API}/catalog`, async (_req, res) => {
        const catalog = await readCatalog(ctx.llm);
        writeJson(res, 200, { ok: true, ...catalog });
      })),
      ctx.webServer.register(route(`${API}/test`, async (req, res) => {
        const body = await readJson(req);
        const runId = typeof body.runId === 'string' ? body.runId.slice(0, 100) : '';
        const controller = new AbortController();
        if (runId) beginRun(runId);
        try {
          const result = await probeModel(ctx.llm, body, controller.signal);
          writeJson(res, 200, result);
        } finally {
          if (runId && activeTests.get(runId) === controller) activeTests.delete(runId);
        }
      })),
      ctx.webServer.register(route(`${API}/stop`, async (req, res) => {
        const body = await readJson(req);
        const ids = [...new Set([body.runId, ...(Array.isArray(body.runIds) ? body.runIds : [])].filter((id) => typeof id === 'string' && runTimes.has(id)))];
        let stopped = 0;
        for (const runId of ids) {
          runTimes.delete(runId);
          const controller = activeTests.get(runId);
          activeTests.delete(runId);
          if (!controller) continue;
          stopped += 1;
          controller.abort(new Error('测试已停止'));
        }
        writeJson(res, 200, { ok: true, stopped });
      })),
    ];
    return () => {
      for (const controller of activeTests.values()) controller.abort(new Error('插件正在重新加载'));
      activeTests.clear();
      runTimes.clear();
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'dsh-model-probe: routes');
}
