// Sound, as the browser build's js/audio/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per logical event — paddle hit, wall
// bounce, bumper, serve, serve ready, goal, match end, rejected action, the
// countdown tick and go, UI clicks (click, back, open, error, unlock, star)
// and the undo rewind — plus the theme's quiet ambience (a sine an octave
// under the theme's root and a slightly sharp triangle on it, breathing with a
// 0.07 Hz swell) and the adaptive music (96 bpm: a sine bass pulse on the root
// every bar, a triangle fifth pad every second bar, a square arpeggio walking
// the theme's pentatonic scale on the off-beat, its stems' levels following
// the match's intensity: the ball's speed). The browser build ran ambience and
// music live (oscillators on a timer); here they are rendered once per theme
// into clips (createClip, a slice a frame: 16 bars of the seeded walk, looped)
// and played on the music bus, the stem levels set each frame (the runtime has
// no ambience bus: the bed folds in the old ambience slider's 50 % against
// music's 70 %). The oscillator blips the browser build synthesized while a
// sample decoded are not ported (a live synthesis graph makes clip loads fail
// on the engine's web runtime), so a clip still loading is silent. The
// runtime's Options own the volumes and the voice limit; Settings › Mute all
// silences the game's sounds as before. Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

const SFX: Record<string, [string, number]> = {
  "event:paddle": ["paddle-hit", 0.8], "event:wall": ["wall-bounce", 0.6], "event:bumper": ["bumper-bounce", 0.7],
  "event:serve": ["serve-launch", 0.7], "event:serve-ready": ["serve-ready", 0.5], "event:goal": ["goal-scored", 0.8],
  "event:match-end": ["match-end", 0.8], "event:invalid": ["invalid-action", 0.6],
  "ui:click": ["ui-click", 0.6], "ui:back": ["ui-back", 0.6], "ui:open": ["ui-open", 0.6], "ui:error": ["ui-error", 0.6],
  "ui:unlock": ["ui-unlock", 0.6], "ui:star": ["ui-star", 0.6],
  "countdown:tick": ["countdown-tick", 0.6], "countdown:go": ["countdown-go", 0.7], undo: ["undo-rewind", 0.6],
};
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;
let muted = false;
let onCaption: ((cue: string) => void) | null = null;

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
/** Captions for meaningful sounds (audio.js caption()): the cue ids '[serve]', '[goal for you]', … */
export function setOnCaption(fn: (cue: string) => void): void { onCaption = fn; }
export function setMuted(on: boolean): void { muted = on; }
/** A hidden window: everything quiet (audio.js suspend / resume). */
export function setSuspended(on: boolean): void { suspended = on; }

function sample(key: string): void {
  if (suspended || muted) return;
  const s = SFX[key];
  if (!s) return;
  const clip = clips.get(s[0]);
  if (!clip) return;
  try { playClip(clip, { bus: key.startsWith("ui:") ? "interface" : "effects", gain: s[1] }); }
  catch { clips.delete(s[0]); if (!queue.includes(s[0])) queue.push(s[0]); } // a clip the mixer lost: load it again
}
function caption(cue: string): void { onCaption?.(cue); }

/** audio.js event(e): a rules event's sound and caption. */
export function event(e: { t: string; player?: number; winner?: number }): void {
  switch (e.t) {
    case "paddle": sample("event:paddle"); break;
    case "wall": sample("event:wall"); break;
    case "bumper": sample("event:bumper"); break;
    case "serve": sample("event:serve"); caption("[serve]"); break;
    case "serve-ready": sample("event:serve-ready"); break;
    case "goal": sample("event:goal"); caption(e.player === 0 ? "[goal for you]" : "[goal conceded]"); break;
    case "match-end": sample("event:match-end"); caption(e.winner === 0 ? "[victory]" : "[defeat]"); break;
    case "invalid": sample("event:invalid"); caption("[action not allowed]"); break;
    default: break;
  }
}
/** audio.js ui(name): click, back, open, error, unlock, star. */
export function ui(name: string): void { sample(`ui:${name}`); }
/** audio.js countdown(n): a tick for 3, 2, 1, then go. */
export function countdown(n: number): void {
  if (n > 0) { sample("countdown:tick"); caption(`[${n}]`); }
  else { sample("countdown:go"); caption("[go]"); }
}
export function undo(): void { sample("undo"); }

// -- the rendered ambience and music, per theme ------------------------------------------------
const RATE = 22050;
const BAR = 60 / 96;
const BARS = 16;
const MUS_N = Math.round(RATE * BAR * BARS);
const AMB_SECONDS = 2;
const AMB_N = RATE * AMB_SECONDS;
interface Bed { root: number; mood: string }
interface Rendered {
  key: string; pos: number; amb: Float32Array; bass: Float32Array; pad: Float32Array; arp: Float32Array; notes: number[];
  clips: { amb: AudioClip; bass: AudioClip; pad: AudioClip; arp: AudioClip } | null; failed: boolean;
}
let want: Bed | null = null;
let rendered: Rendered | null = null;
let voices: { key: string; amb: Sound; bass: Sound; pad: Sound; arp: Sound } | null = null;
let musicOn = false;
let ambienceOn = false;
let intensity = 0.3;

/** A mulberry32 stream (rules/rng.js next) for the arpeggio's seeded walk. */
function stream(seed: number): () => number {
  let n = seed >>> 0 || 0x9e3779b9;
  return () => {
    n = (n + 0x6d2b79f5) >>> 0;
    let t = n;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function startRender(bed: Bed): Rendered {
  const scale = bed.mood === "major" ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10];
  const rnd = stream((bed.root * 977) ^ 0xbead);
  const notes: number[] = [];
  for (let b = 0; b < BARS; b++) {
    const degree = scale[Math.floor(rnd() * scale.length)]!;
    notes.push(rnd() > 0.25 ? bed.root * Math.pow(2, degree / 12) * 4 : 0);
  }
  return {
    key: `${bed.root}:${bed.mood}`, pos: 0, amb: new Float32Array(AMB_N), bass: new Float32Array(MUS_N), pad: new Float32Array(MUS_N),
    arp: new Float32Array(MUS_N), notes, clips: null, failed: false,
  };
}
/** audio.js note(): 10 ms linear attack to `peak`, exponential fall to 0.0001 by `dur`. */
function env(t: number, dur: number, peak: number): number {
  if (t < 0 || t > dur) return 0;
  if (t < 0.01) return (peak * t) / 0.01;
  return peak * Math.pow(0.0001 / peak, (t - 0.01) / Math.max(0.001, dur - 0.01));
}
const TAU = Math.PI * 2;
const tri = (ph: number): number => { const p = ph - Math.floor(ph); return p < 0.5 ? 4 * p - 1 : 3 - 4 * p; };
const sq = (ph: number): number => (ph - Math.floor(ph) < 0.5 ? 1 : -1);
/** Renders `count` more samples; true when all are done. */
function renderSome(r: Rendered, bed: Bed, count: number): boolean {
  // ambience: root/2 sine + root×1.005 triangle, rounded to whole cycles in the 2 s loop
  const f1 = Math.round((bed.root / 2) * AMB_SECONDS) / AMB_SECONDS;
  const f2 = Math.round(bed.root * 1.005 * AMB_SECONDS) / AMB_SECONDS;
  const end = Math.min(MUS_N, r.pos + count);
  for (let i = r.pos; i < end; i++) {
    const t = i / RATE;
    if (i < AMB_N) r.amb[i] = 0.5 * (Math.sin(TAU * f1 * t) + tri(f2 * t));
    const bar = Math.floor(t / BAR);
    let bass = 0, pad = 0, arp = 0;
    // the bar's notes, and those still sounding from the bars before (wrapping round the loop)
    for (const back of [0, 1, 2]) {
      const b = (bar - back + BARS) % BARS;
      const local = t - bar * BAR + back * BAR;
      if (back <= 1) bass += Math.sin(TAU * bed.root * local) * env(local, BAR * 0.9, 0.5);
      if (b % 2 === 0) pad += tri(bed.root * 1.5 * local) * env(local, BAR * 1.8, 0.4);
      const f = r.notes[b]!;
      if (f && back <= 1) arp += sq(f * (local - BAR * 0.5)) * env(local - BAR * 0.5, BAR * 0.4, 0.12);
    }
    r.bass[i] = bass; r.pad[i] = pad; r.arp[i] = arp;
  }
  r.pos = end;
  return r.pos >= MUS_N;
}

/** audio.js startAmbience + startMusic: the theme's bed and music from the next frames. */
export function startTheme(bed: Bed): void { want = bed; musicOn = true; ambienceOn = true; }
/** audio.js setIntensity: 0..1 (from the ball's speed). */
export function setIntensity(v: number): void { intensity = Math.max(0, Math.min(1, v)); }
export function stopMusic(): void { musicOn = false; }
/** audio.js stopAll: music and ambience. */
export function stopAll(): void { musicOn = false; ambienceOn = false; }

function stopVoices(): void {
  if (!voices) return;
  for (const v of [voices.amb, voices.bass, voices.pad, voices.arp]) { try { v.stop(); } catch { /* gone */ } }
  voices = null;
}

let ambClock = 0;
/** Each frame: the clips once the mixer runs (one at a time), then the theme's loops, then their levels. */
export function update(dt: number): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const [n] of Object.values(SFX)) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  const bed = want;
  if (!bed) return;
  const key = `${bed.root}:${bed.mood}`;
  if (!rendered || rendered.key !== key) rendered = startRender(bed);
  const r = rendered;
  if (r.failed) return;
  if (!r.clips) {
    if (!renderSome(r, bed, 6000)) return;
    try {
      r.clips = { amb: createClip([r.amb], RATE), bass: createClip([r.bass], RATE), pad: createClip([r.pad], RATE), arp: createClip([r.arp], RATE) };
    } catch (e) { console.warn(`audio: ${String(e)}`); r.failed = true; }
    return;
  }
  if (!voices || voices.key !== key) {
    stopVoices();
    // all stems start together (one frame) so they stay in step
    try {
      const o = { bus: "music" as const, gain: 0, loop: true };
      voices = { key, amb: playClip(r.clips.amb, o), bass: playClip(r.clips.bass, o), pad: playClip(r.clips.pad, o), arp: playClip(r.clips.arp, o) };
    } catch { voices = null; }
    return;
  }
  ambClock += dt;
  const quiet = suspended || muted;
  const on = musicOn && !quiet;
  const i = intensity;
  try {
    // audio.js: ambience 0.05 ± 0.02 at 0.07 Hz (× 0.5 / 0.7 for its bus); bass 0.05 + i × 0.1; pad 0.10; arp above 0.45
    voices.amb.fade(ambienceOn && !quiet ? (0.05 + 0.02 * Math.sin(TAU * 0.07 * ambClock)) * 0.71 : 0, 0.2);
    voices.bass.fade(on ? 0.05 + i * 0.1 : 0, 0.4);
    voices.pad.fade(on ? 0.1 : 0, 0.4);
    voices.arp.fade(on && i > 0.45 ? 0.06 + i * 0.08 : 0, 0.6);
  } catch { voices = null; } // the mixer restarted
}
