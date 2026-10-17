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
  const calls = [], saves = {}, kv = {}, etags = {};
  let version = 0;
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url]);
    const r = (status, body) => new Response(body == null ? null : body, { status });
    if (url.includes('/cloud-saves/')) {
      // Conditional writes like the platform: If-Match / If-None-Match after a
      // load, 412 with the current etag when stale, { etag } on success.
      const tail = decodeURIComponent(url.split('/cloud-saves/')[1]);
      const key = tail.replace(/\/info$/, '');
      const h = new Headers(init.headers || {});
      if (tail.endsWith('/info')) return r(200, JSON.stringify(saves[key] ? { exists: true, etag: etags[key] } : { exists: false }));
      if (method === 'PUT') {
        if ((h.get('If-Match') && h.get('If-Match') !== etags[key]) || (h.get('If-None-Match') === '*' && saves[key])) return r(412, JSON.stringify({ etag: etags[key] || null }));
        saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        etags[key] = '"v' + (++version) + '"';
        return r(200, JSON.stringify({ etag: etags[key] }));
      }
      return saves[key] ? r(200, saves[key]) : r(404);
    }
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'u', nickname: 'Tess' }));
    if (url.endsWith('/settings') && method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return r(200, '{}'); }
    if (url.endsWith('/settings')) return r(200, JSON.stringify({ settings: kv }));
    if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'hint', codes: ['KeyJ'] }] }));
    return r(404);
  };
  return { calls, saves, kv, etags, fetch, bump(key) { etags[key] = '"v' + (++version) + '"'; } };
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
  assert.deepEqual(await P.submitScore('longest-rally', 12), { posted: false, rank: null });
  assert.equal(srv.calls.length, 0);
});

test('sign-in is offered on a StarHermit UUID host without a token', async () => {
  const srv = fakeServer();
  install('', srv, '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com');
  const { Platform } = await import('../js/platform/host.js?uuid');
  const P = new Platform();
  await P.init();
  assert.equal(P.canSignIn(), true);
});

test('cloud-save conflict: a write that lost to another device is reported for a merge', async () => {
  const srv = fakeServer();
  const win = install('#game_token=' + token, srv, 'pp-slug.starhermit.com');
  const { Platform } = await import('../js/platform/host.js?conflict');
  const P = new Platform();
  await P.init();
  assert.equal(await P.flushCloudSave({ progress: { totals: { wins: 1 } } }), true);
  await P.loadCloud();                       // writes are conditional from here on
  srv.bump('game:pp-slug');                  // another device saved since
  let conflicts = 0;
  P.onSaveConflict = () => { conflicts++; };
  assert.equal(await P.flushCloudSave({ progress: { totals: { wins: 2 } } }), false);
  assert.equal(conflicts, 1);
  assert.equal(win.StarHermit.saveConflicted(), true);
  await P.loadCloud();                       // the re-read lifts the block
  assert.equal(await P.flushCloudSave({ progress: { totals: { wins: 3 } } }), true);
});

test('mergeProgress keeps the better result of each record', async () => {
  const { mergeProgress, defaultProgress } = await import('../js/session/storage.js');
  const a = defaultProgress(), b = defaultProgress();
  a.journey.j01 = { stars: 3, wins: 1 }; b.journey.j01 = { stars: 1, wins: 4 }; b.journey.j02 = { stars: 2, wins: 1 };
  a.challenges['c-economy'] = { cleared: true, best: '5-2' }; b.challenges['c-economy'] = { cleared: false };
  a.dailies['2026-10-01'] = { won: true, score: [5, 1] }; b.dailies['2026-10-02'] = { won: false, score: [2, 5] };
  a.achievements['first-win'] = { at: '2026-10-03', progress: 0 }; b.achievements['first-win'] = { at: '2026-10-01', progress: 0 };
  b.achievements.centurion = { at: null, progress: 40 }; a.achievements.centurion = { at: null, progress: 12 };
  a.streak = { current: 0, best: 6 }; b.streak = { current: 3, best: 3 };
  a.totals = { matches: 50, wins: 20, angledHits: 10, masteryCleared: 2 }; b.totals = { matches: 30, wins: 25, angledHits: 40, masteryCleared: 1 };
  a.leaderboards.local = [{ name: 'Al', score: 20, duration: 90 }]; b.leaderboards.local = [{ name: 'Al', score: 25, duration: 120 }];
  const m = mergeProgress(a, b);
  assert.deepEqual(m.journey, { j01: { stars: 3, wins: 4 }, j02: { stars: 2, wins: 1 } });
  assert.equal(m.challenges['c-economy'].cleared, true);
  assert.deepEqual(Object.keys(m.dailies).sort(), ['2026-10-01', '2026-10-02']);
  assert.equal(m.achievements['first-win'].at, '2026-10-01');
  assert.equal(m.achievements.centurion.progress, 40);
  assert.deepEqual(m.streak, { current: 3, best: 6 });
  assert.deepEqual(m.totals, { matches: 50, wins: 25, angledHits: 40, masteryCleared: 2 });
  assert.deepEqual(m.leaderboards.local, [{ name: 'Al', score: 25, duration: 90 }]);
});
