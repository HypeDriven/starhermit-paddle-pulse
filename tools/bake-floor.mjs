// Bakes the detailed look's brushed-panel floor textures (the browser build's
// js/render/scene.js floorTexture, run unchanged pixel for pixel: seams plus a
// speckle seeded from the theme's floor colour; R and B the albedo variation,
// G the roughness) into assets/textures/floor-<theme>-<size>.png, as the
// per-pixel painting is too slow for the engine's interpreter at start.
// Run after changing themes: node tools/bake-floor.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES } from '../js/content/themes.js';
import { createRng, next } from '../js/rules/rng.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
for (const theme of Object.values(THEMES)) {
  for (const size of [256, 512]) {
    const rgb = Buffer.alloc(size * size * 3);
    const rng = createRng(0xf100 ^ (theme.floor & 0xffff));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 3;
        const seam = x % (size / 2) < 3 * size / 256 || y % (size / 2) < 3 * size / 256;
        const n = next(rng) * 0.12 + Math.sin((x + y * 0.35) * 0.4) * 0.02;
        const v = seam ? 0.35 : 0.78 + n;
        const r = seam ? 0.45 : 0.72 + n * 1.5;
        rgb[i] = rgb[i + 2] = Math.round(255 * Math.min(1, v));
        rgb[i + 1] = Math.round(255 * Math.min(1, r));
      }
    }
    writeFileSync(join(root, 'assets/textures', `floor-${theme.id}-${size}.png`), png(size, size, rgb));
  }
}
console.log('baked', Object.keys(THEMES).length * 2, 'floor textures');
