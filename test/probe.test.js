import test from 'node:test';
import assert from 'node:assert/strict';
import { probeModel, readCatalog } from '../index.js';

function llmWith(stream) {
  return { stream };
}

test('catalog merges provider model lists and isolates discovery failures', async () => {
  const catalog = await readCatalog({
    listProviders: () => [{ id: 'one', name: 'Provider One' }, { id: 'broken' }],
    listModels: async (provider) => {
      if (provider === 'broken') throw new Error('catalog unavailable');
      return [{ id: 'model-a' }];
    },
  });
  assert.equal(catalog.total, 1);
  assert.deepEqual(catalog.groups[0].models, [{ id: 'model-a', name: 'model-a' }]);
  assert.equal(catalog.groups[1].error, 'catalog unavailable');
});

test('successful stream measures latency, reply and token usage', async () => {
  const result = await probeModel(llmWith(async function* (options) {
    assert.equal(options.provider, 'one');
    assert.equal(options.model, 'model-a');
    assert.equal(options.messages[0].content[0].text, 'Reply with OK only.');
    yield { type: 'text-delta', index: 0, text: 'O' };
    yield { type: 'text-delta', index: 0, text: 'K' };
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a' });
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'OK');
  assert.equal(result.exactReply, true);
  assert.equal(result.mode, 'stream');
  assert.equal(typeof result.firstTokenMs, 'number');
  assert.equal(result.usage.outputTokens, 2);
});

test('max-tokens is a completed connection rather than a transport failure', async () => {
  const result = await probeModel(llmWith(async function* () {
    yield { type: 'reasoning-delta', index: 0, text: 'thinking' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  }), { provider: 'one', model: 'reasoning-model' });
  assert.equal(result.ok, true);
  assert.equal(result.reasoning, 'thinking');
  assert.equal(result.reply, '');
});

test('terminal LLM failure retains code and redacts credentials', async () => {
  const result = await probeModel(llmWith(async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP_ERROR', status: 401, message: 'Bearer sk-abcdef123456 rejected' } } };
  }), { provider: 'one', model: 'model-a' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HTTP_ERROR');
  assert.equal(result.status, 401);
  assert.equal(result.message.includes('sk-abcdef123456'), false);
});

test('thrown errors become test results', async () => {
  const result = await probeModel(llmWith(async function* () {
    throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
  }), { provider: 'one', model: 'offline' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ECONNREFUSED');
});

test('incomplete stream is reported', async () => {
  const result = await probeModel(llmWith(async function* () {
    yield { type: 'text-delta', index: 0, text: 'OK' };
  }), { provider: 'one', model: 'model-a' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INCOMPLETE_STREAM');
});

test('external stop aborts the model stream', async () => {
  const controller = new AbortController();
  const resultPromise = probeModel(llmWith(async function* (options) {
    yield { type: 'text-delta', index: 0, text: 'O' };
    options.signal.throwIfAborted();
  }), { provider: 'one', model: 'model-a' }, controller.signal);
  controller.abort(new Error('测试已停止'));
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.match(result.message, /测试已停止/);
});

test('inputs reject missing routes', async () => {
  await assert.rejects(() => probeModel(llmWith(async function* () {}), {}), /provider 和 model 不能为空/);
});
