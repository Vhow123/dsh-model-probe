import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  behaviorCheck, parseNumbers, histogramOf, entropyOf, jsd, bootstrapNoise,
  driftThreshold, buildSignature, compareSignature, mergeBaseline, memoryStore,
  fingerprintModel, distributionPrompt, BEHAVIOR_PROBES, canonicalAnswer, TOKENIZER_PROBES,
  fileStore,
} from '../fingerprint.js';

// Raw prompt-token counts a real endpoint reported for the four pinned strings,
// measured on tk/deepseek-v4.1-flash with a one-character baseline of 31. The
// differences are 49/53/62/83, the row the reference table files under deepseek.
const DEEPSEEK_RAW = [80, 84, 93, 114];
const BASELINE_RAW = 31;

// Stands in for an endpoint that only counts prompt tokens: any prompt that is
// not one of the pinned strings or the baseline counts as unknown.
function tokenizerCounter(rawFor) {
  return (prompt, seen) => {
    if (prompt === 'a') return BASELINE_RAW;
    const index = TOKENIZER_PROBES.findIndex((probe) => probe.text === prompt);
    return index < 0 ? undefined : rawFor(index, seen);
  };
}

function numbers(count, value) {
  return Array.from({ length: count }, () => String(value)).join(', ');
}

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function llmWith(stream) {
  return { stream };
}

function sampleStream({ identity = 'model-a', spread = false, code = 'function square(n) { return n * n; }', deterministic = 'canonical', tokenizer = null, letters = null } = {}) {
  // Tokenizer probes read `usage.inputTokens`, so a stand-in has to count each
  // prompt it is handed. Counting per text keeps "the third time this string was
  // sent" available to a test that wants to move one call onto another backend.
  const sends = new Map();
  // A probe that answers consistently inside one run but differently on the next
  // one is the case `letters` covers: with two repeats per run, calls 0-1 belong
  // to the first run, 2-3 to the second, so both calls inside a run agree. The
  // cursor lives outside the stream when the test wants two runs to differ.
  const letterCursor = letters?.cursor || { calls: 0 };
  return async function* (options) {
    const prompt = options.messages[0].content[0].text;
    let inputTokens;
    if (tokenizer) {
      const seen = sends.get(prompt) || 0;
      sends.set(prompt, seen + 1);
      inputTokens = tokenizer(prompt, seen);
    }
    const usage = (extra) => ({ ...extra, ...(Number.isFinite(inputTokens) ? { inputTokens } : {}) });
    if (prompt.startsWith('Run ')) {
      // A biased model always returns the same narrow band; a healthy one is uniform.
      const values = [];
      const random = seeded(7);
      for (let i = 0; i < 200; i += 1) {
        values.push(spread ? Math.floor(random() * 100) + 1 : 40 + Math.floor(random() * 10));
      }
      yield { type: 'text-delta', text: values.join(', ') };
      yield { type: 'usage', usage: usage({ outputTokens: 400 }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    // Greedy probes stand in for the exact bytes a temperature-0 decode returns.
    // Identity probes ask for a preference, so each stand-in model commits to its
    // own favourite; a backend swap changes the answers.
    const other = deterministic === 'other-backend';
    const greedy = prompt.includes('Pick a number') ? (other ? '57' : '42')
      : prompt.includes('Name one colour') ? (other ? 'Green' : 'Blue')
        : prompt.includes('Pick one letter') ? (other ? 'M' : letters ? letters.values[Math.min(letters.values.length - 1, Math.floor(letterCursor.calls++ / 2))] : 'A')
          : prompt.includes('one programming language') ? (other ? 'Go' : 'Python')
            : prompt.includes('strawberry') ? '3'
              : prompt.includes('capital of Australia') ? 'Canberra'
                : prompt.includes('17 + 28') ? '45'
                  : null;
    if (greedy !== null) {
      yield { type: 'text-delta', text: greedy };
      yield { type: 'usage', usage: usage({ outputTokens: 3 }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const answer = prompt.includes('exact model') ? identity
      : prompt.includes('DSH_FP_OK') ? 'DSH_FP_OK'
        : prompt.includes('Calculate') ? '657'
          : prompt.includes('JSON object') ? '{"alpha":17,"beta":["x","y"]}'
            : prompt.includes('N7Q9-X2M4') ? 'N7Q9-X2M4'
              : prompt.includes('JavaScript') ? code
                : '模型指纹测试通过';
    yield { type: 'text-delta', text: answer };
    yield { type: 'usage', usage: usage({ outputTokens: 8 }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
}

test('answers follow the same strict rules the report promises', () => {
  assert.equal(behaviorCheck('exact', 'DSH_FP_OK'), true);
  assert.equal(behaviorCheck('exact', 'DSH_FP_OK.'), false);
  assert.equal(behaviorCheck('reasoning', '657'), true);
  assert.equal(behaviorCheck('reasoning', '657.0'), true);
  assert.equal(behaviorCheck('reasoning', 'The answer is 657'), false);
  assert.equal(behaviorCheck('json', '```json\n{"alpha":17,"beta":["x","y"]}\n```'), true);
  assert.equal(behaviorCheck('json', '{"alpha":17,"beta":["y","x"]}'), false);
  assert.equal(behaviorCheck('code', 'function square(n){return n*n}'), true);
  assert.equal(behaviorCheck('code', 'const square = (n) => n ** 2;'), true);
  assert.equal(behaviorCheck('code', 'let square = function (n) { return Math.pow(n, 2); };'), true);
  assert.equal(behaviorCheck('code', 'function add(a, b) { return a + b; }'), false);
  assert.equal(behaviorCheck('code', 'function square(n) { return n + n; }'), false);
  assert.equal(behaviorCheck('language', '模型指纹测试通过'), true);
  assert.equal(behaviorCheck('language', '模型指纹测试通过了'), false);
});

test('number parsing accepts full-width digits and comma variants inside the range', () => {
  assert.deepEqual(parseNumbers('1，2、3；4'), [1, 2, 3, 4]);
  assert.deepEqual(parseNumbers('１００ ０ ３'), [100, 3]);
  assert.deepEqual(parseNumbers('nan 999 -4 5'), [5]);
  assert.equal(parseNumbers(numbers(300, 7)).length, 200);
});

test('histograms normalise to one and entropy peaks on a uniform distribution', () => {
  const uniform = histogramOf(Array.from({ length: 800 }, (_, i) => (i % 100) + 1));
  assert.equal(uniform.length, 8);
  assert.ok(Math.abs(uniform.reduce((sum, p) => sum + p, 0) - 1) < 1e-6);
  assert.ok(entropyOf(uniform) > 2.9, 'a flat spread should approach log2(8) bits');
  assert.ok(entropyOf(uniform) < 3.01);
  const narrow = histogramOf(Array.from({ length: 800 }, () => 50));
  assert.ok(entropyOf(narrow) < 0.5);
});

test('JSD separates two different distributions by more than the noise of one', () => {
  const uniform = Array.from({ length: 8 }, () => 0.125);
  const biased = [0.4, 0.3, 0.1, 0.1, 0.1, 0, 0, 0];
  const noise = bootstrapNoise(uniform, 600, { iterations: 200, random: seeded(3) });
  assert.ok(noise > 0);
  assert.ok(noise < 0.05, `noise ${noise} should stay small at 600 samples`);
  assert.ok(jsd(uniform, biased) > noise * 3);
  assert.equal(jsd(uniform, uniform), 0);
});

test('the drift threshold tracks the measured noise floor instead of a magic constant', () => {
  assert.equal(driftThreshold(0.001), 0.02);
  assert.equal(driftThreshold(0.01), 0.03);
  assert.equal(driftThreshold(0.05), 0.15);
  const signature = buildSignature(parseNumbers(numbers(400, 50)), { noise: 0.01 });
  assert.equal(signature.threshold, 0.03);
  assert.equal(signature.bins, 8);
});

test('a distribution signature is stable against itself and flags a real shift', () => {
  const random = seeded(11);
  const steady = parseNumbers(Array.from({ length: 600 }, () => Math.floor(random() * 100) + 1).join(', '));
  const shifted = parseNumbers(Array.from({ length: 600 }, () => Math.floor(random() * 40) + 1).join(', '));
  const base = buildSignature(steady);
  const again = buildSignature(steady);
  const moved = buildSignature(shifted);
  assert.equal(compareSignature(again, base).verdict, 'stable');
  assert.equal(compareSignature(moved, base).verdict, 'drift');
  assert.ok(compareSignature(moved, base).jsd > compareSignature(again, base).jsd);
});

test('baseline merging converges instead of restarting from the latest run', () => {
  const first = buildSignature(Array.from({ length: 400 }, () => 20), { noise: 0.01 });
  const merged = mergeBaseline(null, first);
  assert.equal(merged.runs, 1);
  const second = mergeBaseline(merged, buildSignature(Array.from({ length: 400 }, () => 80), { noise: 0.01 }));
  assert.equal(second.runs, 2);
  assert.equal(second.samples, 800);
  assert.ok(second.mean > merged.mean, 'a newer run should still move the baseline');
  assert.ok(second.mean < 80, 'but it must not replace it');
  const key = JSON.stringify(second.histogram);
  const other = mergeBaseline({ ...second, runs: 9 }, buildSignature(Array.from({ length: 400 }, () => 10), { noise: 0.01 }));
  assert.notEqual(JSON.stringify(other.histogram), key, 'a late run must still be able to move the baseline');
  assert.ok(other.mean < second.mean);
});

test('fingerprint combines behavior with a distribution signature and keeps the digest stable', async () => {
  const store = memoryStore();
  const first = await fingerprintModel(llmWith(sampleStream()), { mode: 'full', provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(first.ok, true);
  assert.equal(first.passed, 6);
  assert.equal(first.totalChecks, 6);
  assert.equal(first.signature.samples, 600);
  assert.equal(first.drift.verdict, 'baseline-created');
  assert.equal(first.baseline.runs, 1);
  const second = await fingerprintModel(llmWith(sampleStream()), { mode: 'full', provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(second.fingerprint, first.fingerprint, 'the digest must not depend on latency or token counts');
  assert.equal(second.drift.verdict, 'stable');
  assert.equal(second.baseline.runs, 2);
});

test('a model whose sampling drifts away from its own baseline is reported as drifted', async () => {
  const store = memoryStore();
  await fingerprintModel(llmWith(sampleStream()), { mode: 'full', provider: 'one', model: 'model-a' }, undefined, store);
  const shifted = await fingerprintModel(llmWith(sampleStream({ spread: true })), { mode: 'full', provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(shifted.drift.verdict, 'drift');
  assert.ok(shifted.drift.jsd > shifted.drift.threshold);
});

test('the self-reported name is not part of the behavior score', async () => {
  const store = memoryStore();
  const result = await fingerprintModel(llmWith(sampleStream({ identity: 'totally-different-model' })), { mode: 'full', provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(result.passed, 6);
  assert.equal(result.claimedModelHintMatch, false);
  assert.equal(BEHAVIOR_PROBES.some((probe) => probe.id === 'identity'), true);
  assert.equal(result.features.checks.identity, undefined);
});

test('a model that answers the identity probe differently every run keeps one fingerprint', async () => {
  const store = memoryStore();
  const first = await fingerprintModel(llmWith(sampleStream({ identity: 'gpt-5' })), { mode: 'full', provider: 'one', model: 'model-a' }, undefined, store);
  const second = await fingerprintModel(llmWith(sampleStream({ identity: 'o3' })), { mode: 'full', provider: 'one', model: 'model-a' }, undefined, store);
  assert.notEqual(first.reportedModel, second.reportedModel);
  assert.equal(first.fingerprint, second.fingerprint, 'a guessed name must not change the digest');
  assert.equal(first.responseDigest, second.responseDigest);
});

test('formatting-only differences in a correct answer do not change the digest', async () => {
  const store = memoryStore();
  const oneLine = llmWith(sampleStream({ code: 'function square(n) { return n * n; }' }));
  const multiLine = llmWith(sampleStream({ code: 'function square(n) {\n  return n * n;\n}' }));
  const first = await fingerprintModel(oneLine, { provider: 'one', model: 'model-a' }, undefined, store);
  const second = await fingerprintModel(multiLine, { provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(first.passed, second.passed);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.responseDigest, second.responseDigest);
});

test('sampling prompts ask for a bounded, parseable list', () => {
  assert.match(distributionPrompt(2), /^Run 2\./);
  assert.match(distributionPrompt(2), /200 random integers/);
  assert.match(distributionPrompt(2), /between 1 and 100/);
});

test('a run where every sampling probe fails still reports behavior without a signature', async () => {
  const store = memoryStore();
  const stream = async function* (options) {
    const prompt = options.messages[0].content[0].text;
    if (prompt.startsWith('Run ')) throw new Error('sampling unavailable');
    yield { type: 'text-delta', text: prompt.includes('exact model') ? 'model-a' : prompt.includes('DSH_FP_OK') ? 'DSH_FP_OK' : prompt.includes('Calculate') ? '657' : prompt.includes('JSON object') ? '{"alpha":17,"beta":["x","y"]}' : prompt.includes('N7Q9-X2M4') ? 'N7Q9-X2M4' : prompt.includes('JavaScript') ? 'function square(n){return n*n}' : '模型指纹测试通过' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const result = await fingerprintModel(llmWith(stream), { mode: 'full', provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(result.ok, true);
  assert.equal(result.signature, null);
  assert.equal(result.drift, null);
  assert.equal(result.runs.every((run) => run.ok === false), true);
});

test('cached sampling runs are surfaced as a warning', async () => {
  const store = memoryStore();
  const stream = async function* (options) {
    const prompt = options.messages[0].content[0].text;
    if (prompt.startsWith('Run ')) {
      yield { type: 'text-delta', text: numbers(200, 40) };
      yield { type: 'usage', usage: { outputTokens: 400, cacheReadTokens: 380 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield { type: 'text-delta', text: prompt.includes('exact model') ? 'model-a' : prompt.includes('DSH_FP_OK') ? 'DSH_FP_OK' : prompt.includes('Calculate') ? '657' : prompt.includes('JSON object') ? '{"alpha":17,"beta":["x","y"]}' : prompt.includes('N7Q9-X2M4') ? 'N7Q9-X2M4' : prompt.includes('JavaScript') ? 'function square(n){return n*n}' : '模型指纹测试通过' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const result = await fingerprintModel(llmWith(stream), { mode: 'full', provider: 'one', model: 'model-a' }, undefined, store);
  assert.match(result.cacheWarning, /3\/3/);
});

test('greedy probes give one identity digest that survives repeated runs', async () => {
  const store = memoryStore();
  const first = await fingerprintModel(llmWith(sampleStream()), { provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(first.identity.probes, 4);
  assert.equal(first.identity.coverage, 1);
  assert.equal(first.identity.verdict, 'baseline-created');
  assert.equal(first.deterministic.every((probe) => probe.ok), true);
  const second = await fingerprintModel(llmWith(sampleStream()), { provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(second.identity.digest, first.identity.digest, 'the same backend must reproduce the digest byte for byte');
  assert.equal(second.identity.verdict, 'stable');
  assert.equal(second.identity.reference, first.identity.digest.slice(0, 12));
});

test('a different backend behind the same route is reported as an identity drift', async () => {
  const store = memoryStore();
  const first = await fingerprintModel(llmWith(sampleStream()), { provider: 'one', model: 'model-a' }, undefined, store);
  const rotated = await fingerprintModel(llmWith(sampleStream({ deterministic: 'other-backend' })), { provider: 'one', model: 'model-a' }, undefined, store);
  assert.notEqual(rotated.identity.digest, first.identity.digest);
  assert.equal(rotated.identity.verdict, 'drift');
  assert.equal(rotated.identity.reference, first.identity.digest.slice(0, 12));
  assert.equal(rotated.identity.runs, 2);
});

test('a changed probe set rebuilds the identity baseline instead of reporting drift', async () => {
  const store = memoryStore();
  const stale = `${'one'}\u0000model-a\u0000identity`;
  await store.save(stale, { digest: 'ca1eed1367db0000', probeSet: 'capital,emoji,sum', runs: 4, updatedAt: '2026-01-01T00:00:00.000Z' });
  const result = await fingerprintModel(llmWith(sampleStream()), { provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(result.identity.verdict, 'baseline-created', 'an older probe set must not look like a model swap');
  assert.equal(result.identity.reference, null);
  assert.equal(result.identity.runs, 1);
});

test('repeats flag a backend that cannot reproduce its own greedy answer', async () => {
  let call = 0;
  const stream = async function* (options) {
    const prompt = options.messages[0].content[0].text;
    if (prompt.startsWith('Run ')) {
      yield { type: 'text-delta', text: numbers(200, 40) };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (prompt.includes('Pick a number')) {
      call += 1;
      yield { type: 'text-delta', text: call % 2 ? '42' : '43' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const answer = prompt.includes('exact model') ? 'model-a'
      : prompt.includes('DSH_FP_OK') ? 'DSH_FP_OK'
        : prompt.includes('Calculate') ? '657'
          : prompt.includes('JSON object') ? '{"alpha":17,"beta":["x","y"]}'
            : prompt.includes('N7Q9-X2M4') ? 'N7Q9-X2M4'
              : prompt.includes('JavaScript') ? 'function square(n) { return n * n; }'
                : prompt.includes('Name one colour') ? 'Blue'
                  : prompt.includes('Pick one letter') ? 'A'
                    : prompt.includes('one programming language') ? 'Python'
                      : prompt.includes('capital of Australia') ? 'Canberra'
                        : '45';
    yield { type: 'text-delta', text: answer };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const result = await fingerprintModel(llmWith(stream), { provider: 'one', model: 'model-a', repeats: 2 }, undefined, memoryStore());
  assert.equal(result.identity.repeats, 2);
  assert.deepEqual(result.identity.unstable, ['pick-number']);
  assert.equal(result.deterministic.find((probe) => probe.id === 'pick-number').stable, false);
});

test('answers are folded onto one canonical term before they are compared', () => {
  // The same backend answered 'Blue' through one route and '蓝色' through another;
  // treating that as a model swap would be a false alarm, not a finding.
  assert.equal(canonicalAnswer('pick-colour', 'Blue'), 'blue');
  assert.equal(canonicalAnswer('pick-colour', '蓝色'), 'blue');
  assert.equal(canonicalAnswer('pick-colour', '  Navy blue. '), 'navy');
  assert.equal(canonicalAnswer('pick-lang', 'Go'), 'go');
  assert.equal(canonicalAnswer('pick-lang', 'golang'), 'go');
  assert.equal(canonicalAnswer('pick-lang', 'JavaScript'), 'javascript');
  assert.equal(canonicalAnswer('pick-lang', 'Clojure'), 'clojure');
  assert.equal(canonicalAnswer('pick-number', '42'), '42');
  assert.equal(canonicalAnswer('pick-number', 'The number is 42.'), '42');
  assert.equal(canonicalAnswer('pick-letter', 'g'), 'G');
  assert.equal(canonicalAnswer('pick-letter', 'Letter: q'), 'Q');
});

test('two routes answering one question in two languages share an identity digest', async () => {
  const store = memoryStore();
  const english = async function* (options) {
    const prompt = options.messages[0].content[0].text;
    if (prompt.startsWith('Run ')) {
      yield { type: 'text-delta', text: numbers(200, 40) };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const answer = prompt.includes('Pick a number') ? '42'
      : prompt.includes('Name one colour') ? 'Blue'
        : prompt.includes('Pick one letter') ? 'Q'
          : prompt.includes('one programming language') ? 'Python'
            : prompt.includes('exact model') ? 'model-a'
              : prompt.includes('DSH_FP_OK') ? 'DSH_FP_OK'
                : prompt.includes('Calculate') ? '657'
                  : prompt.includes('JSON object') ? '{"alpha":17,"beta":["x","y"]}'
                    : prompt.includes('N7Q9-X2M4') ? 'N7Q9-X2M4'
                      : prompt.includes('JavaScript') ? 'function square(n){return n*n}'
                        : '模型指纹测试通过';
    yield { type: 'text-delta', text: answer };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const chinese = async function* (options) {
    for await (const chunk of english(options)) {
      yield chunk.type === 'text-delta' && chunk.text === 'Blue'
        ? { ...chunk, text: '蓝色' }
        : chunk;
    }
  };
  const first = await fingerprintModel(llmWith(english), { provider: 'one', model: 'model-a' }, undefined, store);
  const second = await fingerprintModel(llmWith(chinese), { provider: 'two', model: 'model-b' }, undefined, store);
  assert.equal(second.identity.digest, first.identity.digest);
  assert.deepEqual(second.identity.peers, [{ provider: 'one', model: 'model-a' }]);
});

test('a fresh row names the model it shares a backend with', async () => {
  // The complaint this replaces: a newly added row showed 'baseline created' and
  // nothing else, so a plugin installed fresh could never say whether two rows are
  // the same backend. Peers answer that on the very first run of the new row.
  const store = memoryStore();
  const known = await fingerprintModel(llmWith(sampleStream()), { provider: 'one', model: 'model-a' }, undefined, store);
  const added = await fingerprintModel(llmWith(sampleStream()), { provider: 'two', model: 'model-b' }, undefined, store);
  assert.equal(added.identity.verdict, 'baseline-created');
  assert.equal(added.identity.digest, known.identity.digest);
  assert.deepEqual(added.identity.peers, [{ provider: 'one', model: 'model-a' }]);

  // A distinct backend must not inherit those peers.
  const stranger = await fingerprintModel(llmWith(sampleStream({ deterministic: 'other-backend' })), { provider: 'three', model: 'model-c' }, undefined, store);
  assert.deepEqual(stranger.identity.peers, []);

  // A different probe set is not comparable, so it must not claim a peer either.
  await store.save('four\u0000model-d\u0000identity', { digest: known.identity.digest, probeSet: 'pick-colour', runs: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
  const rerun = await fingerprintModel(llmWith(sampleStream()), { provider: 'five', model: 'model-e' }, undefined, store);
  assert.deepEqual(rerun.identity.peers, [{ provider: 'one', model: 'model-a' }, { provider: 'two', model: 'model-b' }]);
});

test('a probe that cannot repeat itself is dropped instead of faking a model swap', async () => {
  // Real case: one tk route answered `pick-letter` with A one run and Q the next
  // while every other probe stayed identical. Hashing the jittering answer made
  // the digest itself wobble, so a healthy route was reported as a swapped
  // backend — and it even paired up with whichever row jittered the same way.
  let letter = 0;
  const stream = async function* (options) {
    const prompt = options.messages[0].content[0].text;
    if (prompt.startsWith('Run ')) {
      yield { type: 'text-delta', text: numbers(200, 40) };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (prompt.includes('Pick one letter')) {
      letter += 1;
      yield { type: 'text-delta', text: letter % 2 ? 'A' : 'Q' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const answer = prompt.includes('Pick a number') ? '42'
      : prompt.includes('Name one colour') ? 'Blue'
        : prompt.includes('one programming language') ? 'Python'
          : prompt.includes('exact model') ? 'model-a'
            : prompt.includes('DSH_FP_OK') ? 'DSH_FP_OK'
              : prompt.includes('Calculate') ? '657'
                : prompt.includes('JSON object') ? '{"alpha":17,"beta":["x","y"]}'
                  : prompt.includes('N7Q9-X2M4') ? 'N7Q9-X2M4'
                    : prompt.includes('JavaScript') ? 'function square(n){return n*n}'
                      : '模型指纹测试通过';
    yield { type: 'text-delta', text: answer };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const store = memoryStore();
  const first = await fingerprintModel(llmWith(stream), { provider: 'one', model: 'model-a' }, undefined, store);
  const second = await fingerprintModel(llmWith(stream), { provider: 'one', model: 'model-a' }, undefined, store);
  assert.deepEqual(first.identity.unstable, ['pick-letter']);
  assert.ok(!first.identity.probeIds.includes('pick-letter'));
  assert.equal(second.identity.digest, first.identity.digest);
  assert.equal(second.identity.verdict, 'stable');
});

test('a run that covers fewer probes stays comparable on the ones both runs answered', async () => {
  // The bug this replaces: drift was decided by comparing two hashes, so a route
  // that dropped one probe (here `pick-colour` jittered on the first run, which
  // removes it from the digest) built a different hash from the identical
  // backend and reported a model swap. Comparing answers probe by probe over the
  // intersection keeps such a run 'stable'.
  let colour = 0;
  const stream = async function* (options) {
    const prompt = options.messages[0].content[0].text;
    if (prompt.startsWith('Run ')) {
      yield { type: 'text-delta', text: numbers(200, 40) };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (prompt.includes('Name one colour')) {
      colour += 1;
      yield { type: 'text-delta', text: colour === 2 ? 'Red' : 'Blue' };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const answer = prompt.includes('Pick a number') ? '42'
      : prompt.includes('Pick one letter') ? 'A'
        : prompt.includes('one programming language') ? 'Python'
          : prompt.includes('exact model') ? 'model-a'
            : prompt.includes('DSH_FP_OK') ? 'DSH_FP_OK'
              : prompt.includes('Calculate') ? '657'
                : prompt.includes('JSON object') ? '{"alpha":17,"beta":["x","y"]}'
                  : prompt.includes('N7Q9-X2M4') ? 'N7Q9-X2M4'
                    : prompt.includes('JavaScript') ? 'function square(n){return n*n}'
                      : '模型指纹测试通过';
    yield { type: 'text-delta', text: answer };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const store = memoryStore();
  const first = await fingerprintModel(llmWith(stream), { provider: 'one', model: 'model-a' }, undefined, store);
  const second = await fingerprintModel(llmWith(stream), { provider: 'one', model: 'model-a' }, undefined, store);
  // The first run could not repeat `pick-colour` (Blue then Red), so it covers
  // three probes; the second covers four. Different digests, same backend.
  assert.equal(first.identity.probes, 3);
  assert.equal(second.identity.probes, 4);
  assert.notEqual(first.identity.digest, second.identity.digest);
  assert.equal(second.identity.verdict, 'stable');
  assert.deepEqual(second.identity.changedProbes, []);
  assert.equal(second.identity.comparedProbes, 3);
  // Answers already on record are never overwritten; a probe the first run could
  // not use is appended, so coverage widens without rewriting history.
  const stored = await store.load('one\u0000model-a\u0000identity');
  assert.deepEqual(stored.answers, { 'pick-colour': 'blue', 'pick-lang': 'python', 'pick-letter': 'A', 'pick-number': '42' });
  assert.equal(stored.runs, 2);
});

test('a single matching answer is not enough to claim a shared backend', async () => {
  // Most models answer `Python` to the language prompt, so one shared answer
  // pairs unrelated models all the time. Requiring two shared answers is what
  // keeps a false "same backend" claim — the expensive mistake — from showing up
  // on a fresh install.
  const store = memoryStore();
  await store.save('one\u0000model-a\u0000identity', {
    digest: 'deadbeefdeadbeef',
    probeSet: 'v2:pick-colour,pick-lang,pick-letter,pick-number',
    answers: { 'pick-lang': 'python' },
    runs: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const result = await fingerprintModel(llmWith(sampleStream()), { provider: 'two', model: 'model-b' }, undefined, store);
  assert.deepEqual(result.identity.peers, []);
});

test('the tokenizer vector survives a route that moves its baseline between hosts', async () => {
  // The bug this guards: a single baseline measured once per run got 31 from one
  // backend and 21 from another, turning a real 49 into a bogus 59. Pairing each
  // body count with the baseline read right before it, and requiring two pairs to
  // agree, keeps the vector on whichever backend answered twice in a row.
  let baseCalls = 0;
  const counter = (prompt) => {
    if (prompt === 'a') {
      baseCalls += 1;
      return baseCalls === 1 ? 21 : BASELINE_RAW;
    }
    const index = TOKENIZER_PROBES.findIndex((probe) => probe.text === prompt);
    if (index < 0) return undefined;
    // The first attempt lands on the other backend, which counts differently.
    return baseCalls <= 1 ? DEEPSEEK_RAW[index] + 4 : DEEPSEEK_RAW[index];
  };
  const result = await fingerprintModel(llmWith(sampleStream({ tokenizer: counter })), { provider: 'tk', model: 'deepseek-v4.1-flash' });
  assert.deepEqual(result.tokenizer.values, [49, 53, 62, 83], 'the vector is ordered like TOKENIZER_IDS');
  assert.equal(result.tokenizer.verdict, 'match');
  assert.deepEqual(result.tokenizer.families, ['deepseek']);
  assert.equal(result.tokenizer.probes.every((probe) => probe.ok), true);
});

test('a route that never repeats a pair is reported instead of guessed', async () => {
  let calls = 0;
  const counter = (prompt) => {
    if (prompt === 'a') return BASELINE_RAW;
    calls += 1;
    // Every body prompt comes back with a different count, the signature of a
    // route that load-balances across hosts with different templates.
    return 80 + (calls % 7);
  };
  const result = await fingerprintModel(llmWith(sampleStream({ tokenizer: counter })), { provider: 'tk', model: 'deepseek-v4.1-flash' });
  const english = result.tokenizer.probes.find((probe) => probe.id === 'tok-english');
  assert.equal(english.ok, false);
  assert.equal(english.code, 'UNSTABLE_ROUTING');
  assert.equal(result.tokenizer.verdict, 'insufficient');
});

test('a difference that cannot be a tokenizer count is rejected', async () => {
  const counter = (prompt) => (prompt === 'a' ? BASELINE_RAW : 500);
  const result = await fingerprintModel(llmWith(sampleStream({ tokenizer: counter })), { provider: 'tk', model: 'deepseek-v4.1-flash' });
  const english = result.tokenizer.probes.find((probe) => probe.id === 'tok-english');
  assert.equal(english.ok, false);
  assert.equal(english.code, 'IMPLAUSIBLE_COUNT');
});

test('an endpoint that hides its prompt token count is named, not guessed', async () => {
  const counter = () => undefined;
  const result = await fingerprintModel(llmWith(sampleStream({ tokenizer: counter })), { provider: 'tk', model: 'deepseek-v4.1-flash' });
  const english = result.tokenizer.probes.find((probe) => probe.id === 'tok-english');
  assert.equal(english.ok, false);
  assert.equal(english.code, 'USAGE_NOT_REPORTED');
});

test('one answer moving between runs is unstable, not a swapped backend', async () => {
  // Live case on tk/deepseek-v4.1-flash-1017: `pick-letter` answered K in one run
  // and Q in the next while the other three probes never moved. Both answers were
  // reproduced inside their own run, so the in-run repeat check passed — the move
  // only shows up across runs. Two or more answers moving together is a swap; one
  // moving alone is the probe being unstable, and marking the probe as fluctuating
  // keeps it from raising the same alarm on every later run.
  const store = memoryStore();
  const letters = { values: ['K', 'Q', 'K'], cursor: { calls: 0 } };
  const first = await fingerprintModel(llmWith(sampleStream({ letters })), { provider: 'tk', model: 'model-a' }, undefined, store);
  assert.equal(first.identity.verdict, 'baseline-created');
  const second = await fingerprintModel(llmWith(sampleStream({ letters })), { provider: 'tk', model: 'model-a' }, undefined, store);
  assert.equal(second.identity.verdict, 'stable', 'a single flopping probe must not read as a model swap');
  assert.deepEqual(second.identity.changedProbes, []);
  assert.ok(second.identity.fluctuating.includes('pick-letter'));
  assert.equal(second.identity.comparedProbes, 3, 'the flopping probe is excluded from the comparison');
  const third = await fingerprintModel(llmWith(sampleStream({ letters })), { provider: 'tk', model: 'model-a' }, undefined, store);
  assert.equal(third.identity.verdict, 'stable', 'the probe stays excluded instead of flapping every run');
});

test('a whole vector moving at once is still reported as drift', async () => {
  const store = memoryStore();
  await fingerprintModel(llmWith(sampleStream()), { provider: 'one', model: 'model-a' }, undefined, store);
  const swapped = await fingerprintModel(llmWith(sampleStream({ deterministic: 'other-backend' })), { provider: 'one', model: 'model-a' }, undefined, store);
  assert.equal(swapped.identity.verdict, 'drift');
  assert.equal(swapped.identity.changedProbes.length, 4);
});


test('two concurrent saves keep both baselines instead of overwriting one', async () => {
  // The panel can fingerprint two rows at once, and every save is a full
  // read-modify-write of one JSON file. Without serialisation both writes read
  // the same empty file and the later one drops the other row's baseline.
  const dir = await mkdtemp(join(tmpdir(), 'dmp-store-'));
  const file = join(dir, 'baseline.json');
  const sep = String.fromCharCode(0);
  const a = `one${sep}model-a`;
  const b = `two${sep}model-b`;
  try {
    // Two separate instances on purpose: the plugin builds a fresh store for every
    // run, so a queue scoped to one instance would serialise nothing.
    await Promise.all([
      fileStore(file).save(a, { runs: 1, updatedAt: '2026-01-01T00:00:00.000Z' }),
      fileStore(file).save(b, { runs: 1, updatedAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    const store = fileStore(file);
    const all = await store.loadAll();
    assert.deepEqual(Object.keys(all).sort(), [a, b].sort());
    assert.equal((await store.load(b)).runs, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
