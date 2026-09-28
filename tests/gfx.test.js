// Graphics quality model (js/render/gfx.js): GPU detection, preset
// resolution, overrides, render-scale clamping, and preset-clears-overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, CATEGORIES, detectPreset, resolve, presetTier, withPreset, describe } from '../js/render/gfx.js';
import { migrateSettings } from '../js/session/storage.js';

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon RX 6700 XT)'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620)'), 'balanced');
  assert.equal(detectPreset('Mali-G78'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  // Touch-only devices cap Auto at Balanced.
  assert.equal(detectPreset('Apple M2', { touch: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { touch: true }), 'low');
});

test('resolve: auto follows the detected preset, explicit preset wins', () => {
  const auto = resolve({ preset: 'auto' }, 'low');
  assert.equal(auto.preset, 'low');
  assert.equal(auto.auto, true);
  assert.equal(auto.post, false, 'Low draws without a post chain');
  assert.equal(auto.shadows, 'off');
  const high = resolve({ preset: 'high' }, 'low');
  assert.equal(high.preset, 'high');
  assert.equal(high.auto, false);
  assert.equal(high.post, true);
  for (const cat of Object.keys(CATEGORIES)) assert.equal(high[cat], presetTier('high', cat));
  assert.equal(resolve({}, undefined).preset, 'balanced', 'unknown detection falls back to balanced');
});

test('resolve: per-category overrides and invalid values', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'high', ao: 'bogus' }, 'high');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'high');
  assert.equal(r.ao, 'off', 'invalid override falls back to the preset tier');
  assert.equal(r.post, true, 'bloom override turns the post chain on');
  assert.equal(resolve({ preset: 'low', antialias: 'msaa' }, 'low').post, true, 'MSAA uses a multisampled post target');
});

test('resolve: render scale multiplies the preset scale and clamps to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 1.5 }).scale, 1.5);
  assert.equal(resolve({ preset: 'high', render_scale: 9 }).scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).scale, 0.5);
  assert.equal(resolve({ preset: 'low', render_scale: 1 }).scale, 0.85);
  assert.equal(resolve({ preset: 'high' }).adaptive, true, 'adaptive defaults on');
  assert.equal(resolve({ preset: 'high' }).showFps, false, 'fps readout defaults off');
  assert.equal(resolve({ preset: 'high', adaptive: false, show_fps: true }).adaptive, false);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
  const saved = { preset: 'low', bloom: 'on', detail: 'detailed', render_scale: 1.2, adaptive: false, trails: true };
  const next = withPreset(saved, 'ultra');
  assert.equal(next.preset, 'ultra');
  for (const cat of Object.keys(CATEGORIES)) assert.equal(next[cat], undefined, `${cat} cleared`);
  assert.equal(next.render_scale, 1.2);
  assert.equal(next.adaptive, false);
  assert.equal(next.trails, true);
  assert.deepEqual(PRESETS, ['low', 'balanced', 'high', 'ultra']);
});

test('describe summarises cost with pixel size', () => {
  assert.equal(describe(resolve({ preset: 'low' }), [640, 400]), 'no shadows · no anti-aliasing · 640×400 px');
  assert.match(describe(resolve({ preset: 'ultra' })), /2048² shadows · full ambient occlusion · bloom · floor reflections · MSAA/);
});

test('settings migration maps the old single quality tier', () => {
  assert.equal(migrateSettings({ graphics: { tier: 'medium', bloom: true, trails: false } }).graphics.preset, 'balanced');
  const m = migrateSettings({ graphics: { tier: 'high' } }).graphics;
  assert.equal(m.preset, 'high');
  assert.equal(m.tier, undefined);
  assert.equal(migrateSettings({ graphics: { tier: 'auto' } }).graphics.preset, 'auto');
  assert.equal(migrateSettings(null).graphics.preset, 'auto');
});
