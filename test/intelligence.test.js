import test from 'node:test';
import assert from 'node:assert/strict';
import { intelligenceModel, INTELLIGENCE_PROBES, checkIntelligenceAnswer, name } from '../index.js';

const ANSWERS = {
  'candy-canary': '4',
  'logic-chain': '是',
  'logic-order': '乙',
  'logic-converse': '是',
  'math-arithmetic': '29',
  'math-rectangle': '54',
  'math-sequence': '42',
  'math-hard-roots': '169',
  'math-hard-probability': '5/14',
  'math-hard-recurrence': '63',
  'code-function': 'function sumEven(n) { let sum = 0; for (let i = 2; i <= n; i += 1) { if (i % 2 === 0) sum += i; } return sum; }',
  'code-output': '4-6',
  'instruction-token': 'DSH-IQ-731',
  'instruction-json': '{"ok":true,"count":3,"tag":"alpha"}',
  'instruction-lines': 'RED\nGREEN\nBLUE',
  'knowledge-water': 'H2O',
  'trap-rooster': '公鸡不会下蛋',
  'trap-weight': '一样重',
};

function scriptedLlm(pick) {
  return {
    stream(options) {
      const prompt = options.messages[0].content[0].text;
      const probe = INTELLIGENCE_PROBES.find((item) => item.prompt === prompt);
      const text = pick(probe);
      return (async function* () {
        yield { type: 'usage', usage: { outputTokens: 4, outputTokensDetails: { reasoningTokens: 2 } } };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

test('benchmark exposes 18 unique weighted probes', () => {
  assert.equal(name, 'dsh-model-probe');
  assert.equal(INTELLIGENCE_PROBES.length, 18);
  assert.equal(new Set(INTELLIGENCE_PROBES.map((probe) => probe.id)).size, 18);
  for (const probe of INTELLIGENCE_PROBES) {
    assert.ok(probe.prompt.length > 0);
    assert.ok(probe.expected.length > 0);
    assert.ok(probe.weight >= 1);
  }
  assert.equal(INTELLIGENCE_PROBES[0].id, 'candy-canary');
});

test('answer checker accepts exact answers and rejects near misses', () => {
  for (const [id, answer] of Object.entries(ANSWERS)) {
    assert.equal(checkIntelligenceAnswer(id, answer), true, `${id} should pass`);
  }
  assert.equal(checkIntelligenceAnswer('candy-canary', '3'), false);
  assert.equal(checkIntelligenceAnswer('math-hard-probability', '5/13'), false);
  assert.equal(checkIntelligenceAnswer('logic-converse', '否'), false);
  assert.equal(checkIntelligenceAnswer('trap-weight', '铁更重'), false);
  assert.equal(checkIntelligenceAnswer('code-function', 'function sumEven(n) { return n; }'), false);
  assert.equal(checkIntelligenceAnswer('code-function', 'function sumEven(n){let s=0;for(let i=2;i<=n;i+=2){s+=i;}return s;}'), true);
  assert.equal(checkIntelligenceAnswer('code-function', 'const sumEven = (n) => { let s = 0, i = 2; while (i <= n) { s += i; i += 2; } return s; };'), true);
  assert.equal(checkIntelligenceAnswer('code-function', 'function sumEven(n){const k=Math.floor(n/2);return k*(k+1);}'), true);
  assert.equal(checkIntelligenceAnswer('unknown-probe', 'anything'), false);
  // fenced code blocks and explicit ANSWER lines are unwrapped
  assert.equal(checkIntelligenceAnswer('math-sequence', '```\n42\n```'), true);
  assert.equal(checkIntelligenceAnswer('math-rectangle', '答案：54'), true);
});

test('a fully correct model scores 100 and lands in the flagship tier', async () => {
  const result = await intelligenceModel(scriptedLlm((probe) => ANSWERS[probe.id]), { provider: 'p', model: 'm' });
  assert.equal(result.ok, true);
  assert.equal(result.type, 'intelligence');
  assert.equal(result.score, 100);
  assert.equal(result.correct, 18);
  assert.equal(result.total, 18);
  assert.equal(result.tier, 'flagship');
  assert.equal(result.canary, true);
  assert.equal(result.passed, true);
  assert.equal(result.partial, false);
  assert.equal(result.code, undefined);
  assert.equal(result.weighted_got, result.weighted_max);
  assert.equal(result.request.probeCount, 18);
  assert.equal(result.request.stream, true);
  assert.equal(result.reasoning_tokens, 36);
  assert.equal(typeof result.latencyMs.mean, 'number');
  assert.equal(result.summary.includes('100/100'), true);
});

test('reasoning text without a token breakdown is reported as chars', async () => {
  const llm = {
    stream(options) {
      const prompt = options.messages[0].content[0].text;
      const probe = INTELLIGENCE_PROBES.find((item) => item.prompt === prompt);
      return (async function* () {
        yield { type: 'reasoning-delta', index: 0, text: '先想一步……' };
        yield { type: 'text-delta', index: 0, text: ANSWERS[probe.id] };
        yield { type: 'usage', usage: { inputTokens: 59, outputTokens: 38, totalTokens: 97 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const result = await intelligenceModel(llm, { provider: 'p', model: 'm' });
  assert.equal(result.ok, true);
  assert.equal(result.score, 100);
  assert.equal(result.reasoning_tokens, 0);
  assert.equal(result.reasoning_chars, 18 * 6);
  assert.equal(result.items[0].reasoningChars, 6);
});

test('wrong answers stay completed but become an abnormal profile', async () => {
  const result = await intelligenceModel(scriptedLlm(() => '不知道'), { provider: 'p', model: 'm' });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 18);
  assert.equal(result.score, 0);
  assert.equal(result.canary, false);
  assert.equal(result.tier, 'abnormal');
  assert.equal(result.passed, false);
});

test('aborting the run reports ABORTED and keeps skipped probes', async () => {
  const controller = new AbortController();
  const llm = {
    stream(options) {
      const prompt = options.messages[0].content[0].text;
      const probe = INTELLIGENCE_PROBES.find((item) => item.prompt === prompt);
      return (async function* () {
        if (probe.id === 'logic-order') controller.abort(new Error('用户停止'));
        yield { type: 'text-delta', index: 0, text: ANSWERS[probe.id] };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const result = await intelligenceModel(llm, { provider: 'p', model: 'm' }, controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ABORTED');
  assert.equal(result.aborted, true);
  assert.ok(result.skipped > 0);
  assert.equal(result.items.length, 18);
});

test('a stream that always fails yields INTELLIGENCE_FAILED', async () => {  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP_ERROR', status: 500, message: 'Bearer sk-abcdef123456 exploded' } } };
      })();
    },
  };
  const result = await intelligenceModel(llm, { provider: 'p', model: 'm' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INTELLIGENCE_FAILED');
  assert.equal(result.completed, 0);
  assert.equal(result.tier, 'insufficient');
  assert.equal(result.items.every((item) => item.skipped), true);
  assert.equal(JSON.stringify(result).includes('sk-abcdef123456'), false);
});
