import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PORT) || 8080;

// In-memory dev stand-in for the platform cloud-save slot (keyed by game).
const cloudSaves = new Map();

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

    // Local stand-ins for the platform routes the client calls when served
    // by this server (presence heartbeat, activity pairing, telemetry
    // batch). The dev server has no backing store, so these accept and
    // acknowledge without persisting. The cloud-save slot below does keep an
    // in-memory copy per game key so the client can exercise GET/PUT.
    if (path.startsWith('/api/v1/me/cloud-saves/')) {
      const key = decodeURIComponent(path.slice('/api/v1/me/cloud-saves/'.length));
      if (req.method === 'PUT') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        try {
          cloudSaves.set(key, JSON.parse(raw).dataBase64 || '');
        } catch { /* malformed body: ignore */ }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end('{}');
        return;
      }
      if (req.method === 'GET') {
        const dataBase64 = cloudSaves.get(key);
        if (dataBase64 == null) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end('{"error":"no save"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store' });
        res.end(Buffer.from(dataBase64, 'base64'));
        return;
      }
    }
    if (path.startsWith('/api/v1/')) {
      // Consume the request body before responding: replying while the
      // client is still uploading makes Chrome abort the request
      // (net::ERR_ABORTED) even though the response itself is fine.
      for await (const _ of req) { /* discard */ }
      // Acknowledge with 200 + a JSON body, not 204: Chrome reports
      // net::ERR_ABORTED for POST fetches answered with 204 No Content.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end('{}');
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
