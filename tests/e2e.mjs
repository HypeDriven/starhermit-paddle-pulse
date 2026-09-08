/**
 * Paddle Pulse — end-to-end playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → settings open/close → journey grid → stage 1 setup → countdown →
 *   active play (real Serve-button clicks + ArrowLeft/ArrowRight movement)
 *   → pause/resume → full match to the results screen → verify replay →
 *   continue. Runs twice: desktop 1280x800 and mobile 390x844 (touch).
 *
 * All actions go through DOM elements a player sees (buttons, keys, canvas
 * pointer). DOM text (HUD score, serve-button disabled state) is read only
 * for synchronization/timing — never to mutate game state.
 *
 * Serves the repo with its own dev static server (server.js, spawned on an
 * ephemeral port) so the platform API stubs (/api/v1/*) behave as in dev.
 * Fails loudly on any non-benign console error / pageerror.
 *
 * Run: npm run test:e2e
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/paddle-pulse-e2e-${stage}-${vp}.png`;

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
      const res = await fetch(BASE + '/api/v1/time');
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
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) {
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
