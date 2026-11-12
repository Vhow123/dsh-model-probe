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
for (let i = 0; i < 50; i++) {
  if (await evaluate("document.querySelectorAll('.dmp-model').length") > 0) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
const initial = await evaluate("({ models: document.querySelectorAll('.dmp-model').length, title: document.querySelector('.dmp-title')?.textContent, error: document.querySelector('.dmp-error')?.textContent })");
if (initial.models < 1 || initial.error) throw new Error(JSON.stringify({ initial, errors }));
if (!process.env.DMP_INSPECT_ONLY) {
  await evaluate("(() => { const select = document.querySelector('.dmp-toolbar select'); select.value = 'svg'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  await new Promise(resolve => setTimeout(resolve, 200));
}
const selectedType = await evaluate("document.querySelector('.dmp-toolbar select').value");
if (!process.env.DMP_INSPECT_ONLY) {
  await evaluate("document.querySelector('.dmp-model .dmp-detail-btn').click(); true");
  for (let i = 0; i < 1280; i++) {
    if (await evaluate("document.querySelector('.dmp-badge-success') !== null || document.querySelector('.dmp-badge-error') !== null")) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
const tested = await evaluate("({ badge: document.querySelector('.dmp-badge')?.textContent, result: document.querySelector('.dmp-model-sub')?.textContent, preview: !!document.querySelector('.dmp-svg-frame'), notice: document.querySelector('.dmp-svg-caption')?.textContent })");
await evaluate("(() => { if (!document.querySelector('.dmp-svg-source')) document.querySelector('.dmp-model [title=\"技术详情\"]').click(); return true; })()");
await new Promise(resolve => setTimeout(resolve, 500));
const source = await evaluate("(() => { const details = document.querySelector('.dmp-svg-source'); if (details) details.open = true; return { source: !!details, text: document.querySelector('.dmp-svg-source pre')?.textContent.slice(0, 100) }; })()");
const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(new URL('./svg-ui-result.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
console.log(JSON.stringify({ initial, selectedType, tested, source, errors }, null, 2));
ws.close();
if (errors.length || selectedType !== 'svg' || tested.badge !== '成功' || !tested.preview || !source.source) process.exitCode = 1;
