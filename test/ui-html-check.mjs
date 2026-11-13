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
await sleep(600);
errors.length = 0;
consoleErrors = [];

for (let i = 0; i < 60; i++) {
  if (await evaluate("document.querySelectorAll('.dmp-model').length") > 0) break;
  await sleep(200);
}

// 切到 HTML 动画检测
const switched = await evaluate(`(() => {
  const select = document.querySelector('.dmp-select');
  const option = [...select.options].find(o => o.value === 'svg-html');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(select, 'svg-html');
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return option ? option.textContent : null;
})()`);
await sleep(400);
const afterSwitch = await evaluate(`({
  value: document.querySelector('.dmp-select')?.value,
  hasPrompt: !!document.getElementById('dmp-custom-svg-prompt'),
  prompt: document.getElementById('dmp-custom-svg-prompt')?.value,
  placeholder: document.getElementById('dmp-custom-svg-prompt')?.placeholder,
  hint: document.querySelector('.dmp-custom-hint')?.textContent,
  footer: document.querySelector('.dmp-foot')?.textContent,
})`);

// 用内置摘要（不填提示词）跑 deepseek-flash
const picked = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.dmp-model')];
  const row = rows.find(r => r.textContent.includes('deepseek-flash')) || rows[0];
  window.__dmpHtmlRow = row;
  row.querySelectorAll('.dmp-detail-btn')[0].click();
  return row.querySelector('.dmp-model-name')?.textContent;
})()`);

let done = false;
for (let i = 0; i < 3600; i++) {
  const state = await evaluate("window.__dmpHtmlRow.querySelector('.dmp-html-metrics') ? 'ready' : window.__dmpHtmlRow.querySelector('.dmp-error-text, .dmp-badge-error') ? 'error' : 'running'");
  if (state === 'ready') { done = true; break; }
  if (state === 'error') break;
  await sleep(250);
}
if (!done) throw new Error('HTML 绘图检测未产出结果');

await evaluate("window.__dmpHtmlRow.scrollIntoView({ block: 'center' })");
await sleep(400);
const card = await evaluate(`({
  summary: window.__dmpHtmlRow.querySelector('.dmp-model-sub')?.textContent,
  pills: [...window.__dmpHtmlRow.querySelectorAll('.dmp-metric-pill')].map(n => ({ text: n.textContent, cls: n.className })),
  warn: window.__dmpHtmlRow.querySelector('.dmp-html-warn')?.textContent,
  caption: window.__dmpHtmlRow.querySelector('.dmp-svg-caption')?.textContent,
  frameHeight: getComputedStyle(window.__dmpHtmlRow.querySelector('.dmp-html-frame')).height,
  frameMinHeight: getComputedStyle(window.__dmpHtmlRow.querySelector('.dmp-html-frame')).minHeight,
  sandbox: window.__dmpHtmlRow.querySelector('.dmp-html-frame')?.getAttribute('sandbox'),
  hasSource: !!window.__dmpHtmlRow.querySelector('.dmp-svg-source'),
  runningLabel: window.__dmpHtmlRow.querySelectorAll('.dmp-detail-btn')[0].textContent,
})`);

const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(new URL('./html-ui-result.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));

console.log(JSON.stringify({ switched, afterSwitch, picked, card, errors, consoleErrors }, null, 2));
ws.close();

const failures = [];
const labels = card.pills.map(p => p.text);
if (errors.length) failures.push('页面存在未捕获异常');
if (consoleErrors.length) failures.push('控制台错误: ' + consoleErrors.join(' | '));
if (afterSwitch.value !== 'svg-html') failures.push('测试类型未切换到 svg-html');
if (!afterSwitch.hasPrompt) failures.push('HTML 模式没有提示词输入框');
if ((afterSwitch.prompt || '').trim()) failures.push('切到 HTML 模式后提示词未清空，会覆盖内置摘要: ' + afterSwitch.prompt);
if (!/鹈鹕/.test(afterSwitch.placeholder || '')) failures.push('HTML 模式占位符没有提示默认是鹈鹕测试: ' + afterSwitch.placeholder);
if (!/鹈鹕/.test(afterSwitch.hint || '')) failures.push('HTML 模式说明没有提示默认是鹈鹕测试: ' + afterSwitch.hint);
if (card.pills.length !== 4) failures.push('度量徽章应为 4 项，实际 ' + card.pills.length);
if (!/^动画 [是否]$/.test(labels[0] || '')) failures.push('动画徽章异常: ' + labels[0]);
if (!/^配色 \d+$/.test(labels[1] || '')) failures.push('配色徽章异常: ' + labels[1]);
if (!/^画幅溢出 (\d+(\.\d+)?%|—)$/.test(labels[2] || '')) failures.push('溢出徽章异常: ' + labels[2]);
if (!/^外部资源 无$/.test(labels[3] || '')) failures.push('外部资源徽章异常: ' + labels[3]);
if (!/^\d+ 处 SMIL 动画 · \d+ 处 CSS 动画 · \d+ 个元素 · [\d.]+ KiB$/.test(card.caption || '')) failures.push('度量说明行异常: ' + card.caption);
if (card.frameMinHeight !== '220px') failures.push('预览最小高度应为 220px，实际 ' + card.frameMinHeight);
if (card.sandbox !== '') failures.push('预览 iframe 未禁用权限: ' + card.sandbox);
if (card.runningLabel !== '▶') failures.push('完成按钮未恢复: ' + card.runningLabel);
if (failures.length) {
  console.error('FAIL: ' + failures.join('; '));
  process.exitCode = 1;
}
