// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Journey stage 1 and keeps playing with the on-screen Serve button and the ArrowLeft/ArrowRight
// keys — the ball flies, the trail, impact sparks, goal pulses, camera and dust motes all run. A finished
// match goes to Retry.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('[data-screen="title"]', { timeout: 30000 });
  await page.click('[data-action="open-settings"]');
  await page.waitForSelector('[data-screen="settings"] #gfx-preset', { timeout: 10000 });
  await page.locator('#gfx-section').scrollIntoViewIfNeeded();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset, { timeout: 10000 });
  await page.click('[data-screen="settings"] [data-action="back"]');
  await page.waitForSelector('[data-screen="settings"]', { state: 'detached', timeout: 5000 });
}

export async function start(page) {
  await page.click('[data-action="open-journey"]');
  await page.click('[data-action="journey-level"][data-id="j01"]');
  await page.click('[data-screen="setup"] [data-action="start-match"]');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
  let open = true, dir = 'ArrowLeft';
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        if (await page.locator('[data-screen="results"]').count()) {
          await page.click('[data-action="results-retry"]', { timeout: 3000 });
          await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
        } else if (await page.locator('#hud-serve').isEnabled().catch(() => false)) {
          await page.click('#hud-serve', { timeout: 2000 });
        } else {
          dir = dir === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
          await page.keyboard.down(dir);
          await page.waitForTimeout(320);
          await page.keyboard.up(dir);
        }
      } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(150).catch(() => {});
    }
  })();
  await page.waitForTimeout(3000);
}
