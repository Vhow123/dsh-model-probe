const target = (await (await fetch('http://127.0.0.1:9223/json/list')).json()).find(item => item.type === 'page' && item.url === 'http://127.0.0.1:8765/');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id === 1) {
    console.log(JSON.stringify(message, null, 2));
    ws.close();
  }
};
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'location.reload(); true', returnByValue: true } }));
