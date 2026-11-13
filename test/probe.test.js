import test from 'node:test';
import assert from 'node:assert/strict';
import { probeModel, readCatalog, sanitizeSvg, sanitizeArtifact, fingerprintModel, FINGERPRINT_PROBES } from '../index.js';

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

test('custom SVG probe adds an SVG output contract to a short Chinese prompt', async () => {
  const prompt = '三英战吕布';
  const result = await probeModel(llmWith(async function* (options) {
    assert.match(options.messages[0].content[0].text, /under 3,000 bytes and at most 24 elements/);
    assert.equal(options.maxTokens, 4096);
    assert.match(options.messages[0].content[0].text, /User request:\n三英战吕布$/);
    yield { type: 'text-delta', text: '<svg viewBox="0 0 10 10"><path d="M1 9 5 1 9 9Z" fill="red"/></svg>' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'custom-svg', prompt });
  assert.equal(result.ok, true);
  assert.equal(result.type, 'custom-svg');
  assert.equal(result.quick, true);
  assert.equal(result.elementCount, 2);
  assert.equal(result.animationCount, 0);
  assert.match(result.request.messages[0].content[0].text, /三英战吕布$/);
  assert.match(result.svg, /fill="red"/);
});

test('custom SVG probe preserves requested animation', async () => {
  const result = await probeModel(llmWith(async function* () {
    yield { type: 'text-delta', text: '<svg><circle r="4"><animate attributeName="r" values="4;8;4" dur="2s" repeatCount="indefinite"/></circle></svg>' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'custom-svg', prompt: 'Draw a pulsing circle as SVG.' });
  assert.equal(result.ok, true);
  assert.equal(result.animationCount, 1);
});

test('custom SVG quick mode rejects oversized and over-element results', async () => {
  const run = (svg) => probeModel(llmWith(async function* () {
    yield { type: 'text-delta', text: svg };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'custom-svg', prompt: 'simple icon' });
  const oversized = await run(`<svg><desc>${'x'.repeat(3000)}</desc></svg>`);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, 'SVG_LIMIT_EXCEEDED');
  assert.match(oversized.message, /3000 字节/);
  const excessive = await run(`<svg>${'<circle r="1"/>'.repeat(30)}</svg>`);
  assert.equal(excessive.ok, false);
  assert.equal(excessive.code, 'SVG_LIMIT_EXCEEDED');
  assert.match(excessive.message, /30 个元素/);
});

test('custom SVG standard mode opts out of quick limits', async () => {
  const result = await probeModel(llmWith(async function* (options) {
    assert.match(options.messages[0].content[0].text, /under 12,000 bytes and 100 elements/);
    yield { type: 'text-delta', text: `<svg><desc>${'x'.repeat(3100)}</desc></svg>` };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'custom-svg', prompt: 'detailed icon', quick: false });
  assert.equal(result.ok, true);
  assert.equal(result.quick, false);
  assert.ok(result.svgBytes > 3000);
});

test('custom SVG prompt must be present and bounded', async () => {
  await assert.rejects(() => probeModel(llmWith(async function* () {}), { provider: 'one', model: 'model-a', type: 'custom-svg', prompt: '  ' }), /提示词不能为空/);
  await assert.rejects(() => probeModel(llmWith(async function* () {}), { provider: 'one', model: 'model-a', type: 'custom-svg', prompt: 'x'.repeat(4001) }), /4000/);
});

test('fingerprint probe combines deterministic behavior checks and a stable digest', async () => {
  const answers = { identity: 'model-a', exact: 'DSH_FP_OK', reasoning: '657', json: '{"alpha":17,"beta":["x","y"]}', noise: 'N7Q9-X2M4', code: 'function square(n) { return n * n; }', language: '模型指纹测试通过' };
  const llm = llmWith(async function* (options) {
    const probe = FINGERPRINT_PROBES.find((item) => item.prompt === options.messages[0].content[0].text);
    assert.ok(probe);
    yield { type: 'text-delta', text: answers[probe.id] };
    yield { type: 'usage', usage: { outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const result = await fingerprintModel(llm, { mode: 'full', provider: 'one', model: 'model-a' });
  assert.equal(result.ok, true);
  assert.equal(result.score, 100);
  assert.equal(result.confidence, 100);
  assert.equal(result.completed, 7);
  assert.equal(result.reportedModel, 'model-a');
  assert.equal(result.claimedModelHintMatch, true);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.fingerprint, (await fingerprintModel(llm, { mode: 'full', provider: 'one', model: 'model-a' })).fingerprint);
});

test('fingerprint probe retains partial evidence when one behavioral probe fails', async () => {
  const llm = llmWith(async function* (options) {
    const prompt = options.messages[0].content[0].text;
    if (prompt.includes('Calculate')) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'failure' } } }; return; }
    const answer = prompt.includes('exact model') ? 'unknown' : prompt.includes('DSH_FP_OK') ? 'DSH_FP_OK' : prompt.includes('JSON object') ? '{"alpha":17,"beta":["x","y"]}' : prompt.includes('N7Q9-X2M4') ? 'N7Q9-X2M4' : prompt.includes('JavaScript') ? 'function square(n){return n*n}' : '模型指纹测试通过';
    yield { type: 'text-delta', text: answer };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const result = await fingerprintModel(llm, { mode: 'full', provider: 'one', model: 'model-a' });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.completed, 6);
  assert.equal(result.score, Math.round(500 / 6));
  assert.equal(result.features.checks.reasoning, false);
});

test('inputs reject missing routes', async () => {
  await assert.rejects(() => probeModel(llmWith(async function* () {}), {}), /provider 和 model 不能为空/);
});

test('HTML artifact sanitizer keeps inline CSS and animation while dropping active content', () => {
  const source = `<!doctype html><html><head><style>@import url(https://example.test/a.css); body{background:url("https://example.test/b.png")} .w{fill:#123456;animation:spin 2s infinite} @keyframes spin{to{transform:rotate(360deg)}}</style></head><body><svg viewBox="0 0 10 10" onload="alert(1)"><circle class="w" r="4" style="fill:#ff8800;stroke:#222" fill="url(#g)"/><use href="#g"/><script>alert(1)</script><image href="https://example.test/c.png"/></svg><a href="javascript:alert(1)">x</a></body></html>`;
  const result = sanitizeArtifact(source);
  assert.equal(result.html.includes('<script'), false);
  assert.equal(/onload|javascript:|@import|https:\/\//.test(result.html), false);
  assert.match(result.html, /style="fill:#ff8800;stroke:#222"/);
  assert.match(result.html, /@keyframes spin/);
  assert.match(result.html, /fill="url\(#g\)"/);
  assert.match(result.html, /href="#g"/);
  assert.equal(result.cssAnimationCount, 1);
  assert.equal(result.animationCount, 0);
  assert.ok(result.colorCount >= 3);
});

test('HTML artifact sanitizer wraps a bare drawing in a document shell', () => {
  const result = sanitizeArtifact('```html\n<svg viewBox="0 0 10 10"><rect width="4" height="4"><animate attributeName="x" values="0;1;0" dur="2s" repeatCount="indefinite"/></rect></svg>\n```');
  assert.match(result.html, /^<!doctype html>/);
  assert.match(result.html, /<svg viewBox="0 0 10 10">/);
  assert.equal(result.animationCount, 1);
  assert.equal(result.cssAnimationCount, 0);
});

test('HTML artifact sanitizer keeps the whole drawing visible in the preview', () => {
  const sliced = sanitizeArtifact('<svg viewBox="0 0 100 50" preserveAspectRatio="xMidYMid slice"><rect width="50" height="20"/></svg>');
  assert.match(sliced.html, /preserveAspectRatio="xMidYMid meet"/);
  const plain = sanitizeArtifact('<svg viewBox="0 0 100 50"><rect width="50" height="20"/></svg>');
  assert.doesNotMatch(plain.html, /slice/);
});

test('HTML artifact sanitizer composes transforms before judging overflow', () => {
  const shifted = sanitizeArtifact('<svg viewBox="0 0 100 100"><g transform="translate(-50,0)"><circle cx="90" cy="50" r="30"/></g></svg>');
  assert.equal(shifted.overflowPct, 0);
  const bare = sanitizeArtifact('<svg viewBox="0 0 100 100"><circle cx="90" cy="50" r="30"/></svg>');
  assert.equal(bare.overflowPct, 20);
  const scaled = sanitizeArtifact('<svg viewBox="0 0 100 100"><g transform="translate(50,50) scale(2)"><rect width="40" height="40"/></g></svg>');
  assert.equal(scaled.overflowPct, 30);
});

test('HTML artifact sanitizer reports how far the drawing spills outside the viewport', () => {
  const inside = sanitizeArtifact('<svg viewBox="0 0 100 100"><rect width="80" height="80"/></svg>');
  assert.equal(inside.overflowPct, 0);
  const spilling = sanitizeArtifact('<svg viewBox="0 0 100 100"><rect width="150" height="50"/></svg>');
  assert.equal(spilling.overflowPct, 50);
  const fromWidthHeight = sanitizeArtifact('<svg width="200" height="200"><circle cx="180" cy="100" r="40"/></svg>');
  assert.equal(fromWidthHeight.overflowPct, 10);
  const backdrop = sanitizeArtifact('<svg viewBox="0 0 100 100"><rect x="-50" y="-50" width="200" height="200" fill="url(#sky)"/><circle cx="50" cy="50" r="10"/></svg>');
  assert.equal(backdrop.overflowPct, 0);
  const unmeasurable = sanitizeArtifact('<svg><text x="1" y="1">hi</text></svg>');
  assert.equal(unmeasurable.overflowPct, null);
  const smooth = sanitizeArtifact('<svg viewBox="0 0 100 100"><path d="M10 50 Q25 20 50 50 T90 50"/></svg>');
  assert.equal(smooth.overflowPct, 0);
  const offscreen = sanitizeArtifact('<svg viewBox="0 0 100 100"><rect x="140" width="20" height="10"/><circle cx="50" cy="50" r="5"/></svg>');
  assert.equal(offscreen.overflowPct, 0);
  const sky = sanitizeArtifact('<svg viewBox="0 0 100 100"><rect y="-30" width="100" height="130" fill="url(#sky)"/><circle cx="50" cy="50" r="10"/></svg>');
  assert.equal(sky.overflowPct, 0);
  const halo = sanitizeArtifact('<svg viewBox="0 0 900 560"><circle cx="744" cy="104" r="160" fill="url(#sunGlow)"/><circle cx="300" cy="300" r="40"/></svg>');
  assert.equal(halo.overflowPct, 0);
  const sliver = sanitizeArtifact('<svg viewBox="0 0 100 100"><rect x="140" y="10" width="6" height="4"/><circle cx="50" cy="50" r="10"/></svg>');
  assert.equal(sliver.overflowPct, 0);
  const template = sanitizeArtifact('<svg viewBox="0 0 100 100"><defs><g id="wheel"><circle r="60"/></g></defs><use href="#wheel" x="50" y="50"/><circle cx="50" cy="50" r="10"/></svg>');
  assert.equal(template.overflowPct, 0);
  const driving = sanitizeArtifact('<svg viewBox="0 0 100 100"><g><animateTransform attributeName="transform" type="translate" values="-300 50;300 50" dur="4s" repeatCount="indefinite"/><circle r="8"/></g><circle cx="50" cy="50" r="10"/></svg>');
  assert.equal(driving.overflowPct, 0);
});

test('HTML probe asks for a self-contained document and measures the drawing', async () => {
  const brief = '画一只骑车的猫';
  const result = await probeModel(llmWith(async function* (options) {
    assert.match(options.messages[0].content[0].text, /self-contained HTML document/);
    assert.match(options.messages[0].content[0].text, /User request:\n画一只骑车的猫$/);
    assert.equal(options.maxTokens, 65536);
    yield { type: 'text-delta', text: '<!doctype html><html><head><style>@keyframes roll{to{transform:rotate(360deg)}} .w{animation:roll 2s infinite}</style></head><body><svg viewBox="0 0 10 10"><circle class="w" r="4" fill="#123456"/><circle r="2" fill="#abcdef"/></svg></body></html>' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'svg-html', prompt: brief });
  assert.equal(result.ok, true);
  assert.equal(result.type, 'svg-html');
  assert.equal(result.animated, true);
  assert.equal(result.cssAnimationCount, 1);
  assert.equal(result.colorCount, 2);
  assert.equal(typeof result.overflowPct, 'number');
  assert.equal(result.external, false);
  assert.ok(result.htmlBytes > 0);
  assert.match(result.html, /@keyframes roll/);
  assert.equal(result.request.maxTokens, 65536);
});

test('HTML probe marks a static default drawing as not meeting the animated brief', async () => {
  const result = await probeModel(llmWith(async function* (options) {
    assert.match(options.messages[0].content[0].text, /鹈鹕/);
    yield { type: 'text-delta', text: '<svg viewBox="0 0 10 10"><circle r="4" fill="#123456"/></svg>' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'svg-html' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STATIC_DRAWING');
  assert.equal(result.animated, false);
});

test('HTML probe accepts a static drawing when the user supplied the brief', async () => {
  const result = await probeModel(llmWith(async function* () {
    yield { type: 'text-delta', text: '<svg viewBox="0 0 10 10"><circle r="4" fill="#123456"/></svg>' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'svg-html', prompt: '静态图标' });
  assert.equal(result.ok, true);
  assert.equal(result.animated, false);
});

test('drawing probes report a token budget spent on reasoning', async () => {
  const result = await probeModel(llmWith(async function* () {
    yield { type: 'reasoning-delta', text: 'planning coordinates' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  }), { provider: 'one', model: 'model-a', type: 'svg-html' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUTPUT_TRUNCATED');
  assert.match(result.message, /max-tokens/);
});

test('HTML probe rejects replies without SVG and oversized documents', async () => {
  const run = (text) => probeModel(llmWith(async function* () {
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { provider: 'one', model: 'model-a', type: 'svg-html', prompt: 'x' });
  const missing = await run('I cannot draw that.');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'INVALID_ARTIFACT');
  assert.match(missing.message, /没有 SVG/);
  const oversized = await run(`<svg><desc>${'x'.repeat(65000)}</desc></svg>`);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, 'ARTIFACT_LIMIT_EXCEEDED');
  assert.match(oversized.message, /64000 字节/);
});
