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
for (let i = 0; i < 50; i++) {
  if (await evaluate("document.querySelectorAll('.dmp-fingerprint-btn').length") > 0) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
const initial = await evaluate("({ models: document.querySelectorAll('.dmp-model').length, fingerprintButtons: document.querySelectorAll('.dmp-fingerprint-btn').length, error: document.querySelector('.dmp-error')?.textContent })");
if (initial.models < 1 || initial.models !== initial.fingerprintButtons || initial.error) throw new Error(JSON.stringify({ initial, errors }));
await evaluate("(() => { const rows = [...document.querySelectorAll('.dmp-model')]; window.__dmpFingerprintRow = rows.find(row => row.textContent.includes('deepseek-flash')) || rows[0]; window.__dmpFingerprintRow.querySelector('.dmp-fingerprint-btn').click(); return true; })()");
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
