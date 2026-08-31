// Procedural audio (spec §4): original short transients tied to logical
// events, layered impacts, quiet ambience, adaptive music stems. Buses:
// music / effects / ambience / voice. Captions expose meaningful audio as
// text; nothing gameplay-critical is audio-only. Seeded variants keep
// audible randomness consistent within a session.

import { createRng, next } from '../rules/rng.js';

// Authored one-shot samples (sfx/manifest.json) keyed by logical event.
// Each event prefers its mapped sample; procedural synthesis below remains
// the fallback while a clip is loading or if it fails to load.
const SFX = Object.freeze({
  'event:paddle': 'paddle-hit',
  'event:wall': 'wall-bounce',
  'event:bumper': 'bumper-bounce',
  'event:serve': 'serve-launch',
  'event:serve-ready': 'serve-ready',
  'event:goal': 'goal-scored',
  'event:match-end': 'match-end',
  'event:invalid': 'invalid-action',
  'ui:click': 'ui-click',
  'ui:back': 'ui-back',
  'ui:open': 'ui-open',
  'ui:error': 'ui-error',
  'ui:unlock': 'ui-unlock',
  'ui:star': 'ui-star',
  'countdown:tick': 'countdown-tick',
  'countdown:go': 'countdown-go',
  'undo': 'undo-rewind',
});

export class AudioEngine {
  constructor({ onCaption = null, seed = 1 } = {}) {
    this.ctx = null;
    this.buses = {};
    this.volumes = { music: 0.7, effects: 0.9, ambience: 0.5, voice: 0.8 };
    this.muted = false;
    this.captionsEnabled = true;
    this.onCaption = onCaption;
    this.rng = createRng((seed ^ 0xad10) >>> 0);
    this.music = null;
    this.ambience = null;
    this._noiseBuf = null;
    this._sfx = new Map(); // basename -> { status: 'loading'|'ready'|'failed', buffer? }
  }

  // Must be called from a user gesture at least once.
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    for (const name of ['music', 'effects', 'ambience', 'voice']) {
      const g = this.ctx.createGain();
      g.gain.value = this.volumes[name];
      g.connect(this.master);
      this.buses[name] = g;
    }
    this._noiseBuf = makeNoiseBuffer(this.ctx);
    return true;
  }

  setVolumes(v) {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    for (const [k, g] of Object.entries(this.buses)) {
      g.gain.setTargetAtTime(this.volumes[k] ?? 1, this.ctx.currentTime, 0.03);
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  setCaptions(on) {
    this.captionsEnabled = on;
  }

  caption(text) {
    if (this.captionsEnabled) this.onCaption?.(text);
  }

  suspend() {
    this.ctx?.suspend();
  }

  resume() {
    this.ctx?.resume();
  }

  // -------------------------------------------------------------------------
  // Authored sample one-shots (lazy fetch/decode/cache after unlock)
  // -------------------------------------------------------------------------

  _fetchSfx(name) {
    const rec = { status: 'loading', buffer: null };
    this._sfx.set(name, rec);
    fetch(`sfx/${name}.opus`)
      .then((res) => {
        if (!res.ok) throw new Error(`sfx ${name}: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((data) => this.ctx.decodeAudioData(data))
      .then((buffer) => {
        rec.status = 'ready';
        rec.buffer = buffer;
      })
      .catch(() => {
        rec.status = 'failed'; // permanent fallback to synthesis for this clip
      });
  }

  // Play the mapped sample through the effects bus if it is decoded; start a
  // lazy load otherwise. Returns true when the sample was actually started.
  _sample(eventKey, peak = 0.8) {
    if (!this.ctx) return false;
    const name = SFX[eventKey];
    if (!name) return false;
    const rec = this._sfx.get(name);
    if (rec?.status === 'ready') {
      const src = this.ctx.createBufferSource();
      src.buffer = rec.buffer;
      const g = this.ctx.createGain();
      g.gain.value = peak;
      src.connect(g);
      g.connect(this.buses.effects);
      src.start();
      return true;
    }
    if (!rec) this._fetchSfx(name);
    return false;
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  _env(bus, t0, a, d, peak = 1) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    g.connect(bus);
    return g;
  }

  _tone({ bus = 'effects', type = 'square', f0 = 440, f1 = null, a = 0.004, d = 0.09, peak = 0.5, when = 0 }) {
    if (!this.ensure()) return;
    const t0 = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + a + d);
    o.connect(this._env(this.buses[bus], t0, a, d, peak));
    o.start(t0);
    o.stop(t0 + a + d + 0.05);
  }

  _noise({ bus = 'effects', dur = 0.08, peak = 0.3, freq = 1200, q = 1, when = 0 }) {
    if (!this.ensure()) return;
    const t0 = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.8 + next(this.rng) * 0.4; // seeded variant
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f);
    f.connect(this._env(this.buses[bus], t0, 0.003, dur, peak));
    src.start(t0, next(this.rng) * 0.5);
    src.stop(t0 + dur + 0.1);
  }

  // -------------------------------------------------------------------------
  // Event mapping (input ack < legal move < combo/goal < round completion)
  // -------------------------------------------------------------------------

  event(e) {
    if (!this.ctx) return;
    switch (e.t) {
      case 'paddle': {
        if (this._sample('event:paddle')) break;
        const f = 200 + (e.speed / 40) * 260;
        this._tone({ type: 'square', f0: f, f1: f * 0.8, d: 0.07, peak: 0.4 });
        this._noise({ dur: 0.04, peak: 0.18, freq: 2400, q: 2 });
        break;
      }
      case 'wall':
        if (this._sample('event:wall', 0.6)) break;
        this._noise({ dur: 0.05, peak: 0.15, freq: 900, q: 1.5 });
        break;
      case 'bumper':
        if (this._sample('event:bumper', 0.7)) break;
        this._tone({ type: 'triangle', f0: 520, f1: 760, d: 0.1, peak: 0.35 });
        break;
      case 'serve':
        if (!this._sample('event:serve', 0.7)) {
          this._tone({ type: 'sawtooth', f0: 280, f1: 640, d: 0.14, peak: 0.25 });
        }
        this.caption('[serve]');
        break;
      case 'serve-ready':
        if (this._sample('event:serve-ready', 0.5)) break;
        this._tone({ type: 'sine', f0: 660, d: 0.06, peak: 0.15 });
        break;
      case 'goal': {
        const mine = e.player === 0;
        if (!this._sample('event:goal')) {
          this._noise({ dur: 0.35, peak: 0.3, freq: 500, q: 0.8 });
          this._tone({ type: 'triangle', f0: mine ? 523 : 392, d: 0.18, peak: 0.4 });
          this._tone({ type: 'triangle', f0: mine ? 784 : 311, d: 0.26, peak: 0.35, when: 0.09 });
        }
        this.caption(mine ? '[goal for you]' : '[goal conceded]');
        break;
      }
      case 'match-end': {
        const win = e.winner === 0;
        if (!this._sample('event:match-end')) {
          const seq = win ? [523, 659, 784, 1047] : [392, 330, 262, 196];
          seq.forEach((f, i) => this._tone({ type: 'triangle', f0: f, d: 0.22, peak: 0.35, when: i * 0.11 }));
        }
        this.caption(win ? '[victory]' : '[defeat]');
        break;
      }
      case 'invalid':
        if (!this._sample('event:invalid', 0.6)) {
          this._tone({ type: 'sawtooth', f0: 130, f1: 90, d: 0.1, peak: 0.22 });
        }
        this.caption('[action not allowed]');
        break;
    }
  }

  ui(name) {
    if (!this.ctx) return;
    if (this._sample(`ui:${name}`, 0.6)) return;
    switch (name) {
      case 'click': this._tone({ type: 'sine', f0: 980, d: 0.035, peak: 0.14 }); break;
      case 'back': this._tone({ type: 'sine', f0: 620, d: 0.045, peak: 0.12 }); break;
      case 'open': this._tone({ type: 'sine', f0: 740, f1: 990, d: 0.06, peak: 0.14 }); break;
      case 'error': this._tone({ type: 'sawtooth', f0: 160, f1: 110, d: 0.09, peak: 0.16 }); break;
      case 'unlock': this._tone({ type: 'triangle', f0: 660, d: 0.1, peak: 0.2 }); this._tone({ type: 'triangle', f0: 990, d: 0.16, peak: 0.2, when: 0.08 }); break;
      case 'star': this._tone({ type: 'sine', f0: 1175, d: 0.12, peak: 0.16 }); break;
    }
  }

  countdown(n) {
    if (n > 0) {
      if (!this._sample('countdown:tick', 0.6)) {
        this._tone({ type: 'sine', f0: 440, d: 0.09, peak: 0.25 });
      }
      this.caption(`[${n}]`);
    } else {
      if (!this._sample('countdown:go', 0.7)) {
        this._tone({ type: 'sine', f0: 880, d: 0.16, peak: 0.3 });
      }
      this.caption('[go]');
    }
  }

  undo() {
    if (this._sample('undo', 0.6)) return;
    this._tone({ type: 'sine', f0: 500, f1: 300, d: 0.1, peak: 0.18 });
  }

  // -------------------------------------------------------------------------
  // Ambience + adaptive music (layered stems keyed to match intensity)
  // -------------------------------------------------------------------------

  startAmbience({ root = 110 } = {}) {
    if (!this.ensure() || this.ambience) return;
    const t0 = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.value = 0.05;
    g.connect(this.buses.ambience);
    const o1 = this.ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = root / 2;
    const o2 = this.ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = root * 1.005;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = 0.02;
    lfo.connect(lfoG);
    lfoG.connect(g.gain);
    o1.connect(g);
    o2.connect(g);
    o1.start(t0);
    o2.start(t0);
    lfo.start(t0);
    this.ambience = { stop: () => { o1.stop(); o2.stop(); lfo.stop(); g.disconnect(); } };
  }

  startMusic({ root = 110, mood = 'minor', seed = 1 } = {}) {
    if (!this.ensure()) return;
    this.stopMusic();
    const rng = createRng(seed ^ 0xbead);
    const scale = mood === 'major' ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10];
    const state = {
      running: true,
      intensity: 0.3,
      nextBar: this.ctx.currentTime + 0.1,
      bar: 0,
      layers: {},
      timer: null,
    };
    for (const name of ['bass', 'pad', 'arp']) {
      const g = this.ctx.createGain();
      g.gain.value = name === 'pad' ? 0.10 : 0;
      g.connect(this.buses.music);
      state.layers[name] = g;
    }
    const barLen = 60 / 96; // 96 bpm, one bar per beat group here
    const note = (f, t0, dur, type, gainNode, peak) => {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(gainNode);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    };
    const schedule = () => {
      if (!state.running) return;
      while (state.nextBar < this.ctx.currentTime + 0.25) {
        const t0 = state.nextBar;
        const degree = scale[Math.floor(next(rng) * scale.length)];
        const f = root * 2 ** (degree / 12);
        // Bass: root pulse every bar.
        note(root, t0, barLen * 0.9, 'sine', state.layers.bass, 0.5);
        // Pad: fifth, slow.
        if (state.bar % 2 === 0) note(root * 1.5, t0, barLen * 1.8, 'triangle', state.layers.pad, 0.4);
        // Arp: seeded walk, only audible with intensity.
        if (next(rng) > 0.25) note(f * 4, t0 + barLen * 0.5, barLen * 0.4, 'square', state.layers.arp, 0.12);
        state.nextBar += barLen;
        state.bar++;
      }
      // Intensity-driven stem gains (adaptive music).
      const i = state.intensity;
      state.layers.bass.gain.setTargetAtTime(0.05 + i * 0.1, this.ctx.currentTime, 0.4);
      state.layers.arp.gain.setTargetAtTime(i > 0.45 ? 0.06 + i * 0.08 : 0, this.ctx.currentTime, 0.6);
      state.timer = setTimeout(schedule, 120);
    };
    schedule();
    this.music = state;
  }

  setIntensity(v) {
    if (this.music) this.music.intensity = Math.max(0, Math.min(1, v));
  }

  stopMusic() {
    if (this.music) {
      this.music.running = false;
      clearTimeout(this.music.timer);
      for (const g of Object.values(this.music.layers)) g.disconnect();
      this.music = null;
    }
  }

  stopAll() {
    this.stopMusic();
    this.ambience?.stop();
    this.ambience = null;
  }
}

function makeNoiseBuffer(ctx) {
  const len = ctx.sampleRate * 1;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let s = 0x12345;
  for (let i = 0; i < len; i++) {
    // Deterministic LCG noise — consistent buffers across sessions.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data[i] = (s / 0xffffffff) * 2 - 1;
  }
  return buf;
}
