// Platform adapter over the shared StarHermit SDK: launch token, profile
// name, game:<slug> cloud-save round-trip, settings KV, controls, and no
// network at all when standalone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Load the shipped SDK copy as a classic script (the package is ESM).
const sdkModule = { exports: {} };
new Function('module', 'self', fs.readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(sdkModule, globalThis);
const SDK = sdkModule.exports;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = 'h.' + b64u({ sub: 'user-123456', game_scope: 'pp-slug', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';

// SDK renewal timers must not keep the test process alive.
const unrefTimeout = (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; };

function fakeServer() {
  const calls = [], saves = {}, kv = {};
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url]);
    const r = (status, body) => new Response(body == null ? null : body, { status });
    if (url.includes('/cloud-saves/')) {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (method === 'PUT') { saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return r(200, '{}'); }
      return saves[key] ? r(200, saves[key]) : r(404);
    }
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'u', nickname: 'Tess' }));
    if (url.endsWith('/settings') && method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return r(200, '{}'); }
    if (url.endsWith('/settings')) return r(200, JSON.stringify({ settings: kv }));
    if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'hint', codes: ['KeyJ'] }] }));
    return r(404);
  };
  return { calls, saves, kv, fetch };
}

function install(hash, srv, hostname = 'pp-slug.starhermit.com') {
  const win = {
    location: { hash, search: '', pathname: '/', hostname, origin: 'https://' + hostname, href: 'https://' + hostname + '/' },
    history: { replaceState() {} },
    addEventListener() {},
    parent: null,
  };
  win.StarHermit = SDK.create({ window: win, fetch: srv.fetch, setTimeout: unrefTimeout });
  globalThis.window = win;
  globalThis.location = win.location;
  globalThis.fetch = srv.fetch; // any direct request is counted too
  return win;
}

globalThis.document = { addEventListener() {}, visibilityState: 'visible' };

test('hosted: token, profile, cloud save game:<slug>, settings, controls', async () => {
  const srv = fakeServer();
  install('#game_token=' + token, srv, 'pp-slug.starhermit.com');
  const { Platform } = await import('../js/platform/host.js?hosted');
  const P = new Platform();
  await P.init();
  assert.equal(P.hosted, true);
  assert.equal(P.sub, 'user-123456');
  assert.equal(P.scope, 'pp-slug');
  assert.equal(await P.syncProfile(), 'Tess');

  assert.equal(await P.flushCloudSave({ settings: { language: 'auto' }, progress: { wins: 2 } }), true);
  assert.deepEqual(Object.keys(srv.saves), ['game:pp-slug']);
  assert.deepEqual(await P.loadCloud(), { settings: { language: 'auto' }, progress: { wins: 2 } });

  P.patchSettings({ audio: { muted: true } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(srv.kv.audio, { muted: true });
  assert.deepEqual(await P.getSettings(), { audio: { muted: true } });

  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'], serve: ['Space'] }), { hint: ['KeyJ'], serve: ['Space'] });
  assert.ok(P.inviteLink().endsWith('/game-invite/user-123456/pp-slug'));
  assert.equal(P.canSignIn(), false);
  // own-server routes are never called
  await P.syncTime();
  assert.ok(!srv.calls.some(([, u]) => /\/time|\/presence|\/activity|\/telemetry/.test(u)));
});

test('standalone (no token): no request at all', async () => {
  const srv = fakeServer();
  install('', srv, 'example.org');
  globalThis.window.parent = globalThis.window;
  const { Platform } = await import('../js/platform/host.js?standalone');
  const P = new Platform();
  await P.init();
  assert.equal(P.hosted, false);
  assert.equal(await P.syncProfile(), null);
  P.queueCloudSave({ v: 1 });
  assert.equal(await P.flushCloudSave({ v: 1 }), false);
  assert.equal(await P.loadCloud(), null);
  P.patchSettings({ audio: {} });
  assert.equal(await P.getSettings(), null);
  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  assert.equal(P.inviteLink(), null);
  assert.equal(P.canSignIn(), false);
  assert.equal(srv.calls.length, 0);
});
