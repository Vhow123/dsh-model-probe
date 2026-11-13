import { writeFile } from 'node:fs/promises';
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const target = targets.find(item => item.type === 'page' && item.url === 'http://127.0.0.1:8765/');
if (!target) throw new Error('找不到界面验收页面');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const errors = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
};
function call(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
await call('Runtime.enable');
await call('Page.enable');
await call('Page.reload', { ignoreCache: true });
await new Promise(resolve => setTimeout(resolve, 500));
errors.length = 0;
// The panel opens from the rail launcher; a fresh browser profile starts closed.
for (let i = 0; i < 50; i++) {
  if (await evaluate("document.querySelectorAll('.dmp-fingerprint-btn').length") > 0) break;
  if (i === 4 && await evaluate("document.querySelectorAll('.dmp-model').length === 0")) {
    await evaluate("document.querySelector('.dmp-launcher')?.click()");
  }
  await new Promise(resolve => setTimeout(resolve, 200));
}
const initial = await evaluate("(() => { const buttons = [...document.querySelectorAll('.dmp-toolbar button')]; const batch = buttons.find(button => /批量指纹/.test(button.textContent)); const toggle = [...document.querySelectorAll('.dmp-settings')].find(node => /完整指纹/.test(node.textContent)); return { models: document.querySelectorAll('.dmp-model').length, fingerprintButtons: document.querySelectorAll('.dmp-fingerprint-btn').length, batch: batch?.textContent || null, batchDisabled: batch?.disabled ?? null, fullToggle: toggle ? { text: toggle.textContent, checked: !!toggle.querySelector('input').checked } : null, error: document.querySelector('.dmp-error')?.textContent }; })()");
if (!initial.batch || !/^批量指纹 \(\d+\)$/.test(initial.batch)) { console.error('工具栏没有批量指纹按钮: ' + initial.batch); process.exitCode = 1; }
if (!initial.fullToggle) { console.error('工具栏没有完整指纹开关'); process.exitCode = 1; }
else if (initial.fullToggle.checked) { console.error('完整指纹默认应为关闭'); process.exitCode = 1; }
if (initial.models < 1 || initial.models !== initial.fingerprintButtons || initial.error) throw new Error(JSON.stringify({ initial, errors }));
// Never fingerprint the operator's metered official account: pick a row from the
// free `tk` route instead of whichever row happens to mention deepseek.
await evaluate("(() => { const sections = [...document.querySelectorAll('.dmp-group')]; const section = sections.find(item => (item.querySelector('.dmp-group-count')?.textContent || '').startsWith('tk ·')) || sections[0]; window.__dmpFingerprintRow = section.querySelector('.dmp-model'); window.__dmpFingerprintRow.scrollIntoView({ block: 'center' }); window.__dmpFingerprintRow.querySelector('.dmp-fingerprint-btn').click(); return true; })()");
for (let i = 0; i < 1600; i++) {
  if (await evaluate("window.__dmpFingerprintRow.querySelector('.dmp-fingerprint-link') !== null")) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
const tested = await evaluate("({ summary: window.__dmpFingerprintRow.querySelector('.dmp-fingerprint-link')?.textContent, stopVisible: window.__dmpFingerprintRow.querySelector('.dmp-fingerprint-btn')?.textContent === '■' })");
await evaluate("window.__dmpFingerprintRow.querySelector('.dmp-fingerprint-link')?.click()");
await new Promise(resolve => setTimeout(resolve, 300));
const details = await evaluate("({ fingerprint: window.__dmpFingerprintRow.querySelector('.dmp-fingerprint-detail')?.textContent, probeDetails: !!window.__dmpFingerprintRow.querySelector('.dmp-fingerprint-detail details'), hash: window.__dmpFingerprintRow.querySelector('.dmp-fingerprint-hash')?.textContent })");
const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(new URL('./fingerprint-ui-result.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
console.log(JSON.stringify({ initial, tested, details, errors }, null, 2));
ws.close();
if (errors.length || !tested.summary?.includes('模型指纹:') || !details.hash || !details.probeDetails || tested.stopVisible) process.exitCode = 1;
if (!/身份(签名|一致|已变化|基线)/.test(tested.summary || '')) { console.error('行摘要没有身份签名: ' + tested.summary); process.exitCode = 1; }
if (!/身份签名/.test(details.fingerprint || '')) { console.error('详情面板没有身份签名'); process.exitCode = 1; }
if (!/确定性探针/.test(details.fingerprint || '')) { console.error('详情面板没有确定性探针证据'); process.exitCode = 1; }
if (!/(同签名模型|本地暂无答案相同的其他条目|同签名比对只在本机测过的条目之间进行)/.test(details.fingerprint || '')) { console.error('详情面板没有跨模型签名比对结果'); process.exitCode = 1; }
if (!/分词器家族/.test(tested.summary || '')) { console.error('行摘要没有分词器家族: ' + tested.summary); process.exitCode = 1; }
if (!/分词器家族/.test(details.fingerprint || '')) { console.error('详情面板没有分词器家族'); process.exitCode = 1; }
if (!/分词器探针/.test(details.fingerprint || '')) { console.error('详情面板没有分词器探针证据'); process.exitCode = 1; }
if (!/快速指纹/.test(details.fingerprint || '')) { console.error('详情面板没有标明快速模式'); process.exitCode = 1; }
// Fast mode skips the behavioral probes, so the empty lists must not render at all.
if (/探针详情\s*\[\]/.test(details.fingerprint || '')) { console.error('快速模式下渲染了空的探针详情'); process.exitCode = 1; }
if (/分布样本 \(0\)/.test(details.fingerprint || '')) { console.error('快速模式下渲染了空的分布样本'); process.exitCode = 1; }
if (/行为分\s*(null|\/)/.test(tested.summary || '')) { console.error('快速模式下行摘要出现了行为分'); process.exitCode = 1; }
// A zero-length list must render nothing: `0 && h(...)` leaks a stray "0" into the panel.
if (/确定性探针\s*0/.test(details.fingerprint || '')) { console.error('详情面板出现游离的 0'); process.exitCode = 1; }
if (!/分词器向量 [\d—]+\/[\d—]+\/[\d—]+\/[\d—]+/.test(details.fingerprint || '')) { console.error('详情面板的分词器向量不是四维'); process.exitCode = 1; }
// An unmatched vector has to say how far off it is instead of leaving the operator
// with a bare "not in the library".
if (/参考库中无此向量/.test(details.fingerprint || '') && !/(最接近 [\d—]+|这不等于模型有问题|只差一维)/.test(details.fingerprint || '')) {
  console.error('未匹配的分词器向量没有给出最近邻或说明');
  process.exitCode = 1;
}
// "Insufficient counts" used to be a dead end: the panel said the vector was
// incomplete without saying why. Routing is the usual cause, so name it.
if (/分词器计数不足/.test(tested.summary || '') && !/没拿到可采信的计数/.test(details.fingerprint || '')) {
  console.error('分词器计数不足没有给出原因');
  process.exitCode = 1;
}
// One probe drifting between runs is an unstable probe, not a swapped model; the
// panel lists those separately from a real drift.
if (/答案会在运行之间变动/.test(details.fingerprint || '') && !/不是换了模型/.test(details.fingerprint || '')) {
  console.error('抖动探针没有说明它不参与身份判定');
  process.exitCode = 1;
}
