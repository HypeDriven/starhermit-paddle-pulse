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
// into clips (OfflineAudioContext, one per stem: 16 bars of the seeded walk, looped)
// and played on the music bus, the stem levels set each frame (the runtime has
// no ambience bus: the bed folds in the old ambience slider's 50 % against
// music's 70 %). The oscillator blips the browser build synthesized while a
// sample decoded are not ported (a live synthesis graph makes clip loads fail
// on the engine's web runtime), so a clip still loading is silent. The
// runtime's Options own the volumes and the voice limit; Settings › Mute all
// mutes the game on the engine. Clips load at once from onStart; the beds
// start once the mixer runs (natively at once, in a browser after the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, setMuted as muteGame, type AudioClip, type Sound } from "starhermit:audio";

const SFX: Record<string, [string, number]> = {
  "event:paddle": ["paddle-hit", 0.8], "event:wall": ["wall-bounce", 0.6], "event:bumper": ["bumper-bounce", 0.7],
  "event:serve": ["serve-launch", 0.7], "event:serve-ready": ["serve-ready", 0.5], "event:goal": ["goal-scored", 0.8],
  "event:match-end": ["match-end", 0.8], "event:invalid": ["invalid-action", 0.6],
  "ui:click": ["ui-click", 0.6], "ui:back": ["ui-back", 0.6], "ui:open": ["ui-open", 0.6], "ui:error": ["ui-error", 0.6],
  "ui:unlock": ["ui-unlock", 0.6], "ui:star": ["ui-star", 0.6],
  "countdown:tick": ["countdown-tick", 0.6], "countdown:go": ["countdown-go", 0.7], undo: ["undo-rewind", 0.6],
};
const clips = new Map<string, AudioClip>();
let suspended = false;
let onCaption: ((cue: string) => void) | null = null;

/** Loads every clip at once (onStart); a sound whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SFX).map((s) => s[0]))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
}
/** Captions for meaningful sounds (audio.js caption()): the cue ids '[serve]', '[goal for you]', … */
export function setOnCaption(fn: (cue: string) => void): void { onCaption = fn; }
/** Settings › Mute all: the engine mutes the game (not saved: the setting is, and main.ts applies it). */
export function setMuted(on: boolean): void { muteGame(on); }
/** A hidden window: everything quiet (audio.js suspend / resume). */
export function setSuspended(on: boolean): void { suspended = on; }

function sample(key: string): void {
  if (suspended) return;
  const s = SFX[key];
  if (!s) return;
  const clip = clips.get(s[0]);
  if (!clip) return;
  try { playClip(clip, { bus: key.startsWith("ui:") ? "interface" : "effects", gain: s[1] }); }
  catch { /* the mixer is full this frame: skip it */ }
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
interface Bed { root: number; mood: string }
interface Stems { amb: AudioClip; bass: AudioClip; pad: AudioClip; arp: AudioClip }
/** Each theme's stems once rendered (null while rendering or if it failed). */
const rendered = new Map<string, Stems | null>();
let want: Bed | null = null;
let voices: { key: string; amb: Sound; bass: Sound; pad: Sound; arp: Sound } | null = null;
let musicOn = false;
let ambienceOn = false;
let intensity = 0.3;

/** A mulberry32 stream (rules/rng.js next) for the arpeggio's seeded walk: each theme keeps its melody. */
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
/** audio.js note(): 10 ms linear attack to `peak`, exponential fall to 0.0001 by `dur`. */
function note(off: OfflineAudioContext, type: "sine" | "triangle" | "square", freq: number, at: number, dur: number, peak: number): void {
  const osc = off.createOscillator(); osc.type = type; osc.frequency.value = freq;
  const g = off.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(off.destination);
  osc.start(at); osc.stop(at + dur);
}
/** The engine's band-limited square reads -1.5 dB against the old naive one (rms 0.0169 vs 0.0202). */
const ARP_MAKEUP = 1.19;
const stemContext = (): OfflineAudioContext => new OfflineAudioContext(1, MUS_N, RATE);
/** The theme's stems, one context each: 16 bars of bass, pad and the seeded walk; the 2 s ambience rounded to whole cycles. */
async function renderStems(bed: Bed): Promise<Stems> {
  const scale = bed.mood === "major" ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10];
  const rnd = stream((bed.root * 977) ^ 0xbead);
  const bass = stemContext(), pad = stemContext(), arp = stemContext();
  for (let b = 0; b < BARS; b++) {
    const degree = scale[Math.floor(rnd() * scale.length)]!;
    const f = rnd() > 0.25 ? bed.root * Math.pow(2, degree / 12) * 4 : 0;
    const at = b * BAR;
    note(bass, "sine", bed.root, at, BAR * 0.9, 0.5);
    if (b % 2 === 0) note(pad, "triangle", bed.root * 1.5, at, BAR * 1.8, 0.4);
    if (f) note(arp, "square", f, at + BAR * 0.5, BAR * 0.4, 0.12 * ARP_MAKEUP);
  }
  const amb = new OfflineAudioContext(1, RATE * AMB_SECONDS, RATE);
  const half = amb.createGain(); half.gain.value = 0.5; half.connect(amb.destination);
  const low = amb.createOscillator(); low.frequency.value = Math.round((bed.root / 2) * AMB_SECONDS) / AMB_SECONDS;
  const high = amb.createOscillator(); high.type = "triangle"; high.frequency.value = Math.round(bed.root * 1.005 * AMB_SECONDS) / AMB_SECONDS;
  low.connect(half); high.connect(half); low.start(); high.start();
  const [a, b, p, q] = await Promise.all([amb.startRendering(), bass.startRendering(), pad.startRendering(), arp.startRendering()]);
  return { amb: createClip(a), bass: createClip(b), pad: createClip(p), arp: createClip(q) };
}

/** audio.js startAmbience + startMusic: the theme's bed and music from the next frames. */
export function startTheme(bed: Bed): void {
  want = bed; musicOn = true; ambienceOn = true;
  const key = `${bed.root}:${bed.mood}`;
  if (rendered.has(key)) return;
  rendered.set(key, null);
  renderStems(bed).then((c) => { rendered.set(key, c); }, (e: unknown) => { console.warn(`audio: ${String(e)}`); });
}
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

const TAU = Math.PI * 2;
let ambClock = 0;
/** Each frame, once the mixer runs: the theme's loops, then their levels. */
export function update(dt: number): void {
  if (context.state !== "running") return;
  const bed = want;
  if (!bed) return;
  const key = `${bed.root}:${bed.mood}`;
  const clips = rendered.get(key);
  if (!clips) return;
  if (!voices || voices.key !== key) {
    stopVoices();
    // all stems start together (one frame) so they stay in step
    try {
      const o = { bus: "music" as const, gain: 0, loop: true };
      voices = { key, amb: playClip(clips.amb, o), bass: playClip(clips.bass, o), pad: playClip(clips.pad, o), arp: playClip(clips.arp, o) };
    } catch { voices = null; }
    return;
  }
  ambClock += dt;
  const on = musicOn && !suspended;
  const i = intensity;
  try {
    // audio.js: ambience 0.05 ± 0.02 at 0.07 Hz (× 0.5 / 0.7 for its bus); bass 0.05 + i × 0.1; pad 0.10; arp above 0.45
    voices.amb.fade(ambienceOn && !suspended ? (0.05 + 0.02 * Math.sin(TAU * 0.07 * ambClock)) * 0.71 : 0, 0.2);
    voices.bass.fade(on ? 0.05 + i * 0.1 : 0, 0.4);
    voices.pad.fade(on ? 0.1 : 0, 0.4);
    voices.arp.fade(on && i > 0.45 ? 0.06 + i * 0.08 : 0, 0.6);
  } catch { voices = null; } // the mixer restarted
}
