/**
 * Paddle Pulse — end-to-end playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → settings open/close → Graphics (Auto=Low, Ultra, High, bloom
 *   override, reload persistence, back to Auto) → journey grid → stage 1 setup → countdown →
 *   active play (real Serve-button clicks + ArrowLeft/ArrowRight movement)
 *   → pause/resume → full match to the results screen → verify replay →
 *   continue. Runs twice: desktop 1280x800 and mobile 390x844 (touch).
 *
 * All actions go through DOM elements a player sees (buttons, keys, canvas
 * pointer). DOM text (HUD score, serve-button disabled state) is read only
 * for synchronization/timing — never to mutate game state.
 *
 * Serves the repo with its own dev static server (server.js, spawned on an
 * ephemeral port). A standalone load must make zero same-origin /api or /ws
 * requests.
 * Fails loudly on any non-benign console error / pageerror.
 *
 * Run: npm run test:e2e
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { stubStarHermit, launchToken } from './starhermit-e2e.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/paddle-pulse-e2e-${stage}-${vp}.png`;
// Language-step screenshots go to E2E_SHOT_DIR (default: the OS temp dir).
const LANG_SHOT = (name) => join(process.env.E2E_SHOT_DIR || tmpdir(), `paddle-pulse-e2e-${name}.png`);
let apiStubbed = false;   // only the language step stubs the StarHermit API on this origin

// Benign GPU/swiftshader console noise (same regex as tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

async function waitServerUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('dev server did not start: ' + serverErr);
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

const errors = [];
const step = async (name, fn) => {
  await fn();
  console.log(`ok - ${name}`);
};

async function playMatch(page, vp) {
  // Play journey stage 1 to a terminal results screen using only the visible
  // UI: click the HUD Serve button whenever it is enabled, otherwise sweep
  // the paddle with real ArrowLeft/ArrowRight key presses.
  const resultsSel = '[data-screen="results"]';
  let lastScore = '';
  let paused = false;
  let playShot = false;
  const deadline = Date.now() + 240000;
  let dir = 'ArrowLeft';

  while (Date.now() < deadline) {
    if (await page.locator(resultsSel).count()) break;

    // Exercise pause/resume once, early in the match.
    if (!paused) {
      await page.click('#hud-pause');
      await page.waitForSelector('[data-screen="pause"]', { timeout: 5000 });
      await page.screenshot({ path: SHOT('pause', vp) });
      await page.click('[data-screen="pause"] [data-action="resume"]');
      // Resume replays the countdown (~2s) before phase returns to active.
      await page.waitForSelector('[data-screen="pause"]', { state: 'detached', timeout: 5000 });
      await page.waitForTimeout(2600);
      paused = true;
      console.log('ok - pause/resume during live match');
    }

    const serve = page.locator('#hud-serve');
    if (await serve.isEnabled().catch(() => false)) {
      await serve.click();
    } else {
      dir = dir === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
      await page.keyboard.down(dir);
      await page.waitForTimeout(320);
      await page.keyboard.up(dir);
    }

    const score = (await page.textContent('#hud-score').catch(() => ''))?.trim();
    if (score && score !== lastScore) {
      console.log(`  score: ${score}`);
      lastScore = score;
    }
    if (!playShot && lastScore) {
      await page.screenshot({ path: SHOT('play', vp) });
      playShot = true;
    }
    await page.waitForTimeout(120);
  }

  if (!(await page.locator(resultsSel).count())) {
    throw new Error(`match did not reach results within timeout (last score ${lastScore || '0 – 0'})`);
  }
  if (!lastScore) throw new Error('no points were scored during the match');
}

async function runPass(vpName, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[${vpName}] pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!apiStubbed && u.origin === BASE && /^\/(api|ws)(\/|$)/.test(u.pathname)) errors.push(`[${vpName}] own-server request: ${r.method()} ${u.pathname}`);
  });
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) {
      errors.push(`[${vpName}] console: ${m.text()}`);
    }
  });

  try {
    await step(`[${vpName}] load → title screen`, async () => {
      await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('[data-screen="title"]', { timeout: 15000 });
      await page.waitForSelector('[data-action="quick-play"]:visible', { timeout: 5000 });
      await page.screenshot({ path: SHOT('title', vpName) });
    });

    await step(`[${vpName}] settings open/close`, async () => {
      await page.click('[data-action="open-settings"]');
      await page.waitForSelector('[data-screen="settings"]', { timeout: 5000 });
      // Toggle a real checkbox and confirm it applies to the document.
      await page.click('[data-setting="accessibility.reducedMotion"]');
      const applied = await page.evaluate(() => document.body.classList.contains('reduced-motion'));
      if (!applied) throw new Error('reduced-motion setting did not apply to <body>');
      await page.click('[data-setting="accessibility.reducedMotion"]'); // restore
      await page.screenshot({ path: SHOT('settings', vpName) });
      await page.click('[data-screen="settings"] [data-action="back"]');
      await page.waitForSelector('[data-screen="settings"]', { state: 'detached', timeout: 5000 });
    });

    await step(`[${vpName}] settings → Graphics: presets, override, persistence`, async () => {
      const preset = () => page.evaluate(() => document.body.dataset.gfxPreset);
      const openGfx = async () => {
        await page.click('[data-action="open-settings"]');
        await page.waitForSelector('[data-screen="settings"] #gfx-preset', { timeout: 5000 });
        await page.locator('#gfx-section').scrollIntoViewIfNeeded();
      };
      await openGfx();
      // Headless software GPU → Auto resolves to Low.
      if ((await preset()) !== 'low') throw new Error(`auto preset on software GPU: ${await preset()}`);
      const autoLabel = await page.locator('#gfx-preset option[value="auto"]').textContent();
      if (!/Low/.test(autoLabel || '')) throw new Error(`auto label: ${autoLabel}`);
      await page.selectOption('#gfx-preset', 'ultra');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'ultra', null, { timeout: 10000 });
      await page.waitForTimeout(1200); // a few Ultra frames (full post chain) must not log anything
      await page.selectOption('#gfx-preset', 'high');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'high', null, { timeout: 10000 });
      const shadowLabel = await page.locator('#gfx-shadows option[value="preset"]').textContent();
      if (!/Medium/.test(shadowLabel || '')) throw new Error(`"From preset" label did not follow High: ${shadowLabel}`);
      await page.selectOption('#gfx-bloom', 'off');
      await page.waitForFunction(() => {
        const t = document.getElementById('gfx-summary')?.textContent || '';
        return /floor reflections/.test(t) && !/bloom/.test(t);
      }, null, { timeout: 10000 });
      await page.screenshot({ path: SHOT('graphics', vpName) });
      await page.click('[data-screen="settings"] [data-action="back"]');

      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('[data-screen="title"]', { timeout: 15000 });
      if ((await preset()) !== 'high') throw new Error(`preset after reload: ${await preset()}`);
      await openGfx();
      if ((await page.inputValue('#gfx-preset')) !== 'high') throw new Error('preset select did not persist');
      if ((await page.inputValue('#gfx-bloom')) !== 'off') throw new Error('bloom override did not persist');
      // Choosing a preset clears overrides; back to Auto keeps the match fast.
      await page.selectOption('#gfx-preset', 'auto');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'low', null, { timeout: 10000 });
      if ((await page.inputValue('#gfx-bloom')) !== 'preset') throw new Error('preset change did not clear the bloom override');
      await page.click('[data-screen="settings"] [data-action="back"]');
      await page.waitForSelector('[data-screen="settings"]', { state: 'detached', timeout: 5000 });
    });

    await step(`[${vpName}] journey grid → stage 1 setup`, async () => {
      await page.click('[data-action="open-journey"]');
      await page.waitForSelector('[data-screen="journey"]', { timeout: 5000 });
      const nodes = await page.locator('[data-action="journey-level"]').count();
      if (nodes !== 40) throw new Error(`expected 40 journey stages, got ${nodes}`);
      const unlocked = await page.locator('[data-action="journey-level"]:not(.locked)').count();
      if (unlocked !== 1) throw new Error(`expected exactly stage 1 unlocked, got ${unlocked}`);
      await page.screenshot({ path: SHOT('journey', vpName) });
      await page.click('[data-action="journey-level"][data-id="j01"]');
      await page.waitForSelector('[data-screen="setup"]', { timeout: 5000 });
      await page.screenshot({ path: SHOT('setup', vpName) });
    });

    await step(`[${vpName}] start match → countdown → active HUD`, async () => {
      await page.click('[data-screen="setup"] [data-action="start-match"]');
      await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
      // Countdown is 3 × 650ms; wait for the serve phase to become possible.
      await page.waitForFunction(
        () => !document.getElementById('hud-serve').disabled
          || document.getElementById('hud-countdown').textContent === '',
        null,
        { timeout: 15000 },
      );
    });

    await step(`[${vpName}] play full match to results`, async () => {
      await playMatch(page, vpName);
      const headline = (await page.textContent('.result-headline'))?.trim();
      if (!/Victory|Defeat|Conceded/.test(headline || '')) {
        throw new Error(`unexpected results headline: ${headline}`);
      }
      const rows = await page.locator('.breakdown tbody tr').count();
      if (rows < 5) throw new Error(`expected score breakdown rows, got ${rows}`);
      console.log('  headline:', headline);
      await page.screenshot({ path: SHOT('results', vpName) });
    });

    await step(`[${vpName}] verify replay → continue`, async () => {
      await page.click('[data-action="results-verify"]');
      // Achievement toasts may already be visible; wait for the replay one.
      const toast = page.locator('.toast.show', { hasText: /Replay/ });
      await toast.waitFor({ state: 'visible', timeout: 6000 });
      const text = (await toast.first().textContent())?.trim();
      if (!/Replay verified/.test(text || '')) throw new Error(`replay verify toast: ${text}`);
      await page.click('[data-action="results-next"]');
      // Win → next stage setup; loss → modes grid. Both are valid exits.
      await page.waitForSelector('[data-screen="setup"], [data-screen="modes"]', { timeout: 8000 });
    });

    await step(`[${vpName}] language: Automatic follows the StarHermit preferred language; switching mid-match re-renders in place, syncs ui.language; report a problem`, async () => {
      apiStubbed = true;
      const calls = await stubStarHermit(page, { preferredLanguage: 'fr-CA' });
      await page.goto('about:blank');
      await page.goto(`${BASE}/index.html#game_token=${launchToken()}`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.lang === 'fr-CA', null, { timeout: 10000 });
      await page.waitForSelector('[data-screen="title"]', { timeout: 15000 });
      if (!/Jouer/i.test(await page.textContent('[data-action="quick-play"]'))) throw new Error('title not in French');
      await page.click('[data-action="open-journey"]');
      await page.waitForSelector('[data-screen="journey"] h3.chapter', { timeout: 5000 });
      if ((await page.textContent('[data-screen="journey"] h3.chapter')).trim() !== 'Allumage') throw new Error('journey content not in French');
      await page.click('[data-action="journey-level"][data-id="j01"]');
      await page.waitForSelector('[data-screen="setup"]', { timeout: 5000 });
      if (!/Premier contact/.test(await page.textContent('[data-screen="setup"] h2'))) throw new Error('stage title not in French');
      await page.click('[data-screen="setup"] [data-action="start-match"]');
      await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
      await page.waitForFunction(() => document.getElementById('hud-countdown').textContent === '', null, { timeout: 15000 });
      const seed = await page.textContent('#hud-score');
      await page.click('#hud-pause');
      await page.waitForSelector('[data-screen="pause"]', { timeout: 5000 });
      await page.click('[data-screen="pause"] [data-action="open-settings"]');
      await page.waitForSelector('[data-screen="settings"]', { timeout: 5000 });
      const choice = page.locator('[data-game-language="choice"]');
      await choice.scrollIntoViewIfNeeded();
      const autoLabel = await choice.locator('option').first().textContent();
      if (autoLabel !== 'Automatique — Français (Canada)') throw new Error('Automatic label not resolved: ' + autoLabel);
      if (await page.locator('[data-setting="language"]').count()) throw new Error('two language selectors');
      await choice.selectOption('de-DE');
      await page.waitForFunction(() => document.documentElement.lang === 'de-DE');
      await page.waitForFunction(() => /Im Konto gespeichert/.test(document.querySelector('[data-game-language="status"]').textContent));
      if (calls.settings['ui.language']?.choice !== 'de-DE') throw new Error('ui.language not saved: ' + JSON.stringify(calls.settings));
      if ((await page.textContent('[data-screen="settings"] h2')).trim() !== 'Einstellungen') throw new Error('settings not re-rendered');
      if (!/Qualität/.test(await page.textContent('#gfx-box'))) throw new Error('graphics box not re-rendered');
      if ((await page.locator('#gfx-section [data-game-options-fps]').count()) !== 1) throw new Error('shared sections lost or duplicated');
      await page.locator('[data-game-report="title"]').scrollIntoViewIfNeeded();
      await page.fill('[data-game-report="title"]', 'Test report');
      await page.click('[data-game-report="send"]');
      await page.waitForFunction(() => /Bericht gesendet/.test(document.querySelector('[data-game-report="status"]').textContent));
      if (!calls.reports?.[0] || calls.reports[0].kind !== 'bug') throw new Error('report not posted');
      await page.locator('[data-screen="settings"] h2').scrollIntoViewIfNeeded();
      await page.screenshot({ path: LANG_SHOT('settings-' + vpName) });
      await page.click('[data-screen="settings"] [data-action="back"]');
      await page.waitForSelector('[data-screen="pause"]', { timeout: 5000 });
      if (!/Lerne die Arena kennen/.test(await page.textContent('[data-screen="pause"]'))) throw new Error('pause objective not re-rendered');
      await page.click('[data-screen="pause"] [data-action="resume"]');
      await page.waitForFunction(() => document.getElementById('hud-countdown').textContent === '', null, { timeout: 15000 });
      if ((await page.textContent('#hud-score')) !== seed) throw new Error('language change restarted the match');
      if ((await page.textContent('#hud-pause')).trim() !== 'Pause' || !/Aufschlag/.test(await page.textContent('#hud-serve'))) throw new Error('HUD not re-rendered');
      for (const id of ['hud-serve', 'hud-pause']) {
        const ok = await page.locator('#' + id).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5 && (hit === el || el.contains(hit));
        });
        if (!ok) throw new Error(`#${id} covered or cut off in German`);
      }
      await page.screenshot({ path: LANG_SHOT('hud-' + vpName) });
      await page.click('#hud-pause');
      await page.click('[data-screen="pause"] [data-action="open-settings"]');
      await choice.scrollIntoViewIfNeeded();
      await choice.selectOption('auto');
      await page.waitForFunction(() => document.documentElement.lang === 'fr-CA');
      await page.click('[data-screen="settings"] [data-action="back"]');
      await page.click('[data-screen="pause"] [data-action="leave-match"]');
      await page.waitForSelector('[data-screen="modes"]', { timeout: 5000 });
      await page.unroute(/\/api\/v1\//);
      apiStubbed = false;
    });

    // Fail fast between passes if this pass produced errors.
    if (errors.length) throw new Error('page errors during pass:\n' + errors.join('\n'));
  } finally {
    await context.close();
  }
}

try {
  await waitServerUp();
  await runPass('desktop', { viewport: { width: 1280, height: 800 } });
  await runPass('mobile', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  if (errors.length) {
    console.error('\nPAGE ERRORS:\n' + errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('\nE2E PASS — paddle-pulse playable end-to-end on desktop + mobile, no page errors');
  }
} catch (err) {
  console.error('\nE2E FAIL:', err.message || err);
  if (errors.length) console.error('PAGE ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
