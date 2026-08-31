// Browser-facing smoke test: boots server.js on a random port and verifies
// the shell, every JS asset (transitively imported), the time endpoint,
// local-only resources, and path-traversal rejection. Exits non-zero with
// clear messages on any failure.

import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8200 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;

const failures = [];
const ok = (cond, msg) => {
  if (cond) console.log(`ok   ${msg}`);
  else {
    failures.push(msg);
    console.error(`FAIL ${msg}`);
  }
};

async function get(path) {
  const res = await fetch(BASE + path);
  const body = await res.text();
  return { status: res.status, body, type: res.headers.get('content-type') || '' };
}

// Collect every file under js/ plus known entry assets.
async function collectJsFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const server = spawn(process.execPath, [join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Wait for the server to accept connections.
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

try {
  if (!(await waitUp())) throw new Error('server did not start');

  // Shell + core assets.
  const index = await get('/');
  ok(index.status === 200 && index.body.includes('<'), 'GET / returns 200 HTML');
  for (const path of ['/style.css', '/js/main.js', '/vendor/three.module.js', '/index.html']) {
    const r = await get(path);
    ok(r.status === 200, `GET ${path} returns 200`);
  }

  // Every JS module under js/ must be served.
  const jsFiles = await collectJsFiles(join(ROOT, 'js'));
  for (const full of jsFiles) {
    const rel = '/' + full.slice(ROOT.length).replace(/\\/g, '/').replace(/^\/+/, '');
    const r = await get(rel);
    ok(r.status === 200, `GET ${rel} returns 200`);
  }

  // No external network resources in the shell, stylesheet, or bootstrap.
  for (const [name, text] of [
    ['index.html', index.body],
    ['style.css', (await get('/style.css')).body],
    ['js/main.js', (await get('/js/main.js')).body],
  ]) {
    ok(!/https?:\/\//.test(text), `${name} references no external http(s) URLs`);
  }

  // Server time endpoint (js/platform/host.js expects { now: <ms epoch> }).
  const time = await get('/api/v1/time');
  let timeOk = false;
  try {
    const body = JSON.parse(time.body);
    timeOk = time.status === 200 && Number.isFinite(body.now) && Math.abs(body.now - Date.now()) < 60000;
  } catch { /* handled below */ }
  ok(timeOk, 'GET /api/v1/time returns valid JSON { now }');

  // Path traversal must never escape the project root. (A literal "/../" is
  // normalized away by the HTTP client, so use encoded separators.)
  for (const path of ['/..%2fpackage.json', '/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
    const r = await fetch(BASE + path, { redirect: 'manual' }).then((res) => res.status).catch(() => 0);
    ok(r === 404 || r === 400, `traversal ${path} rejected (got ${r})`);
  }
} catch (err) {
  failures.push(String(err));
  console.error('FAIL', err);
} finally {
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nbrowser smoke: all checks passed');
process.exit(0);
