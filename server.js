import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PORT) || 8080;

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.opus': 'audio/ogg',
});

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url ?? '/').split('?')[0];
    if (!path.startsWith('/')) path = `/${path}`;
    if (path === '/') path = '/index.html';

    // Server-time sync (spec §6): round-trip-adjusted by js/platform/host.js.
    if (path === '/api/v1/time' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ now: Date.now() }));
      return;
    }

    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      // Path traversal attempt — never serve outside the project root.
      res.writeHead(404);
      res.end('Not Found\n');
      return;
    }
    const st = await stat(file);
    if (st.isDirectory()) throw Object.assign(new Error('directory'), { isDir: true });
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('Not Found\n');
  }
});

server.listen(PORT, () => console.log(`Paddle Pulse server listening on http://localhost:${PORT}`));

export default server;
