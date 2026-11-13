import { writeFile } from 'node:fs/promises';

const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const target = targets.find(item => item.type === 'page' && item.url === 'http://127.0.0.1:8765/');
if (!target) throw new Error('找不到界面验收页面');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const errors = [];
let consoleErrors = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await call('Runtime.enable');
await call('Page.enable');
await call('Page.reload', { ignoreCache: true });
await sleep(500);
errors.length = 0;
consoleErrors = [];

for (let i = 0; i < 60; i++) {
  if (await evaluate("document.querySelectorAll('.dmp-intel-btn').length") > 0) break;
  await sleep(200);
}
const initial = await evaluate(`({
  models: document.querySelectorAll('.dmp-model').length,
  iqButtons: document.querySelectorAll('.dmp-intel-btn').length,
  label: document.querySelector('.dmp-intel-btn')?.textContent,
  title: document.querySelector('.dmp-intel-btn')?.title,
  aria: document.querySelector('.dmp-intel-btn')?.getAttribute('aria-label'),
  error: document.querySelector('.dmp-error')?.textContent,
  lastError: document.body.dataset.lastError,
})`);
if (initial.models < 1 || initial.models !== initial.iqButtons || initial.error) throw new Error(JSON.stringify({ initial, errors }));
if (initial.label !== 'IQ') throw new Error('IQ 按钮文案异常: ' + initial.label);

// 选中 deepseek-flash（真实可用 provider），点 IQ
const picked = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.dmp-model')];
  const row = rows.find(r => r.textContent.includes('deepseek-flash')) || rows[0];
  window.__dmpIqRow = row;
  row.querySelector('.dmp-intel-btn').click();
  return row.querySelector('.dmp-model-name')?.textContent;
})()`);

// 运行中：按钮变 ■，并出现"检测中"提示
await sleep(600);
const running = await evaluate(`({
  label: window.__dmpIqRow.querySelector('.dmp-intel-btn')?.textContent,
  disabledByFingerprint: window.__dmpIqRow.querySelector('.dmp-fingerprint-btn')?.disabled,
  sub: window.__dmpIqRow.querySelector('.dmp-intel-sub')?.textContent,
})`);

// 等待结果链接出现（18 题串行，最长 10 分钟）
let done = false;
for (let i = 0; i < 3000; i++) {
  if (await evaluate("window.__dmpIqRow.querySelector('.dmp-fingerprint-link') !== null")) { done = true; break; }
  await sleep(250);
}
if (!done) throw new Error('智力检测 12.5 分钟内未返回');

const tested = await evaluate(`({
  summary: window.__dmpIqRow.querySelector('.dmp-fingerprint-link')?.textContent,
  stopVisible: window.__dmpIqRow.querySelector('.dmp-intel-btn')?.textContent === '■',
  iqEnabled: !window.__dmpIqRow.querySelector('.dmp-intel-btn')?.disabled,
})`);

await evaluate("window.__dmpIqRow.querySelector('.dmp-fingerprint-link')?.click()");
await sleep(400);
await evaluate("window.__dmpIqRow.scrollIntoView({ block: 'center' })");
await sleep(300);
const details = await evaluate(`({
  detail: window.__dmpIqRow.querySelector('.dmp-intel-detail')?.textContent,
  tierBadge: window.__dmpIqRow.querySelector('.dmp-tier')?.textContent,
  tierClass: window.__dmpIqRow.querySelector('.dmp-tier')?.className,
  itemCount: window.__dmpIqRow.querySelectorAll('.dmp-intel-item').length,
  dims: [...new Set([...window.__dmpIqRow.querySelectorAll('.dmp-intel-dim')].map(n => n.textContent))].slice(0, 12),
  hasItemsDetails: !!window.__dmpIqRow.querySelector('.dmp-intel-detail details'),
})`);

const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(new URL('./intelligence-ui-result.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));

const report = { picked, initial, running, tested, details, errors, consoleErrors };
console.log(JSON.stringify(report, null, 2));
ws.close();

const failures = [];
if (errors.length) failures.push('页面存在未捕获异常');
if (consoleErrors.length) failures.push('控制台错误: ' + consoleErrors.join(' | '));
if (running.label !== '■') failures.push('运行中按钮未切换为停止符');
if (!running.sub?.length) failures.push('运行中未显示检测提示');
if (tested.stopVisible) failures.push('完成后按钮仍显示停止符');
if (!tested.iqEnabled) failures.push('完成后 IQ 按钮未恢复可用');
if (!/智力检测: 智力值 \d+\/100 · \d+\/18 · \S+$/.test(tested.summary || '')) failures.push('结果摘要文案异常: ' + tested.summary);
if (details.itemCount !== 18) failures.push('逐题条目数应为 18，实际 ' + details.itemCount);
if (!details.hasItemsDetails) failures.push('缺少逐题明细区块');
if (!details.tierClass?.includes('dmp-tier-')) failures.push('缺少 tier 徽标样式');
if (!details.detail?.includes('金丝雀')) failures.push('详情缺少金丝雀结论');
if (!/思考 Token: (未计量 · 思考内容 \d+ 字符|\d+)/.test(details.detail || '')) failures.push('思考 Token 展示异常：' + (details.detail || '').slice(0, 120));
if (failures.length) {
  console.error('FAIL: ' + failures.join('; '));
  process.exitCode = 1;
}
