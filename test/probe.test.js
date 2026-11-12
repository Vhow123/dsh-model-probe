import test from 'node:test';
import assert from 'node:assert/strict';
import { probeModel, readCatalog, sanitizeSvg } from '../index.js';

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

test('SVG probe requests an animated pelican fixture and returns sanitized source', async () => {
  const result = await probeModel(llmWith(async function* (options) {
    assert.match(options.messages[0].content[0].text, /animated SVG of a pelican riding a bicycle/);
    assert.match(options.messages[0].content[0].text, /repeatCount="indefinite"/);
    assert.equal(options.maxTokens, 16384);
    yield { type: 'text-delta', text: '```svg\n<svg viewBox="0 0 10 10" onload="alert(1)"><rect width="10" height="10"><animate attributeName="x" values="0;5;0" dur="3s" repeatCount="indefinite"/></rect><script>alert(1)</script></svg>\n```' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'svg' });
  assert.equal(result.ok, true);
  assert.equal(result.type, 'svg');
  assert.equal(result.svg, '<svg viewBox="0 0 10 10"><rect width="10" height="10"><animate attributeName="x" values="0;5;0" dur="3s" repeatCount="indefinite"/></rect></svg>');
  assert.equal(result.animationCount, 1);
  assert.equal(result.svgBytes, Buffer.byteLength(result.svg));
  assert.equal(result.request.maxTokens, 16384);
});

test('SVG sanitizer preserves native animation but removes active and external content', () => {
  const { svg, animationCount } = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" style="background:url(https://example.test)"><style>*{fill:red}</style><animate attributeName="x" to="1"/><image href="https://example.test/a.png"/><a xlink:href="javascript:alert(1)"><circle r="4" fill="url(#ok)"/></a></svg>');
  assert.equal(svg.includes('<script'), false);
  assert.equal(svg.includes('<style'), false);
  assert.equal(svg.includes('<animate attributeName="x"'), true);
  assert.equal(animationCount, 1);
  assert.equal(svg.includes('<image'), false);
  assert.equal(/onload|href|style=|javascript:|https:/.test(svg), false);
  assert.match(svg, /fill="url\(#ok\)"/);
});

test('SVG probe marks a static drawing as not meeting the animation fixture', async () => {
  const result = await probeModel(llmWith(async function* () {
    yield { type: 'text-delta', text: '<svg><circle r="4"/></svg>' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'svg' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STATIC_SVG');
  assert.equal(result.animationCount, 0);
});

test('SVG sanitizer rejects animations that target links or events', () => {
  assert.throws(() => sanitizeSvg('<svg><rect width="10" height="10"><animate attributeName="href" values="https://example.test"/></rect></svg>'), /动画不能修改/);
});

test('SVG probe rejects replies without a complete SVG', async () => {
  const result = await probeModel(llmWith(async function* () {
    yield { type: 'text-delta', text: 'I cannot draw that.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'svg' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_SVG');
  assert.match(result.message, /完整的 SVG/);
});

test('SVG sanitizer enforces the 32 KiB output limit', () => {
  const source = `<svg><desc>${'x'.repeat(33000)}</desc></svg>`;
  assert.throws(() => sanitizeSvg(source), /32 KiB/);
});

test('inputs reject missing routes', async () => {
  await assert.rejects(() => probeModel(llmWith(async function* () {}), {}), /provider 和 model 不能为空/);
});
