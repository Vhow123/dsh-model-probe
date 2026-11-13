import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { tokenizerVerdict, TOKENIZER_VERSION, TOKENIZER_IDS } from './tokenizers.js';

// Behavioral probes answer "does this endpoint still behave like a model at
// all". The distribution probe answers a different question: "is this the same
// model as last time". Sampling distributions are a statistical property that
// an upstream cannot fake without actually running the original model, which is
// why they carry identity signal that a self-reported name never will.

const COMPLETED = new Set(['stop', 'tool-calls', 'max-tokens']);

export const BEHAVIOR_PROBES = [
  // The identity probe is the slowest by far on reasoning models: thinking burns a
  // long prefix before the name appears, so it gets its own budget.
  { id: 'identity', prompt: 'What exact model are you currently running as? Reply with the model identifier only, without explanation.', maxTokens: 4096, timeoutMs: 150000 },
  { id: 'exact', prompt: 'Reply with exactly DSH_FP_OK and nothing else.', maxTokens: 96 },
  { id: 'reasoning', prompt: 'Calculate 37 * 19 - 46. Reply with the number only.', maxTokens: 1024 },
  { id: 'json', prompt: 'Return only this JSON object with no Markdown: {"alpha":17,"beta":["x","y"]}', maxTokens: 512 },
  { id: 'noise', prompt: 'Noise prefix: ## random / ignored. Repeat exactly this token and nothing else: N7Q9-X2M4', maxTokens: 256 },
  { id: 'code', prompt: 'Write one JavaScript function named square that returns n * n. Reply with code only.', maxTokens: 768 },
  { id: 'language', prompt: '用中文回答，只输出：模型指纹测试通过', maxTokens: 512 },
];

// Kept as an alias so existing callers and tests keep working.
export const FINGERPRINT_PROBES = BEHAVIOR_PROBES;

export const STAT = { samples: 3, numbers: 200, min: 1, max: 100, bins: 8 };

// Bumping this invalidates every stored identity baseline. Drift is decided by
// comparing each recorded answer, so changing the normalisation changes the
// answers without the models changing at all — and a baseline recorded under the
// previous scheme would make a healthy route look like a swapped backend on the
// first run after an upgrade. A version tag turns that into a rebuilt baseline
// instead of a false drift alarm.
const IDENTITY_VERSION = 2;

// Sampling distributions only describe the sampler, and most routes run uniform
// random number draws, so they cannot tell two models apart. Short closed-form
// answers do: they are what a greedy decode reproduces byte for byte. Free-form
// prose is deliberately excluded — a routed endpoint that load-balances across
// backends rewrites it every time, which is a routing fact, not an identity one.
// Two kinds of probes, for two different jobs.
//
// Factual questions verify that the thing on the other end can still answer at
// all, but every competent model replies identically, so they cannot separate two
// healthy models. Preference questions have no single right answer; at
// temperature 0 each model still commits to its own favourite, and that favourite
// is what differs between models. Measured across three rival models on the same
// route: number 42 / 47 / 57, colour Blue / Green, letter A, language Python.
//
// A question is only usable as identity evidence if the model reproduces its own
// answer. Multi-answer questions (pick three numbers) were dropped after they
// failed that test: one run out of two answered '7, 23, 42, 68, 91' to a
// three-number prompt.
export const DETERMINISTIC_PROBES = [
  { id: 'pick-number', prompt: 'Pick a number between 1 and 100. Reply with the number only.', maxTokens: 512 },
  { id: 'pick-colour', prompt: 'Name one colour. Reply with the colour only.', maxTokens: 512 },
  { id: 'pick-letter', prompt: 'Pick one letter of the English alphabet. Reply with the letter only.', maxTokens: 512 },
  { id: 'pick-lang', prompt: 'Name one programming language. Reply with the name only.', maxTokens: 512 },
];

export function distributionPrompt(index, numbers = STAT.numbers) {
  return `Run ${index}. Write exactly ${numbers} random integers between ${STAT.min} and ${STAT.max}, separated by commas. Reply with the numbers only: no explanation, no code fences, no line numbers.`;
}

// The tokenizer is the one property that identifies a model family from outside
// without any reference to behavior. Text goes in, the endpoint reports how many
// prompt tokens it counted; that count comes from the vendor's own vocabulary
// files and cannot be imitated by a relay that only forwards text. It costs one
// cheap call per string and needs no cooperation from the model.
//
// The strings are byte-pinned. Changing one character changes every count, so
// they are versioned with the probe set and must never be edited in place.
//
// Measured values are taken as a DIFFERENCE against a one-character baseline:
// every serving stack wraps the request in its own hidden template, and that
// template adds a constant that has nothing to do with the model. Subtracting
// it is what lets two hosts wrapping the same tokenizer agree, which raw counts
// never do.
export const TOKENIZER_PROBES = [
  {
    id: 'tok-english',
    text: 'The quick brown fox jumps over the lazy dog while packing my box '
      + 'with five dozen liquor jugs; sphinx of black quartz, judge my vow. '
      + 'Amazingly few discotheques provide jukeboxes, yet vexed zombies quip.',
  },
  {
    id: 'tok-chinese',
    text: '机器学习模型将文本切分为词元，每个实验室的切分方式都不同。'
      + '上下文窗口、注意力机制与位置编码共同决定了模型如何理解长文档。'
      + '爬虫抓取网页时也面临同样的分词问题，尤其是中日韩文字混排的场景。',
  },
  {
    id: 'tok-code',
    text: 'def fingerprint(endpoint: str, *, probes: list[str]) -> dict:\n'
      + '    """Run every probe against one endpoint."""\n'
      + '    results = {p: run(endpoint, p) for p in probes}\n'
      + '    return {k: v for k, v in sorted(results.items()) if v is not None}\n',
  },
  {
    id: 'tok-emoji',
    text: '🦀🚀🧠 ᚠᚢᚦᚨᚱᚲ 𝔪𝔬𝔡𝔢𝔩𝔭𝔯𝔦𝔫𝔱 🐍→🔍 ∑∏∫√ ⠓⠑⠇⠇⠕ 你好世界 مرحبا שלום',
  },
];

// One-character prompt used to cancel the serving template out of every count.
const TOKENIZER_BASELINE = 'a';


function textOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***')
    .slice(0, 1200);
}

export function plainAnswer(text) {
  return String(text || '').trim().replace(/^```(?:json|javascript|js|text)?\s*/i, '').replace(/\s*```$/, '').trim();
}

// A preference probe asks for a favourite, and the same model answers it in
// whatever language the prompt happens to steer it toward: one route replied
// 'Blue' to "Name one colour" and another route of the same backend replied
// '蓝色'. Comparing the raw strings would call that a model swap, so answers are
// folded onto one canonical term before the identity digest is built.
const COLOURS = [
  ['sky blue', 'blue'], ['天蓝', 'blue'], ['深蓝', 'blue'], ['蓝', 'blue'], ['blue', 'blue'],
  ['绿', 'green'], ['green', 'green'],
  ['红', 'red'], ['red', 'red'],
  ['黄', 'yellow'], ['yellow', 'yellow'],
  ['橙', 'orange'], ['orange', 'orange'],
  ['紫', 'purple'], ['purple', 'purple'],
  ['粉', 'pink'], ['pink', 'pink'],
  ['黑', 'black'], ['black', 'black'],
  ['白', 'white'], ['white', 'white'],
  ['灰', 'grey'], ['grey', 'grey'], ['gray', 'grey'],
  ['棕', 'brown'], ['褐', 'brown'], ['brown', 'brown'],
  ['青', 'cyan'], ['cyan', 'cyan'], ['teal', 'cyan'],
  ['金', 'gold'], ['gold', 'gold'],
  ['银', 'silver'], ['silver', 'silver'],
  ['magenta', 'magenta'], ['品红', 'magenta'],
  ['indigo', 'indigo'], ['靛', 'indigo'],
  ['导航蓝', 'navy'], ['navy blue', 'navy'], ['navy', 'navy'],
];

const LANGUAGES = [
  ['typescript', 'typescript'], ['javascript', 'javascript'], ['node', 'javascript'], ['js', 'javascript'],
  ['python', 'python'], ['java', 'java'],
  ['c++', 'cpp'], ['c#', 'csharp'], ['c', 'c'],
  ['go', 'go'], ['golang', 'go'], ['rust', 'rust'], ['ruby', 'ruby'], ['php', 'php'],
  ['swift', 'swift'], ['kotlin', 'kotlin'], ['scala', 'scala'], ['haskell', 'haskell'],
  ['lua', 'lua'], ['perl', 'perl'], ['matlab', 'matlab'], ['sql', 'sql'],
  ['bash', 'shell'], ['shell', 'shell'], ['dart', 'dart'], ['elixir', 'elixir'],
  ['clojure', 'clojure'], ['julia', 'julia'], ['fortran', 'fortran'], ['zig', 'zig'],
];

function lookup(table, answer) {
  const text = answer.toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim();
  const exact = table.find(([alias]) => text === alias);
  if (exact) return exact[1];
  // Longest alias first, so 'navy blue' reads as navy rather than as blue, and
  // 'javascript' as JavaScript rather than as Java.
  const sorted = [...table].sort((a, b) => b[0].length - a[0].length);
  // Latin aliases need word boundaries so 'clojure' is not read as C and
  // 'javascript' is not read as Java. CJK aliases have no word boundaries at all,
  // so a plain substring is the only thing that matches '蓝色' against '蓝'.
  const found = sorted.find(([alias]) => (/\p{Script=Han}/u.test(alias)
    ? text.includes(alias)
    : new RegExp(`(^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'u').test(text)));
  return found ? found[1] : null;
}

export function canonicalAnswer(id, reply) {
  const answer = plainAnswer(reply).toLowerCase();
  if (!answer) return '';
  if (id === 'pick-number') {
    const number = answer.match(/-?\d+/);
    return number ? String(Number(number[0])) : answer;
  }
  if (id === 'pick-letter') {
    // 'Letter: q' must read as Q, not as L — a standalone single letter wins over
    // the first letter that happens to appear in the sentence.
    const tokens = answer.match(/[a-z]/gi) || [];
    const standalone = answer.split(/[^\p{L}]+/u).find((word) => word.length === 1);
    const letter = standalone || tokens[0];
    return letter ? letter.toUpperCase() : answer;
  }
  if (id === 'pick-colour') return lookup(COLOURS, answer) || answer;
  if (id === 'pick-lang') return lookup(LANGUAGES, answer) || answer;
  return answer;
}

export function behaviorCheck(id, reply) {
  const answer = plainAnswer(reply);
  if (id === 'exact') return answer === 'DSH_FP_OK';
  if (id === 'reasoning') return /^(?:657|657\.0)$/.test(answer);
  if (id === 'noise') return answer === 'N7Q9-X2M4';
  if (id === 'language') return answer === '模型指纹测试通过';
  if (id === 'code') {
    // An arrow function or a binding is still a function named square; only the
    // old /function square\(/ pattern rejected perfectly good answers.
    const definesSquare = /function\s+square\s*\(/.test(answer) || /(?:const|let|var)\s+square\s*=/.test(answer);
    const returnsProduct = /n\s*\*\s*n/.test(answer) || /n\s*\*\*\s*2/.test(answer) || /Math\.pow\(\s*n\s*,\s*2\s*\)/.test(answer);
    return definesSquare && returnsProduct;
  }
  if (id === 'json') {
    try {
      const value = JSON.parse(answer);
      return value.alpha === 17 && JSON.stringify(value.beta) === '["x","y"]';
    } catch { return false; }
  }
  return answer.length > 0;
}

export function parseNumbers(text, { min = STAT.min, max = STAT.max, limit = STAT.numbers } = {}) {
  const normalized = String(text || '')
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 65248))
    .replace(/[，、；;]/g, ',');
  const values = [];
  for (const match of normalized.matchAll(/-?\d+/g)) {
    const value = Number(match[0]);
    if (Number.isFinite(value) && value >= min && value <= max) {
      values.push(value);
      if (values.length >= limit) break;
    }
  }
  return values;
}

export function histogramOf(values, { min = STAT.min, max = STAT.max, bins = STAT.bins } = {}) {
  const counts = new Array(bins).fill(0);
  const span = (max - min + 1) / bins;
  for (const value of values) {
    let index = Math.floor((value - min) / span);
    if (index < 0) index = 0;
    if (index >= bins) index = bins - 1;
    counts[index] += 1;
  }
  const total = values.length || 1;
  return counts.map((count) => Number((count / total).toFixed(6)));
}

export function entropyOf(histogram) {
  return -histogram.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
}

// Jensen-Shannon divergence in bits. Bounded by 1, symmetric, and defined for
// zero-probability bins, which the resampled histograms below produce constantly.
export function jsd(p, q) {
  const H = (x) => -x.reduce((sum, v) => sum + (v > 0 ? v * Math.log2(v) : 0), 0);
  const m = p.map((v, i) => (v + (q[i] ?? 0)) / 2);
  return Math.max(0, H(m) - (H(p) + H(q)) / 2);
}

// A fixed drift threshold cannot work: it depends on bin count and sample size,
// and it silently becomes either trivial or unreachable. Resampling the current
// histogram gives the noise floor this run actually has, so the threshold moves
// with the measurement instead of being guessed once.
export function bootstrapNoise(histogram, samples, { iterations = 200, random = Math.random } = {}) {
  const bins = histogram.length;
  const cdf = [];
  let total = 0;
  for (const p of histogram) { total += p; cdf.push(total); }
  const draw = () => {
    const counts = new Array(bins).fill(0);
    for (let i = 0; i < samples; i += 1) {
      const r = random() * total;
      let index = 0;
      while (index < bins - 1 && cdf[index] < r) index += 1;
      counts[index] += 1;
    }
    return counts.map((count) => count / samples);
  };
  const values = [];
  for (let i = 0; i < iterations; i += 1) values.push(jsd(draw(), draw()));
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? 0;
}

export function driftThreshold(noise) {
  return Number(Math.max(0.02, noise * 3).toFixed(4));
}

export function buildSignature(values, { bins = STAT.bins, noise: givenNoise } = {}) {
  const histogram = histogramOf(values, { bins });
  const noise = typeof givenNoise === 'number' ? givenNoise : bootstrapNoise(histogram, values.length);
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const hot = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 3)
    .map(([number, count]) => ({ number, count }));
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const variance = values.length ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length : 0;
  return {
    samples: values.length,
    bins,
    histogram,
    entropy: Number(entropyOf(histogram).toFixed(4)),
    distinct: counts.size,
    mean: Number(mean.toFixed(2)),
    stdDev: Number(Math.sqrt(variance).toFixed(2)),
    hot,
    noise: Number(noise.toFixed(4)),
    threshold: driftThreshold(noise),
  };
}

export function compareSignature(current, baseline) {
  const noise = Math.max(current.noise || 0, baseline.noise || 0);
  const distance = jsd(current.histogram, baseline.histogram);
  const threshold = driftThreshold(noise);
  return {
    jsd: Number(distance.toFixed(4)),
    noise: Number(noise.toFixed(4)),
    threshold,
    verdict: distance > threshold ? 'drift' : 'stable',
  };
}

export function mergeBaseline(previous, current) {
  if (!previous?.histogram?.length) {
    return { ...current, runs: 1, updatedAt: new Date().toISOString() };
  }
  const runs = previous.runs || 1;
  const weight = Math.max(0.08, 1 / (runs + 1));
  const mixed = current.histogram.map((p, i) => (previous.histogram[i] ?? 0) * (1 - weight) + p * weight);
  const total = mixed.reduce((sum, value) => sum + value, 0) || 1;
  const histogram = mixed.map((value) => Number((value / total).toFixed(6)));
  return {
    histogram,
    entropy: Number(entropyOf(histogram).toFixed(4)),
    distinct: Math.round(previous.distinct * (1 - weight) + current.distinct * weight),
    mean: Number((previous.mean * (1 - weight) + current.mean * weight).toFixed(2)),
    stdDev: Number((previous.stdDev * (1 - weight) + current.stdDev * weight).toFixed(2)),
    noise: Number((previous.noise * (1 - weight) + current.noise * weight).toFixed(4)),
    samples: (previous.samples || 0) + current.samples,
    runs: runs + 1,
    updatedAt: new Date().toISOString(),
  };
}

const BASELINE_FILE = join(homedir(), '.dsh', 'dsh-model-probe', 'fingerprint-baseline.json');
const MAX_BASELINE_MODELS = 200;

export function baselinePath() {
  return BASELINE_FILE;
}

// Every save is a read-modify-write of the whole baseline file, and the panel can
// fingerprint several rows at once. The queue therefore has to live outside the
// store object: `fileStore()` is constructed per call, so a per-instance chain
// would serialise nothing at all. Keyed by path, since tests use temp files.
const FILE_QUEUES = new Map();

function fileQueue(file) {
  if (!FILE_QUEUES.has(file)) FILE_QUEUES.set(file, Promise.resolve());
  return FILE_QUEUES.get(file);
}

export function fileStore(file = BASELINE_FILE) {
  return {
    async load(key) {
      await fileQueue(file).catch(() => {});
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        return parsed?.models?.[key] ?? null;
      } catch { return null; }
    },
    async loadAll() {
      await fileQueue(file).catch(() => {});
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        return parsed?.models ?? {};
      } catch { return {}; }
    },
    save(key, record) {
      const write = fileQueue(file).then(async () => {
        let data = { version: 1, models: {} };
        try {
          const parsed = JSON.parse(await readFile(file, 'utf8'));
          if (parsed?.models) data = parsed;
        } catch { /* first write */ }
        data.version = 1;
        data.models[key] = record;
        const keys = Object.keys(data.models);
        if (keys.length > MAX_BASELINE_MODELS) {
          keys.sort((a, b) => String(data.models[a].updatedAt).localeCompare(String(data.models[b].updatedAt)));
          for (const stale of keys.slice(0, keys.length - MAX_BASELINE_MODELS)) delete data.models[stale];
        }
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
        await rename(temp, file);
      });
      // The chain must keep going even when one write fails, or a single EACCES
      // would wedge every later save.
      FILE_QUEUES.set(file, write.catch(() => {}));
      return write;
    },
  };
}

export function memoryStore(seed = {}) {
  const models = new Map(Object.entries(seed));
  return {
    async load(key) { return models.get(key) ?? null; },
    async save(key, record) { models.set(key, record); },
    async loadAll() { return Object.fromEntries(models); },
    dump() { return Object.fromEntries(models); },
  };
}

async function streamOnce(llm, route, { prompt, maxTokens, signal, timeoutMs, temperature }) {
  const started = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new Error('测试已停止'));
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('单次探针超时')), timeoutMs);
  let reply = '';
  let reasoning = '';
  let firstTokenMs;
  let usage;
  let finishKind;
  let failure;
  try {
    const stream = llm.stream({
      ...route,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      ...(typeof temperature === 'number' ? { temperature } : {}),
      signal: controller.signal,
    });
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
    if (!COMPLETED.has(finishKind)) throw new Error(`流未正常结束（${finishKind || '无 finish'}）`);
    return { reply, reasoning, firstTokenMs, usage, elapsedMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function collectBehavior(llm, route, probe, signal, timeoutMs) {
  const budget = Math.max(timeoutMs, Number(probe.timeoutMs) || 0);
  const sample = await streamOnce(llm, route, { prompt: probe.prompt, maxTokens: probe.maxTokens, signal, timeoutMs: budget });
  return {
    id: probe.id,
    ok: true,
    passed: behaviorCheck(probe.id, sample.reply),
    prompt: probe.prompt,
    reply: sample.reply.slice(0, 1600),
    reasoning: sample.reasoning.slice(0, 400),
    elapsedMs: sample.elapsedMs,
    firstTokenMs: sample.firstTokenMs,
    usage: sample.usage,
  };
}

async function collectDeterministic(llm, route, probe, signal, timeoutMs, repeat = 1) {
  const replies = [];
  let elapsed = 0;
  let usage;
  for (let index = 0; index < repeat; index += 1) {
    const sample = await streamOnce(llm, route, { prompt: probe.prompt, maxTokens: probe.maxTokens, signal, timeoutMs, temperature: 0 });
    replies.push(plainAnswer(sample.reply));
    elapsed += sample.elapsedMs;
    usage = sample.usage || usage;
  }
  return {
    id: probe.id,
    ok: replies.every((reply) => reply.length > 0),
    prompt: probe.prompt,
    replies,
    // Stability is judged on the canonical form for the same reason the digest is:
    // a backend that writes 'Blue' one run and '蓝色' the next has not changed.
    stable: replies.length > 1
      ? replies.every((reply) => canonicalAnswer(probe.id, reply) === canonicalAnswer(probe.id, replies[0]))
      : null,
    reply: replies[0]?.slice(0, 400) || '',
    elapsedMs: elapsed,
    usage,
  };
}

// Read the tokenizer offset for one probe by pairing each body count with the
// baseline count taken immediately before it.
//
// The baseline (`a`) cancels the serving template, so it has to come from the
// same host as the body count. A shared baseline measured once per run looked
// cheaper, but it is wrong on a load-balanced route: one live route answered the
// body prompt with 80 tokens both times while its baseline came back as 31 and
// then 21 from two different backends, turning a real match (49) into a bogus
// unknown (59). Pairing makes both numbers come from whichever backend answered
// that moment, and requiring two pairs to agree means a stray call on another
// backend only costs one more attempt instead of corrupting the vector.
async function stablePair(call, text, signal, attempts = 3) {
  const pairs = [];
  let lastFailure = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let base;
    let body;
    try {
      const baseSample = await call(TOKENIZER_BASELINE);
      base = Number(baseSample.usage?.inputTokens);
      if (!Number.isFinite(base) || base <= 0) {
        lastFailure = { code: 'USAGE_NOT_REPORTED', message: '该端点不回报输入 Token 数，读不到分词器指纹' };
        continue;
      }
      const bodySample = await call(text);
      body = Number(bodySample.usage?.inputTokens);
      if (!Number.isFinite(body) || body <= 0) {
        lastFailure = { code: 'USAGE_NOT_REPORTED', message: '该端点不回报输入 Token 数，读不到分词器指纹' };
        continue;
      }
    } catch (error) {
      lastFailure = { code: error?.code || (signal.aborted ? 'ABORTED' : 'PROBE_ERROR'), message: redact(textOf(error)) };
      if (signal.aborted) break;
      continue;
    }
    const diff = body - base;
    pairs.push({ diff, base, body });
    if (pairs.filter((pair) => pair.diff === diff).length >= 2) {
      return { ok: true, diff, base, body, attempts: attempt + 1 };
    }
  }
  return { ok: false, attempts: pairs.length, pairs, failure: lastFailure };
}

async function collectTokenizer(llm, route, probe, signal, timeoutMs) {
  const bytes = Buffer.byteLength(probe.text, 'utf8');
  const call = (text) => streamOnce(llm, route, { prompt: text, maxTokens: 16, signal, timeoutMs });
  const pair = await stablePair(call, probe.text, signal);
  if (!pair.ok) {
    return {
      id: probe.id, ok: false, value: null, stable: false,
      ...(pair.failure || {
        code: 'UNSTABLE_ROUTING',
        message: `重复 ${pair.attempts} 次配对没有得到一致的差值，路由在多个后端之间轮换`,
      }),
    };
  }
  const value = pair.diff;
  if (value < 0 || value > bytes) {
    return {
      id: probe.id, ok: false, value: null, raw: pair.body, baseline: pair.base, stable: false,
      code: 'IMPLAUSIBLE_COUNT',
      message: `差值 ${value} 落在 0–${bytes} 之外，这次计数与基线来自不同后端`,
    };
  }
  return { id: probe.id, ok: true, value, raw: pair.body, baseline: pair.base, stable: true, attempts: pair.attempts * 2 };
}

async function collectDistribution(llm, route, index, signal, timeoutMs) {
  const prompt = distributionPrompt(index);
  const sample = await streamOnce(llm, route, { prompt, maxTokens: 8192, signal, timeoutMs });
  const values = parseNumbers(sample.reply);
  const cached = Number(sample.usage?.cacheReadTokens) > 0;
  const empty = values.length === 0;
  return {
    index,
    ok: !empty,
    values,
    count: values.length,
    usable: values.length >= STAT.numbers * 0.5,
    cached,
    prompt,
    reply: sample.reply.slice(0, 600),
    elapsedMs: sample.elapsedMs,
    firstTokenMs: sample.firstTokenMs,
    usage: sample.usage,
    ...empty ? { code: 'EMPTY_SAMPLE', message: '模型没有返回可解析的数字列表（思考可能占满了配额）' } : {},
  };
}

// Runs `worker` over `items` with at most `limit` calls in flight. Probes are
// independent, and a fingerprint used to spend most of its wall clock waiting on
// one slow route after another; the cap keeps a single cheap model from opening
// twenty sockets at the relay at once.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function fingerprintModel(llm, input, signal = new AbortController().signal, store = fileStore()) {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!provider || !model) throw new Error('provider 和 model 不能为空');
  const route = { provider, model };
  const startedAt = Date.now();
  const started = performance.now();
  const totalTimeoutMs = Math.max(60000, Math.min(900000, Number(input.timeoutMs) || 420000));
  const perProbeTimeoutMs = Math.max(5000, Math.min(90000, Number(input.perProbeTimeoutMs) || 45000));
  const samples = Math.max(1, Math.min(5, Number(input.samples) || STAT.samples));
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new Error('测试已停止'));
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('模型指纹检测超时')), totalTimeoutMs);
  const probes = [];
  const runs = [];
  const deterministic = [];
  const tokenizers = [];
  // Two repeats by default: an identity digest means nothing if the backend
  // cannot reproduce its own answer, and a single sample cannot tell. Four extra
  // short calls are cheap next to the seven behavioral probes already in flight.
  const repeats = Math.max(1, Math.min(3, Number(input.repeats) || 2));
  // Fast mode is the default because the slow parts were never the parts that
  // answer "is this really the model it claims to be". Measured on one route:
  // behavior probes 53 s, identity probes 98 s, tokenizer probes 87 s, sampling
  // 65 s. The behavioral checks score identically for a real model and for a
  // relayed one (both 6/6), and the sampling distribution is uniform for every
  // model, so neither can tell two endpoints apart. Identity and tokenizer
  // together are the whole signal; `mode: 'full'` adds the rest back for anyone
  // who wants the availability numbers.
  const mode = input.mode === 'full' ? 'full' : 'fast';
  const behaviorProbes = mode === 'full' ? BEHAVIOR_PROBES : [];
  const sampleCount = mode === 'full' ? samples : 0;
  const concurrency = Math.max(1, Math.min(4, Number(input.concurrency) || 3));
  try {
    const [behaviorResults, deterministicResults, tokenizerResults, runResults] = await Promise.all([
      runPool(behaviorProbes, Math.min(concurrency, 2), async (probe) => {
        try { return await collectBehavior(llm, route, probe, controller.signal, perProbeTimeoutMs); }
        catch (error) {
          return { id: probe.id, ok: false, passed: false, prompt: probe.prompt, code: error?.code || (controller.signal.aborted ? 'ABORTED' : 'PROBE_ERROR'), message: redact(textOf(error)) };
        }
      }),
      runPool(DETERMINISTIC_PROBES, concurrency, async (probe) => {
        try { return await collectDeterministic(llm, route, probe, controller.signal, perProbeTimeoutMs, repeats); }
        catch (error) {
          return { id: probe.id, ok: false, replies: [], reply: '', code: error?.code || (controller.signal.aborted ? 'ABORTED' : 'PROBE_ERROR'), message: redact(textOf(error)) };
        }
      }),
      runPool(TOKENIZER_PROBES, Math.min(concurrency, 2), async (probe) => {
        try { return await collectTokenizer(llm, route, probe, controller.signal, perProbeTimeoutMs); }
        catch (error) {
          return { id: probe.id, ok: false, value: null, code: error?.code || (controller.signal.aborted ? 'ABORTED' : 'PROBE_ERROR'), message: redact(textOf(error)) };
        }
      }),
      runPool(Array.from({ length: sampleCount }, (_, index) => index + 1), Math.min(concurrency, 2), async (index) => {
        try { return await collectDistribution(llm, route, index, controller.signal, perProbeTimeoutMs); }
        catch (error) {
          return { index, ok: false, values: [], count: 0, usable: false, code: error?.code || (controller.signal.aborted ? 'ABORTED' : 'PROBE_ERROR'), message: redact(textOf(error)) };
        }
      }),
    ]);
    probes.push(...behaviorResults);
    deterministic.push(...deterministicResults);
    tokenizers.push(...tokenizerResults);
    runs.push(...runResults);
    const elapsedMs = Math.round(performance.now() - started);
    const hasSignal = probes.some((probe) => probe.ok) || deterministic.some((probe) => probe.ok) || tokenizers.some((probe) => probe.ok);
    if (controller.signal.aborted) return { ok: false, type: 'fingerprint', provider, model, startedAt, elapsedMs, code: 'ABORTED', message: redact(textOf(controller.signal.reason)), probes, runs };
    if (!hasSignal) return { ok: false, type: 'fingerprint', provider, model, startedAt, elapsedMs, code: 'FINGERPRINT_FAILED', message: '所有指纹探针均失败', probes, runs };

    const completed = probes.filter((probe) => probe.ok);
    // Fast mode runs no behavioral probes, so the behavioral score is absent
    // rather than zero — "0/6" would read as a failing model when nothing ran.
    const behavioral = BEHAVIOR_PROBES.filter((probe) => probe.id !== 'identity');
    const checks = behaviorProbes.length
      ? Object.fromEntries(behavioral.map((probe) => [probe.id, probes.find((item) => item.id === probe.id)?.passed === true]))
      : null;
    const passed = checks ? Object.values(checks).filter(Boolean).length : null;
    // Latency is reported over every call that actually ran, not just the
    // behavioral ones: in fast mode the latter is an empty set.
    const timed = [...probes, ...deterministic, ...tokenizers, ...runs]
      .filter((probe) => probe.ok && Number.isFinite(probe.elapsedMs));
    const latencies = timed.map((probe) => probe.elapsedMs).sort((a, b) => a - b);
    const firstTokenLatencies = timed.map((probe) => probe.firstTokenMs).filter((value) => Number.isFinite(value));
    const latencyMs = latencies.length ? {
      mean: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      median: latencies[Math.floor(latencies.length / 2)],
      p95: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)],
      min: latencies[0], max: latencies[latencies.length - 1],
      ttftMean: firstTokenLatencies.length ? Math.round(firstTokenLatencies.reduce((sum, value) => sum + value, 0) / firstTokenLatencies.length) : null,
    } : null;
    // Only the behavioral replies, otherwise the tokenizer probes — which answer
    // with a token count and no text — drag the byte average toward zero.
    const answerLengths = completed.map((probe) => Buffer.byteLength(plainAnswer(probe.reply || ''), 'utf8'));
    // A full run in which every behavioral probe failed has nothing to average;
    // dividing by zero here would emit NaN, which JSON turns into null anyway.
    const features = checks && completed.length ? {
      checks,
      completionRate: Number((completed.length / behaviorProbes.length).toFixed(3)),
      meanAnswerBytes: Math.round(answerLengths.reduce((sum, value) => sum + value, 0) / answerLengths.length),
      markdownRate: Number((completed.filter((probe) => /```/.test(probe.reply)).length / completed.length).toFixed(3)),
      meanOutputTokens: Math.round(completed.reduce((sum, probe) => sum + (Number(probe.usage?.outputTokens) || 0), 0) / completed.length),
    } : null;
    const reportedModel = plainAnswer(probes.find((probe) => probe.id === 'identity')?.reply).slice(0, 160);
    const normalizedClaim = model.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedReport = reportedModel.toLowerCase().replace(/[^a-z0-9]/g, '');
    const claimedModelHintMatch = normalizedReport ? normalizedReport.includes(normalizedClaim) || normalizedClaim.includes(normalizedReport) : null;

    // The behavioral digest must stay stable across runs or it cannot be compared
    // to anything. Latency and token counts used to leak into it, which made the
    // fingerprint different on every run of the same model. The self-reported name
    // is excluded too: routing layers answer that probe with a random guess
    // (`gpt-5`, `gpt-5.5`, `o3` from the same route), and it never scored anything.
    // Whitespace is normalised because the same correct answer comes back one-
    // lined or multi-lined at random, which is formatting, not behaviour.
    const answerDigest = probes
      .filter((probe) => probe.ok && probe.id !== 'identity')
      .map((probe) => `${probe.id}:${plainAnswer(probe.reply).replace(/\s+/g, '')}`)
      .join('\n');
    const responseDigest = createHash('sha256').update(answerDigest).digest('hex');

    // The identity signal: greedy decoding makes these replies a pure function of
    // the weights, so two different models rarely collide while the same model
    // reproduces itself. Whitespace and case are normalised for the same reason as
    // above — `Blue` and `blue` are the same answer, and a route that flips their
    // case between runs must not look like a model swap.
    //
    // Probes that failed to reproduce their own answer inside one run are dropped
    // before hashing. A load-balanced route that alternates between backends will
    // flip a preference answer (`A` one run, `Q` the next); hashing that answer
    // would make the digest itself jitter and every run would look like a swap.
    // The dropped ids are kept so a reader can see why coverage dropped.
    const reproducible = deterministic.filter((probe) => probe.ok && probe.stable !== false);
    const unstable = deterministic.filter((probe) => probe.stable === false).map((probe) => probe.id);
    const stableAnswers = Object.fromEntries(reproducible.map((probe) => [probe.id, canonicalAnswer(probe.id, probe.reply)]));
    const digestOf = (answers) => createHash('sha256')
      .update(Object.keys(answers).sort().map((id) => `${id}:${answers[id]}`).join('\n'))
      .digest('hex');
    // The digest is only a display handle for one run: a route whose answer set
    // changes from run to run produces a different digest every time even when no
    // single answer changed. Drift is therefore decided per probe, over the
    // answers both runs actually produced.
    const identityDigest = reproducible.length >= 2 ? digestOf(stableAnswers) : null;
    const identityCoverage = deterministic.length ? reproducible.length / deterministic.length : 0;

    const usableRuns = runs.filter((run) => run.usable);
    const usableValues = usableRuns.flatMap((run) => run.values);
    const signature = usableValues.length >= STAT.numbers ? buildSignature(usableValues) : null;
    if (signature) signature.runs = usableRuns.length;
    let drift = null;
    let baselineInfo = null;
    if (signature) {
      const key = `${provider}\u0000${model}`;
      try {
        const previous = await store.load(key);
        drift = previous ? compareSignature(signature, previous) : { jsd: null, noise: signature.noise, threshold: signature.threshold, verdict: 'baseline-created' };
        const merged = mergeBaseline(previous, signature);
        baselineInfo = { runs: merged.runs, samples: merged.samples, updatedAt: merged.updatedAt, stored: true };
        await store.save(key, merged).catch(() => { baselineInfo.stored = false; });
      } catch {
        baselineInfo = null;
      }
    }

    const cachedRuns = runs.filter((run) => run.cached).length;

    // Identity drift lives in its own baseline slot: each probe answer is either
    // the recorded one or it is not, so there is no noise floor to calibrate.
    // Comparison is per probe over the answers both runs produced, not over the
    // digests: a route that drops one probe this run (a timeout, or a probe that
    // failed to repeat itself) would otherwise build a different digest from the
    // very same backend and look like a swap.
    let identity = null;
    if (identityDigest) {
      const key = `${provider}\u0000${model}\u0000identity`;
      // The probe set is the frozen list, not the subset that happened to answer
      // this run: a probe that timed out once must not renumber the baseline.
      const probeSet = `v${IDENTITY_VERSION}:${DETERMINISTIC_PROBES.map((probe) => probe.id).sort().join(',')}`;
      let recorded = null;
      try { recorded = await store.load(key); } catch { recorded = null; }
      const recordedAnswers = recorded?.probeSet === probeSet && recorded.answers && typeof recorded.answers === 'object'
        ? recorded.answers
        : null;
      const shared = recordedAnswers ? Object.keys(stableAnswers).filter((id) => id in recordedAnswers) : [];
      const rawChanged = recordedAnswers ? shared.filter((id) => recordedAnswers[id] !== stableAnswers[id]) : [];
      // Two or more answers moving at once is what a real backend swap looks like:
      // measured on a live route, every probe changes together the moment the
      // request lands on a different host. A single answer moving on its own is
      // the opposite — evidence that the probe itself is unstable, not that the
      // model changed. Live case: `pick-letter` on tk/deepseek-v4.1-flash-1017
      // returned K and then Q while the other three probes never moved; reporting
      // that as "identity changed" is the loudest false alarm the panel can show.
      const swapped = rawChanged.length >= 2;
      const volatile = { ...(recorded?.volatile && typeof recorded.volatile === 'object' ? recorded.volatile : {}) };
      if (!swapped) {
        // Remember the second answer for any probe that has now given two, so it
        // is dropped from the comparison on every later run instead of being
        // reported again and again.
        for (const id of rawChanged) {
          const seen = Array.isArray(volatile[id]) ? volatile[id] : [recordedAnswers[id]];
          if (!seen.includes(stableAnswers[id])) seen.push(stableAnswers[id]);
          volatile[id] = seen.slice(-6);
        }
      }
      const fluctuating = Object.keys(volatile).filter((id) => Array.isArray(volatile[id]) && volatile[id].length > 1);
      const settled = Object.fromEntries(Object.entries(stableAnswers).filter(([id]) => !fluctuating.includes(id)));
      const compared = Object.keys(settled).filter((id) => id in (recordedAnswers || {}));
      const changedProbes = swapped ? rawChanged : [];
      const comparable = compared.length > 0;
      const verdict = !comparable ? 'baseline-created' : swapped ? 'drift' : 'stable';

      // Cross-model comparison. A fresh install has no history for any model, so
      // judging a model only against its own past would leave every first run
      // saying "baseline created" — useless for the actual question, which is
      // whether two rows are the same backend. Two models are paired when they
      // agree on every probe they have in common, and only when that overlap is
      // most of the probe set. A count threshold alone is not enough: `42` and
      // `Python` are such common preferences that two unrelated models sharing
      // just those two would be paired, and a false "same backend" claim is the
      // expensive mistake.
      const minPeersOverlap = Math.max(2, Math.ceil(DETERMINISTIC_PROBES.length * 0.75));
      let peers = [];
      try {
        const all = (await store.loadAll?.()) || {};
        const self = `${provider}\u0000${model}\u0000identity`;
        for (const [otherKey, other] of Object.entries(all)) {
          if (otherKey === self || !other?.answers) continue;
          if (other.probeSet !== probeSet) continue;
          const otherAnswers = other.answers;
          // Compare only the probes that have held still on this row: a probe that
          // answers differently run to run cannot make two rows the same backend.
          const common = Object.keys(settled).filter((id) => id in otherAnswers);
          if (common.length < minPeersOverlap) continue;
          if (common.some((id) => otherAnswers[id] !== settled[id])) continue;
          const [otherProvider, otherModel] = otherKey.split('\u0000');
          peers.push({ provider: otherProvider, model: otherModel });
        }
      } catch { peers = []; }

      identity = {
        digest: identityDigest,
        probeSet,
        probeIds: Object.keys(stableAnswers).sort().join(','),
        coverage: Number(identityCoverage.toFixed(3)),
        probes: reproducible.length,
        repeats,
        unstable,
        verdict,
        peers,
        changedProbes,
        comparedProbes: compared.length,
        fluctuating,
        reference: comparable ? String(recorded.digest).slice(0, 12) : null,
        runs: comparable ? (recorded.runs || 0) + 1 : 1,
        // When this row's baseline was first recorded, not when it last ran.
        firstSeen: comparable ? (recorded.firstSeen || recorded.updatedAt || null) : null,
      };
      try {
        // Answers already on record are never overwritten while they hold still:
        // once recorded, every later run is judged against it, so a rotated model
        // stays visible instead of being absorbed into a moving average. A probe
        // that has since answered more than one way is the exception — it can no
        // longer serve as a baseline, so its stored answer follows the latest run
        // and the probe is dropped from the comparison anyway.
        const merged = { ...(recordedAnswers || {}) };
        for (const [id, answer] of Object.entries(stableAnswers)) {
          if (!(id in merged) || fluctuating.includes(id)) merged[id] = answer;
        }
        // `updatedAt` always moves: the file store evicts the oldest 200 entries by
        // this field, so freezing it on stable rows would evict the models that are
        // probed most often and kept the ones that were tested once and abandoned.
        // The moment the baseline was first created is kept separately.
        const now = new Date().toISOString();
        await store.save(key, {
          digest: comparable ? recorded.digest : identityDigest,
          probeSet,
          answers: merged,
          volatile,
          runs: identity.runs,
          firstSeen: comparable ? (recorded.firstSeen || recorded.updatedAt || now) : now,
          updatedAt: now,
        });
      } catch { /* a read-only home must not fail the test */ }
    }

    // The tokenizer vector is the only signal here that does not depend on the
    // model cooperating: the count comes from the vendor's vocabulary files, so a
    // relay that forwards text without the matching tokenizer cannot reproduce it.
    // It identifies a family, never one model, and it reports "no reference
    // match" rather than guessing when the vector is not in the table.
    const tokenizerValues = Object.fromEntries(tokenizers.map((probe) => [probe.id, probe.value ?? null]));
    const tokenizer = {
      ...tokenizerVerdict(model, tokenizerValues),
      version: TOKENIZER_VERSION,
      probes: tokenizers,
    };

    // One digest for "which endpoint answered", built from the two signals that
    // actually identify a model: the greedy answers and the tokenizer vector.
    // Behavioral checks are only included in full mode — they are identical for a
    // real model and a relayed one, so folding them in changed the hash without
    // adding information.
    const fingerprint = createHash('sha256').update(JSON.stringify({
      answers: digestOf(stableAnswers),
      tokenizer: TOKENIZER_IDS.map((id) => tokenizerValues[id] ?? null),
      checks: checks || null,
    })).digest('hex');

    return {
      ok: true, type: 'fingerprint', provider, model, startedAt, elapsedMs, fingerprint, responseDigest,
      mode, identity, deterministic, tokenizer,
      score: checks ? Math.round(100 * passed / behavioral.length) : null,
      passed, totalChecks: checks ? behavioral.length : null,
      confidence: checks ? Math.round(100 * completed.length / behaviorProbes.length) : null,
      completed: checks ? completed.length : null, totalProbes: checks ? behaviorProbes.length : null,
      partial: checks ? completed.length < behaviorProbes.length : null,
      reportedModel, claimedModelHintMatch, latencyMs, features,
      signature,
      drift,
      baseline: baselineInfo,
      cacheWarning: cachedRuns > 0 ? `${cachedRuns}/${runs.length} 次采样命中上游缓存，分布可能失真` : null,
      probes, runs,
      request: {
        provider, model, probeCount: BEHAVIOR_PROBES.length, probeIds: BEHAVIOR_PROBES.map((probe) => probe.id),
        samples, numbersPerSample: STAT.numbers, range: [STAT.min, STAT.max], bins: STAT.bins, stream: true,
        deterministicRepeats: repeats, deterministicProbeIds: DETERMINISTIC_PROBES.map((probe) => probe.id),
        tokenizerProbeIds: TOKENIZER_PROBES.map((probe) => probe.id), tokenizerVersion: TOKENIZER_VERSION,
      },
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
