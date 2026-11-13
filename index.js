import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { intelligenceModel, INTELLIGENCE_PROBES, checkIntelligenceAnswer } from './intelligence.js';

export { intelligenceModel, INTELLIGENCE_PROBES, checkIntelligenceAnswer };

export const name = 'dsh-model-probe';
export const inject = ['webServer', 'llm'];

const API = '/api/dsh-model-probe';
const DEFAULT_TIMEOUT = 45000;
const DEFAULT_MAX_TOKENS = 32;
const SVG_TIMEOUT = 300000;
const SVG_MAX_TOKENS = 16384;
const SVG_MAX_BYTES = 32768;
const PROMPT = 'Reply with OK only.';
const SVG_PROMPT = 'Generate an animated SVG of a pelican riding a bicycle. Reply with SVG code only.\n\nUse native SVG SMIL animation, especially <animate> and <animateTransform>, to visibly rotate the bicycle wheels and move the pelican or bicycle. Include at least one visible looping animation with repeatCount="indefinite" and a duration between 2 and 6 seconds. Nest animation elements inside their target shapes. Output one complete SVG only. Do not use scripts, CSS, <style>, <use>, external resources or links.';
const CUSTOM_SVG_CONTRACT = 'Create one complete standalone SVG image for the user request below. Reply with SVG code only, starting with <svg and ending with </svg>. Do not include Markdown fences, explanations, HTML, or any text outside the SVG. Keep it self-contained. Use a concise, stylized composition with simple shapes; keep the SVG under 12,000 bytes and 100 elements so the closing </svg> is always emitted. Do not use scripts, CSS, <style>, <use>, external resources or links. If the request asks for animation, use native SVG SMIL animation.\n\nUser request:\n';
const CUSTOM_SVG_QUICK_CONTRACT = CUSTOM_SVG_CONTRACT.replace(
  'Use a concise, stylized composition with simple shapes; keep the SVG under 12,000 bytes and 100 elements',
  'Use a minimal flat pictogram made from simple geometric silhouettes, not a detailed illustration. Avoid text, gradients, textures, fine details and complex paths. Keep the SVG under 3,000 bytes and at most 24 elements including the root <svg> element'
);
const CUSTOM_SVG_QUICK_LIMITS = { maxBytes: 3000, maxElements: 30 };

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

export function sanitizeSvg(text, options = {}) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const match = source.match(/<svg(?:\s[^>]*)?>[\s\S]*?<\/svg\s*>/i);
  if (!match) throw new Error('模型回复中没有完整的 SVG');
  let svg = match[0]
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|foreignObject|iframe|object|embed|image|use|style|discard)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed|image|use|style|discard)\b[^>]*\/\s*>/gi, '')
    .replace(/\s+(?:on[a-z0-9_-]+|href|xlink:href|src|srcdoc|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/url\(\s*['"]?\s*(?!#)[^)]*\)/gi, 'none');
  if (/<(?:script|foreignObject|iframe|object|embed|image|use|style|discard)\b/i.test(svg) || /\son[a-z0-9_-]+\s*=/i.test(svg) || /(?:javascript|data):/i.test(svg)) {
    throw new Error('SVG 含有不支持的脚本或外部内容');
  }
  for (const tag of svg.matchAll(/<(?:animate|animateMotion|animateTransform|set)\b[^>]*>/gi)) {
    const attribute = tag[0].match(/\battributeName\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const target = (attribute?.[1] || attribute?.[2] || attribute?.[3] || '').trim().toLowerCase();
    if (target.startsWith('on') || ['href', 'xlink:href', 'src', 'style'].includes(target)) {
      throw new Error('SVG 动画不能修改事件、链接或样式属性');
    }
  }
  svg = svg.trim();
  const bytes = Buffer.byteLength(svg, 'utf8');
  const elementCount = (svg.match(/<[A-Za-z][^>]*>/g) || []).length;
  const animationCount = (svg.match(/<(?:animate|animateMotion|animateTransform)\b/gi) || []).length;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : SVG_MAX_BYTES;
  const maxElements = Number.isFinite(options.maxElements) ? options.maxElements : Infinity;
  if (bytes > maxBytes) throw new Error(`清洗后 SVG 超过 ${maxBytes === SVG_MAX_BYTES ? `${maxBytes / 1024} KiB` : `${maxBytes} 字节`}`);
  if (elementCount > maxElements) throw new Error(`SVG 超过 ${maxElements} 个元素（实际 ${elementCount} 个）`);
  return { svg, bytes, elementCount, animationCount };
}

export async function probeModel(llm, input, signal) {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!provider || !model) throw new Error('provider 和 model 不能为空');
  const type = input.type === 'svg' || input.type === 'custom-svg' ? input.type : 'connection';
  const isSvg = type === 'svg' || type === 'custom-svg';
  const customPrompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const quick = type === 'custom-svg' && input.quick !== false;
  if (type === 'custom-svg' && !customPrompt) throw new Error('自定义 SVG 提示词不能为空');
  if (customPrompt.length > 4000) throw new Error('自定义 SVG 提示词不能超过 4000 个字符');
  const timeoutMs = Math.max(3000, Math.min(isSvg ? 600000 : 120000, Number(input.timeoutMs) || (isSvg ? SVG_TIMEOUT : DEFAULT_TIMEOUT)));
  const maxTokens = Math.max(1, Math.min(isSvg ? SVG_MAX_TOKENS : 512, Number(input.maxTokens) || (type === 'custom-svg' && quick ? 4096 : isSvg ? SVG_MAX_TOKENS : DEFAULT_MAX_TOKENS)));
  const prompt = type === 'custom-svg' ? `${quick ? CUSTOM_SVG_QUICK_CONTRACT : CUSTOM_SVG_CONTRACT}${customPrompt}` : type === 'svg' ? SVG_PROMPT : PROMPT;
  const startedAt = Date.now();
  const started = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('测试已停止'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${isSvg ? 'SVG 检测' : '连接测试'}超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
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
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
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
    const result = {
      ok: true, type, quick: type === 'custom-svg' ? quick : undefined, provider, model, startedAt, elapsedMs: Math.round(performance.now() - started), firstTokenMs,
      mode: 'stream', reply: reply.trim().slice(0, isSvg ? 4000 : 1000), reasoning: reasoning.trim().slice(0, 1000), usage,
      exactReply: isSvg ? undefined : reply.trim().toUpperCase() === 'OK',
      request: { provider, model, quick: type === 'custom-svg' ? quick : undefined, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens, stream: true },
    };
    if (isSvg) {
      try {
        const { svg, bytes, elementCount, animationCount } = sanitizeSvg(reply, type === 'custom-svg' && quick ? CUSTOM_SVG_QUICK_LIMITS : {});
        result.svg = svg;
        result.svgBytes = bytes;
        result.elementCount = elementCount;
        result.animationCount = animationCount;
        if (type === 'svg' && !animationCount) {
          result.ok = false;
          result.code = 'STATIC_SVG';
          result.message = '模型返回的 SVG 没有原生动画';
        }
      } catch (error) {
        result.ok = false;
        result.code = quick && /超过/.test(textOf(error)) ? 'SVG_LIMIT_EXCEEDED' : 'INVALID_SVG';
        result.message = redact(textOf(error));
      }
    }
    return result;
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

export const FINGERPRINT_PROBES = [
  { id: 'identity', prompt: 'What exact model are you currently running as? Reply with the model identifier only, without explanation.', maxTokens: 512 },
  { id: 'exact', prompt: 'Reply with exactly DSH_FP_OK and nothing else.', maxTokens: 64 },
  { id: 'reasoning', prompt: 'Calculate 37 * 19 - 46. Reply with the number only.', maxTokens: 128 },
  { id: 'json', prompt: 'Return only this JSON object with no Markdown: {"alpha":17,"beta":["x","y"]}', maxTokens: 128 },
  { id: 'noise', prompt: 'Noise prefix: ## random / ignored. Repeat exactly this token and nothing else: N7Q9-X2M4', maxTokens: 96 },
  { id: 'code', prompt: 'Write one JavaScript function named square that returns n * n. Reply with code only.', maxTokens: 384 },
  { id: 'language', prompt: '用中文回答，只输出：模型指纹测试通过', maxTokens: 128 },
];

function plainAnswer(text) {
  return String(text || '').trim().replace(/^```(?:json|javascript|js|text)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function fingerprintCheck(id, reply) {
  const answer = plainAnswer(reply);
  if (id === 'exact') return answer === 'DSH_FP_OK';
  if (id === 'reasoning') return /^(?:657|657\.0)$/.test(answer);
  if (id === 'noise') return answer === 'N7Q9-X2M4';
  if (id === 'language') return answer === '模型指纹测试通过';
  if (id === 'code') return /function\s+square\s*\(/.test(answer) && /n\s*\*\s*n/.test(answer);
  if (id === 'json') {
    try { const value = JSON.parse(answer); return value.alpha === 17 && JSON.stringify(value.beta) === '["x","y"]'; } catch { return false; }
  }
  return answer.length > 0;
}

async function collectFingerprintSample(llm, route, probe, signal, timeoutMs) {
  const started = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new Error('测试已停止'));
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('单次指纹探针超时')), timeoutMs);
  let reply = '';
  let reasoning = '';
  let firstTokenMs;
  let usage;
  let finishKind;
  let failure;
  try {
    const stream = llm.stream({ ...route, messages: [{ role: 'user', content: [{ type: 'text', text: probe.prompt }] }], maxTokens: probe.maxTokens, signal: controller.signal });
    for await (const chunk of stream) {
      if (firstTokenMs === undefined && ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text)) firstTokenMs = Math.round(performance.now() - started);
      if (chunk.type === 'text-delta') reply += chunk.text;
      if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') {
        finishKind = chunk.reason?.kind;
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure;
      }
    }
    if (failure) throw Object.assign(new Error(failure.message || '模型请求失败'), { code: failure.code });
    if (!['stop', 'tool-calls', 'max-tokens'].includes(finishKind)) throw new Error(`流未正常结束（${finishKind || '无 finish'}）`);
    return { id: probe.id, ok: true, passed: fingerprintCheck(probe.id, reply), prompt: probe.prompt, reply: reply.slice(0, 1600), reasoning: reasoning.slice(0, 400), elapsedMs: Math.round(performance.now() - started), firstTokenMs, usage };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function fingerprintModel(llm, input, signal = new AbortController().signal) {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!provider || !model) throw new Error('provider 和 model 不能为空');
  const route = { provider, model };
  const startedAt = Date.now();
  const started = performance.now();
  const totalTimeoutMs = Math.max(60000, Math.min(600000, Number(input.timeoutMs) || 360000));
  const perProbeTimeoutMs = Math.max(5000, Math.min(90000, Number(input.perProbeTimeoutMs) || 45000));
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new Error('测试已停止'));
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('模型指纹检测超时')), totalTimeoutMs);
  const probes = [];
  try {
    for (const probe of FINGERPRINT_PROBES) {
      if (controller.signal.aborted) break;
      try { probes.push(await collectFingerprintSample(llm, route, probe, controller.signal, perProbeTimeoutMs)); }
      catch (error) {
        probes.push({ id: probe.id, ok: false, passed: false, prompt: probe.prompt, code: error?.code || (controller.signal.aborted ? 'ABORTED' : 'PROBE_ERROR'), message: redact(textOf(error)) });
        if (controller.signal.aborted) break;
      }
    }
    const elapsedMs = Math.round(performance.now() - started);
    if (controller.signal.aborted) return { ok: false, type: 'fingerprint', provider, model, startedAt, elapsedMs, code: 'ABORTED', message: redact(textOf(controller.signal.reason)), probes };
    const completed = probes.filter((probe) => probe.ok);
    if (!completed.length) return { ok: false, type: 'fingerprint', provider, model, startedAt, elapsedMs, code: 'FINGERPRINT_FAILED', message: '所有指纹探针均失败', probes };
    const behavioral = FINGERPRINT_PROBES.filter((probe) => probe.id !== 'identity');
    const checks = Object.fromEntries(behavioral.map((probe) => [probe.id, probes.find((item) => item.id === probe.id)?.passed === true]));
    const passed = Object.values(checks).filter(Boolean).length;
    const lengths = completed.map((probe) => Buffer.byteLength(plainAnswer(probe.reply), 'utf8'));
    const latencies = completed.map((probe) => probe.elapsedMs).sort((a, b) => a - b);
    const firstTokenLatencies = completed.map((probe) => probe.firstTokenMs).filter((value) => Number.isFinite(value));
    const latencyMs = {
      mean: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      median: latencies[Math.floor(latencies.length / 2)],
      p95: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)],
      min: latencies[0], max: latencies[latencies.length - 1],
      ttftMean: firstTokenLatencies.length ? Math.round(firstTokenLatencies.reduce((sum, value) => sum + value, 0) / firstTokenLatencies.length) : null,
    };
    const features = {
      checks,
      completionRate: Number((completed.length / FINGERPRINT_PROBES.length).toFixed(3)),
      meanAnswerBytes: Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length),
      medianLatencyMs: latencies[Math.floor(latencies.length / 2)],
      markdownRate: Number((completed.filter((probe) => /```/.test(probe.reply)).length / completed.length).toFixed(3)),
      meanOutputTokens: Math.round(completed.reduce((sum, probe) => sum + (Number(probe.usage?.outputTokens) || 0), 0) / completed.length),
    };
    const reportedModel = plainAnswer(probes.find((probe) => probe.id === 'identity')?.reply).slice(0, 160);
    const normalizedClaim = model.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedReport = reportedModel.toLowerCase().replace(/[^a-z0-9]/g, '');
    const claimedModelHintMatch = normalizedReport ? normalizedReport.includes(normalizedClaim) || normalizedClaim.includes(normalizedReport) : null;
    const responseDigest = createHash('sha256').update(probes.map((probe) => `${probe.id}:${plainAnswer(probe.reply)}`).join('\n')).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify(features)).digest('hex');
    return {
      ok: true, type: 'fingerprint', provider, model, startedAt, elapsedMs, fingerprint, responseDigest,
      score: Math.round(100 * passed / behavioral.length), passed, totalChecks: behavioral.length,
      confidence: Math.round(100 * completed.length / FINGERPRINT_PROBES.length), completed: completed.length, totalProbes: FINGERPRINT_PROBES.length,
      partial: completed.length < FINGERPRINT_PROBES.length, reportedModel, claimedModelHintMatch, latencyMs, features, probes,
      request: { provider, model, probeCount: FINGERPRINT_PROBES.length, probeIds: FINGERPRINT_PROBES.map((probe) => probe.id), stream: true },
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
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
        const controller = runId ? beginRun(runId) : new AbortController();
        try {
          const result = await probeModel(ctx.llm, body, controller.signal);
          writeJson(res, 200, result);
        } finally {
          if (runId && activeTests.get(runId) === controller) activeTests.delete(runId);
        }
      })),
      ctx.webServer.register(route(`${API}/fingerprint`, async (req, res) => {
        const body = await readJson(req);
        const runId = typeof body.runId === 'string' ? body.runId.slice(0, 100) : '';
        const controller = runId ? beginRun(runId) : new AbortController();
        try {
          const result = await fingerprintModel(ctx.llm, body, controller.signal);
          writeJson(res, 200, result);
        } finally {
          if (runId && activeTests.get(runId) === controller) activeTests.delete(runId);
        }
      })),
      ctx.webServer.register(route(`${API}/intelligence`, async (req, res) => {
        const body = await readJson(req);
        const runId = typeof body.runId === 'string' ? body.runId.slice(0, 100) : '';
        const controller = runId ? beginRun(runId) : new AbortController();
        try {
          const result = await intelligenceModel(ctx.llm, body, controller.signal);
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
