import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const target = pathname.slice('/proxy'.length);
    const upstream = await fetch(`http://127.0.0.1:56215${target}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
    return;
  }
  const filename = pathname === '/' ? 'test/ui-preview.html' : pathname.slice(1);
  try {
    const data = await readFile(path.join(root, filename));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[path.extname(filename)] || 'text/plain' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(8765, '127.0.0.1', () => console.log('UI preview: http://127.0.0.1:8765'));
