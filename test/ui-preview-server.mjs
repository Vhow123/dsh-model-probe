import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamPort = Number(process.env.DMP_UPSTREAM_PORT || 50206);
const upstreamHost = process.env.DMP_UPSTREAM_HOST || '127.0.0.1';
const listenPort = Number(process.env.DMP_LISTEN_PORT || 8765);

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const target = pathname.slice('/proxy'.length);
    try {
      const upstream = await fetch(`http://${upstreamHost}:${upstreamPort}${target}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: String(error?.message || error) }));
    }
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
server.listen(listenPort, '127.0.0.1', () => console.log(`UI preview: http://127.0.0.1:${listenPort} -> upstream 127.0.0.1:${upstreamPort}`));
