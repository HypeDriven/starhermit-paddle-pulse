// Bootstrap + glue (spec §3–§6). Wires the DOM shell (ui/app.js), content,
// session, renderer, audio, and platform adapter into a playable game:
// boot → title → mode setup → countdown → active ↔ paused → results.
// Simulation runs at the engine's fixed tick rate with render interpolation;
// this file never mutates rules state except through LocalMatch.submit.

import { App, fmtTime } from './ui/app.js';
import { screenBuilders } from './ui/screens.js';
import {
  TICK_RATE, PHASE, CMD, verifyReplay,
} from './rules/engine.js';
import { LocalMatch, nextCmdId } from './session/match.js';
import {
  Storage, migrateSettings, defaultProgress, migrateProgress,
  validateLeaderboardEntry,
} from './session/storage.js';
import {
  JOURNEY_LEVELS, CHALLENGES, PRACTICE_DIFFICULTIES, AI_LEVELS,
  getJourneyLevel, getChallenge,
} from './content/levels.js';
import { getLesson, stepSatisfied } from './content/tutorials.js';
import { dailyContent, utcDateString, msUntilNextDaily, DAILY_RULESET_VERSION } from './content/daily.js';
import { getAchievement } from './content/achievements.js';
import { getTheme } from './content/themes.js';
import { ArenaRenderer, QUALITY_TIERS } from './render/scene.js';
import { AudioEngine } from './audio/audio.js';
import { platform } from './platform/host.js';

const DT = 1 / TICK_RATE;
const BUILD = 'web-1.0';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const storage = new Storage();
const settings = migrateSettings(storage.loadDoc('settings')?.data);
const progress = migrateProgress(storage.loadDoc('progress')?.data);

const ui = {
  hud: document.getElementById('hud'),
  score: document.getElementById('hud-score'),
  name0: document.getElementById('hud-name-0'),
  name1: document.getElementById('hud-name-1'),
  objective: document.getElementById('hud-objective'),
  sub: document.getElementById('hud-sub'),
  serve: document.getElementById('hud-serve'),
  countdown: document.getElementById('hud-countdown'),
  canvas: document.getElementById('arena'),
};

const audio = new AudioEngine({ onCaption: (t) => app.caption(t), seed: 1 });
let renderer = null;

const game = {
  phase: 'boot', // boot | title | setup | countdown | active | paused | results
  match: null,
  ctx: null, // mode context: { mode, contentId, title, theme, seed, ruleset, seats, allowUndo, ranked, ref }
  lesson: null, // { def, stepIndex }
  angledHits: 0,
  acc: 0,
  lastFrame: 0,
  pointerX: null,
  keysHeld: new Set(),
  keyTarget: 0,
  lastMoveSent: 0,
  lastPadButtons: {},
  daily: null,
  resumeSnapshot: null,
  lastInvalidToast: 0,
};

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

const app = new App({ onAction: handleAction, onBack: handleBack });
for (const [name, build] of Object.entries(screenBuilders)) app.register(name, build);

function saveSettings() { storage.saveDoc('settings', settings); }
function saveProgress() { storage.saveDoc('progress', progress); }

function dailyNow() {
  game.daily = dailyContent(utcDateString(platform.now()));
  return game.daily;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  applySettings();
  app.show('boot', { pct: 30, label: 'Synchronizing clock…', title: 'Loading' });
  await platform.init();
  app.close('boot');
  dailyNow();

  if (!ArenaRenderer.supported()) {
    // Compatibility path: progress is untouched, message explains recovery.
    game.phase = 'title';
    app.show('compat', { title: '3D unavailable' });
    return;
  }
  renderer = new ArenaRenderer(ui.canvas, {
    tier: settings.graphics.tier === 'auto' ? 'medium' : settings.graphics.tier,
    reducedMotion: effectiveReducedMotion(),
    trails: settings.graphics.trails,
    onContextLost: (lost) => {
      if (lost) app.toast('Graphics context lost — restoring…', { kind: 'error' });
    },
  });
  window.addEventListener('resize', () => renderer.resize());

  const snap = storage.loadDoc('snapshot');
  if (snap?.data?.json) {
    try {
      const parsed = JSON.parse(snap.data.json);
      if (parsed?.state?.phase !== PHASE.OVER) {
        game.resumeSnapshot = { json: snap.data.json, savedAt: snap.data.savedAt || snap.updatedAt || Date.now() };
      }
    } catch { /* corrupt snapshot: ignore */ }
  }

  goTitle();
  platform.startPresence();
  requestAnimationFrame(frame);
}

function goTitle() {
  game.phase = 'title';
  ui.hud.hidden = true;
  app.closeAll();
  app.show('title', { progress, daily: game.daily || dailyNow(), name: settings.displayName, title: 'Paddle Pulse' });
}

// ---------------------------------------------------------------------------
// Settings application
// ---------------------------------------------------------------------------

function effectiveReducedMotion() {
  return settings.accessibility.reducedMotion ||
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}

function applySettings() {
  const a = settings.accessibility;
  document.body.classList.toggle('reduced-motion', effectiveReducedMotion());
  document.body.classList.toggle('high-contrast', a.highContrast);
  document.body.classList.toggle('left-handed', a.leftHanded);
  for (const p of ['none', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast']) {
    document.body.classList.toggle('palette-' + p, a.palette === p);
  }
  document.documentElement.style.fontSize = (16 * (a.textScale || 1)).toFixed(2) + 'px';
  audio.setVolumes(settings.audio);
  audio.setMuted(settings.audio.muted);
  audio.setCaptions(a.captions);
  platform.consented = !!settings.consent.telemetry;
  if (renderer) {
    renderer.setReducedMotion(effectiveReducedMotion());
    if (settings.graphics.tier !== 'auto') renderer.setQuality(settings.graphics.tier);
  }
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Screen openers
// ---------------------------------------------------------------------------

function openModes() { app.show('modes', { title: 'Modes' }); }

function openSetup(ctx) {
  game.ctx = ctx;
  game.phase = 'setup';
  const r = ctx.ruleset;
  app.show('setup', {
    title: ctx.title,
    brief: ctx.brief || '',
    rules: [
      ['Target', `${r.targetScore ?? 5} points, win by ${r.winMargin ?? 2}`],
      ['Ball speed', `${r.ballSpeed ?? 14} u/s`],
      ...(ctx.seats[1].kind === 'ai' ? [['Opponent', AI_LEVELS[ctx.seats[1].level ?? 2].name]] : []),
      ...(ctx.allowUndo ? [['Recovery', 'Restart + undo available']] : []),
    ],
    players: ctx.seats[1].kind === 'ai' ? 'Solo vs AI' : '2P shared screen',
    ranked: !!ctx.ranked,
    duration: '~2 min',
    seed: ctx.seed,
    assists: { timingAssist: settings.accessibility.timingAssist },
    startLabel: ctx.startLabel || 'Start',
  });
}

function openPause() {
  if (game.phase !== 'active') return;
  game.phase = 'paused';
  saveSnapshot();
  app.show('pause', {
    title: 'Paused',
    objective: game.ctx?.brief || game.ctx?.title || 'Match paused',
    canUndo: !!game.match?.allowUndo && game.match.snapshots.length > 0,
  });
  app.announce('Paused');
}

function closePauseAnd(fn) {
  if (app.isOpen('pause')) app.close('pause');
  fn();
}

function resumeMatch() {
  app.closeAll();
  ui.hud.hidden = false;
  storage.clear('snapshot');
  game.resumeSnapshot = null;
  game.phase = 'countdown';
  runCountdown(() => { game.phase = 'active'; });
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

function buildSeats(kind, aiLevel, names) {
  return [
    { kind: 'human', name: names?.[0] || settings.displayName },
    kind === 'ai'
      ? { kind: 'ai', level: aiLevel ?? 2, name: AI_LEVELS[aiLevel ?? 2].name }
      : { kind: 'human', name: names?.[1] || 'Player 2' },
  ];
}

function effectiveRuleset(ctx) {
  const r = { ...ctx.ruleset };
  if (settings.accessibility.timingAssist && ctx.seats[1].kind === 'ai') {
    r.paddleWidth = (r.paddleWidth ?? 3.4) * 1.25; // declared assist, solo only
  }
  return r;
}

function startMatch(ctx = game.ctx) {
  game.ctx = ctx;
  app.closeAll();
  const ruleset = effectiveRuleset(ctx);
  game.match = new LocalMatch({
    seats: ctx.seats,
    mode: ctx.mode,
    contentId: ctx.contentId,
    ruleset,
    seed: ctx.seed,
    allowUndo: !!ctx.allowUndo,
    build: BUILD,
    aiIdle: !!ctx.aiIdle,
  });
  game.lesson = ctx.lesson ? { def: ctx.lesson, stepIndex: 0 } : null;
  game.angledHits = 0;
  game.acc = 0;
  game.keyTarget = 0;
  game.lastMoveSent = 0;
  game.pointerX = null;

  renderer.build(game.match.state.ruleset, ctx.theme || 'neon-district', {
    side: 0,
    cvd: settings.accessibility.palette,
    view: settings.camera.view,
  });
  const theme = getTheme(ctx.theme || 'neon-district');
  audio.ensure();
  audio.startAmbience(theme.ambience);
  audio.startMusic({ ...theme.ambience, seed: ctx.seed });

  ui.hud.hidden = false;
  ui.name0.textContent = ctx.seats[0].name || 'You';
  ui.name1.textContent = ctx.seats[1].name || 'Opponent';
  ui.objective.textContent = ctx.objective || `First to ${game.match.state.ruleset.targetScore}, win by ${game.match.state.ruleset.winMargin}.`;
  updateHudSub();
  updateHud();
  app.announce(`${ctx.title}. ${ui.objective.textContent}`);
  platform.activityStart();
  platform.telemetry('start', { mode: ctx.mode });

  game.phase = 'countdown';
  runCountdown(() => { game.phase = 'active'; });
}

function runCountdown(done) {
  let n = 3;
  ui.countdown.textContent = n;
  audio.countdown(n);
  const timer = setInterval(() => {
    n--;
    ui.countdown.textContent = n > 0 ? n : 'GO';
    audio.countdown(n);
    if (n < 0) {
      clearInterval(timer);
      ui.countdown.textContent = '';
      done();
    }
  }, 650);
}

function updateHudSub() {
  if (!game.match) return;
  if (game.lesson) {
    const step = game.lesson.def.steps[game.lesson.stepIndex];
    ui.sub.textContent = step ? step.text : 'Lesson complete.';
  } else {
    const m = game.match;
    ui.sub.textContent = game.ctx?.brief || `${m.state.ruleset.targetScore} to win · margin ${m.state.ruleset.winMargin}`;
  }
}

function updateHud() {
  const m = game.match;
  if (!m) return;
  ui.score.textContent = `${m.state.score[0]} – ${m.state.score[1]}`;
  const canServe = game.phase === 'active' && m.state.phase === PHASE.SERVE && m.state.server === 0;
  ui.serve.disabled = !canServe;
}

function endMatch() {
  const m = game.match;
  const ctx = game.ctx;
  game.phase = 'resolving';
  audio.setIntensity(0.2);
  setTimeout(() => showResults(m, ctx), 900);
}

function showResults(m, ctx) {
  game.phase = 'results';
  ui.hud.hidden = true;
  storage.clear('snapshot');
  const t = m.result;
  const won = t.winner === 0;
  const bd = t.breakdown;
  recordProgress(m, ctx, won, t);

  let starsEarned = null;
  if (ctx.mode === 'journey' && won) {
    const par = ctx.ref.goals.par;
    starsEarned = 1 + (bd.goals[1] <= par.star2 ? 1 : 0) + (bd.goals[1] <= par.star3 ? 1 : 0);
    const rec = progress.journey[ctx.ref.id] || { stars: 0, wins: 0 };
    rec.stars = Math.max(rec.stars, starsEarned);
    rec.wins = (rec.wins || 0) + 1;
    progress.journey[ctx.ref.id] = rec;
    if (ctx.ref.mastery) progress.totals.masteryCleared = Math.max(progress.totals.masteryCleared, countMasteryCleared());
  }
  const unlocked = awardAchievements(m, won);

  const breakdown = [
    ['Final score', `${bd.goals[0]} – ${bd.goals[1]}`],
    ['Target', `${bd.targetScore} (margin ${bd.winMargin})`],
    ['Rallies', String(bd.rallies)],
    ['Longest rally', `${bd.longestRally} hits`],
    ['Your returns', String(bd.hits[0])],
    ['Fastest return', `${bd.fastestReturn} u/s`],
    ['Duration', fmtTime(bd.elapsedSeconds)],
    ['Reason', t.reason],
  ];

  let nextLabel = 'Continue';
  if (ctx.mode === 'journey' && won) {
    const next = getJourneyLevel(ctx.ref.index + 1);
    nextLabel = next ? `Next: ${next.title}` : 'Journey complete';
  }
  saveProgress();
  audio.stopMusic();
  audio.stopAll();
  platform.activityEnd();
  platform.telemetry('round-end', { mode: ctx.mode, won });

  app.show('results', {
    title: 'Results',
    headline: won ? 'Victory' : t.reason === 'match-conceded' ? 'Conceded' : 'Defeat',
    sub: `${ctx.title} — ${bd.goals[0]}–${bd.goals[1]}`,
    breakdown,
    starsEarned,
    unlocked,
    comparison: null,
    nextLabel,
    canVerify: true,
    won,
  });
  app.announce(`${won ? 'Victory' : 'Defeat'} ${bd.goals[0]} to ${bd.goals[1]}`, true);
}

function countMasteryCleared() {
  return JOURNEY_LEVELS.filter((l) => l.mastery && (progress.journey[l.id]?.stars || 0) > 0).length;
}

function recordProgress(m, ctx, won, terminal) {
  progress.totals.matches++;
  progress.totals.angledHits += game.angledHits;
  if (won) {
    progress.totals.wins++;
    progress.streak.current++;
    progress.streak.best = Math.max(progress.streak.best, progress.streak.current);
  } else {
    progress.streak.current = 0;
  }
  progress.rating.matches++;
  progress.rating.mu = Math.max(1, progress.rating.mu + (won ? 0.5 : -0.35));

  if (ctx.mode === 'challenge' && won) {
    progress.challenges[ctx.ref.id] = { cleared: true, best: terminal.score.join('-') };
  }
  if (ctx.mode === 'daily' && ctx.ranked) {
    const date = game.daily.date;
    if (!progress.dailies[date]) {
      progress.dailies[date] = {
        won, score: [...terminal.score], duration: Math.round(terminal.breakdown.elapsedSeconds),
        seed: ctx.seed, rulesetVersion: DAILY_RULESET_VERSION,
      };
    }
    const entry = {
      name: settings.displayName,
      score: terminal.score[0],
      duration: Math.round(terminal.breakdown.elapsedSeconds),
      rulesetVersion: DAILY_RULESET_VERSION,
      seed: ctx.seed,
      assists: settings.accessibility.timingAssist,
    };
    if (validateLeaderboardEntry(entry, { targetScore: 99 }).ok) {
      const board = (progress.leaderboards.daily[date] ||= []);
      board.push(entry);
      board.sort((a, b) => b.score - a.score || a.duration - b.duration);
      progress.leaderboards.daily[date] = board.slice(0, 20);
    }
  }
  const local = progress.leaderboards.local;
  const me = local.find((e) => e.name === settings.displayName);
  if (me) {
    me.score = progress.totals.wins;
    me.duration = Math.min(me.duration, Math.round(terminal.breakdown.elapsedSeconds));
  } else {
    local.push({ name: settings.displayName, score: progress.totals.wins, duration: Math.round(terminal.breakdown.elapsedSeconds) });
  }
  local.sort((a, b) => b.score - a.score || a.duration - b.duration);
  progress.leaderboards.local = local.slice(0, 20);
}

function awardAchievements(m, won) {
  const unlocked = [];
  const grant = (key, prog = null) => {
    const rec = (progress.achievements[key] ||= { at: null, progress: 0 });
    if (prog != null) rec.progress = Math.max(rec.progress, prog);
    const def = getAchievement(key);
    const done = def.progress ? rec.progress >= def.progress : true;
    if (!rec.at && done) {
      rec.at = Date.now();
      unlocked.push(def);
      audio.ui('unlock');
      app.toast(`Achievement: ${def.name}`, { kind: 'success' });
    }
  };
  const cleared = Object.values(progress.journey).filter((j) => j.stars > 0).length;
  if (won) grant('first-win');
  grant('angle-master', progress.totals.angledHits);
  grant('streak-5', progress.streak.current);
  grant('mastery-all', countMasteryCleared());
  grant('centurion', progress.totals.matches);
  grant('daily-devotee', Object.keys(progress.dailies).length);
  grant('journey-half', Math.min(20, cleared));
  grant('journey-complete', cleared);
  if (won && m.state.score[1] === 0 && game.ctx?.mode !== 'learn') grant('untouchable');
  grant('challenger', CHALLENGES.filter((c) => progress.challenges[c.id]?.cleared).length);
  return unlocked;
}

// ---------------------------------------------------------------------------
// Snapshots (safe resume after backgrounding)
// ---------------------------------------------------------------------------

function saveSnapshot() {
  if (!game.match || game.match.finished) return;
  storage.saveDoc('snapshot', { v: 1, savedAt: Date.now(), json: game.match.snapshot() });
}

// ---------------------------------------------------------------------------
// Input: commands into the session layer
// ---------------------------------------------------------------------------

function submitMove(player, x) {
  const m = game.match;
  if (!m || m.finished) return;
  if (Math.abs(x - game.lastMoveSent) < 0.05 && player === 0) return;
  if (player === 0) game.lastMoveSent = x;
  const prevTx = m.state.paddles[player].tx;
  const res = m.submit({ id: nextCmdId(player), player, type: CMD.MOVE, x });
  if (!res.ok) explainInvalid(res);
  else if (game.lesson && player === 0) {
    lessonEvent({ t: 'cmd', type: 'move', dx: x - prevTx });
  }
}

function submitServe(player = 0) {
  const m = game.match;
  if (!m || game.phase !== 'active') return;
  const res = m.submit({ id: nextCmdId(player), player, type: CMD.SERVE });
  if (!res.ok) explainInvalid(res);
}

function explainInvalid(res) {
  const now = performance.now();
  if (now - game.lastInvalidToast < 1000) return;
  game.lastInvalidToast = now;
  const msg = {
    'match-finished': 'The match is over.',
    'not-serve-phase': 'You can only serve when the ball is docked.',
    'not-your-serve': "It's not your serve.",
    'out-of-bounds': 'Paddle target is out of bounds.',
    'move-limit-exceeded': 'Move limit reached — no commands left.',
  }[res.reason] || 'Action not allowed.';
  app.toast(msg, { kind: 'error' });
}

function lessonEvent(evt) {
  const l = game.lesson;
  if (!l) return;
  const step = l.def.steps[l.stepIndex];
  if (!step) return;
  if (stepSatisfied(step, evt)) {
    l.stepIndex++;
    platform.telemetry('tutorial-step', { id: l.def.id, step: l.stepIndex });
    const next = l.def.steps[l.stepIndex];
    if (next) {
      app.toast(next.text, { kind: 'success', ms: 3400 });
      ui.sub.textContent = next.text;
    } else {
      settings.tutorialDone[l.def.id] = true;
      saveSettings();
      app.toast(`${l.def.objective} — lesson complete ✓`, { kind: 'success', ms: 3200 });
      if (l.def.id !== 't-score') {
        // Lessons that don't end by winning: close out cleanly.
        game.phase = 'resolving';
        setTimeout(() => {
          game.phase = 'results';
          ui.hud.hidden = true;
          audio.stopAll();
          app.show('results', {
            title: 'Lesson complete',
            headline: 'Lesson complete',
            sub: l.def.objective,
            breakdown: [['Lesson', l.def.title], ['Steps', String(l.def.steps.length)]],
            starsEarned: null,
            unlocked: [],
            nextLabel: 'Back to Learn',
            canVerify: false,
            won: true,
          });
        }, 700);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Frame loop: fixed-step simulation + interpolated render
// ---------------------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.1, (now - game.lastFrame) / 1000 || 0);
  game.lastFrame = now;
  if (!renderer) return;

  if (game.phase === 'active' && game.match && !game.match.finished) {
    game.acc += dtReal;
    let steps = 0;
    while (game.acc >= DT && steps < 20) {
      pollInputs(DT);
      const events = game.match.step();
      game.acc -= DT;
      steps++;
      if (events.length) {
        renderer.handleEvents(events, { onAudioEvent: (e) => audio.event(e) });
        for (const e of events) {
          if (game.lesson) lessonEvent(e);
          if (e.t === 'paddle' && e.player === 0 && Math.abs(e.offset) >= 0.5) game.angledHits++;
          if (e.t === 'goal') {
            app.announce(`Score ${e.score[0]} to ${e.score[1]}${e.player === 0 ? ', your point' : ''}`);
          }
          if (e.t === 'match-end') app.announce(e.winner === 0 ? 'Match won' : 'Match lost', true);
        }
      }
    }
    if (steps === 20) game.acc = 0; // spiral-of-death guard
    audio.setIntensity(Math.min(1, 0.3 + (game.match.state.ball.speed / game.match.state.ruleset.maxBallSpeed) * 0.7));
    updateHud();
  }

  pollGamepad();

  if (game.match && (game.phase === 'active' || game.phase === 'paused' || game.phase === 'countdown')) {
    const alpha = game.phase === 'active' ? Math.min(1, game.acc / DT) : 1;
    renderer.update(game.match.interpolation(alpha), dtReal);
    if (game.match.finished && game.phase === 'active') endMatch();
  }
  renderer.render(dtReal);
}

// Keyboard / pointer / gamepad → commands (throttled like the AI's).
function pollInputs(dt) {
  const m = game.match;
  if (!m || m.finished) return;
  const half = m.state.ruleset.arena.w / 2 - m.state.paddles[0].halfW;
  const speed = m.state.ruleset.paddleSpeed;

  if (game.pointerX != null) {
    submitMove(0, Math.max(-half, Math.min(half, game.pointerX)));
  } else if (game.keysHeld.size) {
    const k = settings.controls.keys;
    let dir = 0;
    if (game.keysHeld.has(k.left)) dir -= 1;
    if (game.keysHeld.has(k.right)) dir += 1;
    if (settings.accessibility.leftHanded) dir = -dir;
    if (dir !== 0) {
      game.keyTarget = Math.max(-half, Math.min(half, game.keyTarget + dir * speed * dt));
    } else {
      game.keyTarget = m.state.paddles[0].tx;
    }
    if (Math.abs(game.keyTarget - m.state.paddles[0].tx) > 0.25) submitMove(0, game.keyTarget);
  }
}

function pollGamepad() {
  if (game.phase !== 'active' || !game.match) return;
  const pads = navigator.getGamepads?.() || [];
  const gp = [...pads].find(Boolean);
  if (!gp) return;
  const cfg = settings.controls.gamepad;
  const ax = gp.axes[cfg.moveAxis] || 0;
  if (Math.abs(ax) > 0.2) {
    const half = game.match.state.ruleset.arena.w / 2 - game.match.state.paddles[0].halfW;
    submitMove(0, ax * half * (settings.accessibility.leftHanded ? -1 : 1));
    game.pointerX = null;
  }
  const edge = (name, idx, fn) => {
    const pressed = !!gp.buttons[idx]?.pressed;
    if (pressed && !game.lastPadButtons[name]) fn();
    game.lastPadButtons[name] = pressed;
  };
  edge('serve', cfg.serve, () => submitServe(0));
  edge('pause', cfg.pause, () => openPause());
}

// Pointer control with capture.
ui.canvas.addEventListener('pointerdown', (e) => {
  if (game.phase !== 'active') return;
  ui.canvas.setPointerCapture(e.pointerId);
  game.pointerX = renderer.screenToArenaX(e.clientX);
});
ui.canvas.addEventListener('pointermove', (e) => {
  if (game.phase !== 'active' || !ui.canvas.hasPointerCapture?.(e.pointerId)) return;
  game.pointerX = renderer.screenToArenaX(e.clientX);
});
ui.canvas.addEventListener('pointerup', (e) => {
  if (game.phase === 'active' && game.match?.state.phase === PHASE.SERVE && game.match.state.server === 0) {
    submitServe(0);
  }
  game.pointerX = null;
  if (game.match) game.keyTarget = game.match.state.paddles[0].tx;
});
ui.canvas.addEventListener('pointercancel', () => { game.pointerX = null; });

// Keyboard control.
let remapKey = null;
document.addEventListener('keydown', (e) => {
  if (remapKey) {
    e.preventDefault();
    settings.controls.keys[remapKey] = e.code;
    remapKey = null;
    saveSettings();
    app.toast('Key updated.');
    refreshSettingsScreen();
    return;
  }
  if (game.phase !== 'active') return;
  if (e.target.matches('input, select, textarea')) return;
  const k = settings.controls.keys;
  if (e.code === k.left || e.code === k.right) {
    game.keysHeld.add(e.code);
    e.preventDefault();
  } else if (e.code === k.serve) {
    submitServe(0);
    e.preventDefault();
  } else if (e.code === k.pause && !app.stack.length) {
    openPause();
    e.preventDefault();
  } else if (e.code === k.undo) {
    doUndo();
  } else if (e.code === k.camera) {
    toggleCamera();
  } else if (e.code === k.hint) {
    showHint();
  }
});
document.addEventListener('keyup', (e) => {
  game.keysHeld.delete(e.code);
  if (game.match && game.keysHeld.size === 0) game.keyTarget = game.match.state.paddles[0].tx;
});

function toggleCamera() {
  settings.camera.view = settings.camera.view === 'broadcast' ? 'behind' : 'broadcast';
  renderer?.setView(settings.camera.view);
  saveSettings();
  app.toast(`Camera: ${settings.camera.view}`);
}

function showHint() {
  const m = game.match;
  if (!m) return;
  if (game.lesson) {
    const step = game.lesson.def.steps[game.lesson.stepIndex];
    if (step) app.toast(step.hint, { ms: 3600 });
    return;
  }
  if (m.state.phase === PHASE.SERVE) {
    app.toast(m.state.server === 0 ? 'Your serve — press Space or tap the ball.' : 'Opponent serves. Get ready.');
  } else {
    app.toast('Meet the ball with your paddle; edge hits bend the angle.');
  }
}

function doUndo() {
  if (!game.match?.allowUndo) {
    app.toast('Undo is only available in practice and lessons.', { kind: 'error' });
    return;
  }
  if (game.match.undo()) {
    audio.undo();
    app.toast('Undone — back to the last serve.');
    updateHud();
    if (app.isOpen('pause')) app.close('pause');
    game.phase = 'active';
  } else {
    app.toast('Nothing to undo yet.', { kind: 'error' });
  }
}

// Background tab: pause solo simulation and keep a safe snapshot.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (game.phase === 'active') openPause();
    audio.suspend();
  } else {
    audio.resume();
  }
});

// ---------------------------------------------------------------------------
// Action routing (every data-action emitted by screens.js + HUD)
// ---------------------------------------------------------------------------

function handleBack() {
  const top = app.top();
  audio.ui('back');
  if (top === 'pause') resumeMatch();
  else if (top) app.close();
  else if (game.phase === 'active') openPause();
}

function handleAction(action, params) {
  audio.ensure();
  if (!['serve', 'pause'].includes(action)) audio.ui('click');
  const daily = game.daily || dailyNow();

  switch (action) {
    // ---- navigation
    case 'quick-play': {
      const diff = PRACTICE_DIFFICULTIES.find((d) => d.id === settings.solo.difficulty) || PRACTICE_DIFFICULTIES[1];
      openSetup(practiceCtx(diff));
      break;
    }
    case 'open-modes': openModes(); break;
    case 'open-journey': app.show('journey', { progress, title: 'Journey' }); break;
    case 'open-daily': app.show('daily', { daily, progress, countdownText: fmtTime(msUntilNextDaily(platform.now()) / 1000), title: 'Daily Pulse' }); break;
    case 'open-profile': app.show('profile', { settings, progress, hosted: platform.hosted, title: 'Profile' }); break;
    case 'open-achievements': app.show('achievements', { progress, title: 'Achievements' }); break;
    case 'open-boards':
      app.show('boards', {
        local: progress.leaderboards.local,
        daily: progress.leaderboards.daily[daily.date] || [],
        date: daily.date,
        title: 'Leaderboards',
      });
      break;
    case 'open-settings': app.show('settings', { settings, tiers: ['auto', ...Object.keys(QUALITY_TIERS)], title: 'Settings' }); break;
    case 'open-help': app.show('help', { settings, title: 'Help' }); break;
    case 'back': handleBack(); break;

    // ---- mode selection
    case 'mode-learn': app.show('learn', { settings, title: 'Learn' }); break;
    case 'mode-journey': app.show('journey', { progress, title: 'Journey' }); break;
    case 'mode-daily': handleAction('open-daily', params); break;
    case 'mode-practice': {
      const diff = PRACTICE_DIFFICULTIES.find((d) => d.id === settings.solo.difficulty) || PRACTICE_DIFFICULTIES[1];
      openSetup(practiceCtx(diff));
      break;
    }
    case 'mode-challenge': app.show('challenges', { progress, title: 'Challenges' }); break;
    case 'mode-hosted': app.show('lobby', { state: 'idle', rooms: platform.hosted ? 'Online services connected.' : 'Offline — online rooms need the host shell. Shared-screen 2P works anywhere.', title: 'Hosted Play' }); break;

    // ---- content picks
    case 'journey-level': {
      const level = getJourneyLevel(params.id);
      if (!level) break;
      openSetup({
        mode: 'journey', contentId: level.id, ref: level,
        title: `Stage ${level.index}: ${level.title}`, brief: level.brief,
        theme: level.theme, seed: level.seed, ruleset: { ...level.ruleset },
        seats: buildSeats('ai', level.ai),
        ranked: false, allowUndo: false,
        objective: level.brief,
      });
      break;
    }
    case 'challenge': {
      const ch = getChallenge(params.id);
      if (!ch) break;
      openSetup({
        mode: 'challenge', contentId: ch.id, ref: ch,
        title: ch.title, brief: ch.brief,
        theme: ch.theme, seed: ch.seed, ruleset: { ...ch.ruleset },
        seats: buildSeats('ai', ch.ai),
        ranked: false, allowUndo: false,
        objective: ch.brief,
      });
      break;
    }
    case 'lesson': {
      const lesson = getLesson(params.id);
      if (!lesson) break;
      startMatch({
        mode: 'learn', contentId: lesson.id, lesson,
        title: lesson.title, brief: lesson.objective,
        theme: 'neon-district', seed: 0x1e550 + lesson.id.length,
        ruleset: { ...lesson.ruleset },
        seats: buildSeats('ai', lesson.ai),
        aiIdle: !!lesson.aiIdle,
        ranked: false, allowUndo: true,
        objective: lesson.objective,
      });
      break;
    }
    case 'play-daily':
      startMatch({
        mode: 'daily', contentId: daily.id,
        title: `Daily Pulse — ${daily.name}`,
        brief: `Shared seed for ${daily.date}. One ranked result per day.`,
        theme: daily.theme, seed: daily.seed, ruleset: { ...daily.ruleset },
        seats: buildSeats('ai', daily.ai),
        ranked: !progress.dailies[daily.date],
        allowUndo: false,
      });
      break;

    // ---- match flow
    case 'start-match': startMatch(); break;
    case 'serve': submitServe(0); break;
    case 'pause': openPause(); break;
    case 'resume': closePauseAnd(resumeMatch); break;
    case 'restart-match': closePauseAnd(() => startMatch()); break;
    case 'leave-match': {
      if (game.match && !game.match.finished && (game.phase === 'active' || game.phase === 'paused')) {
        game.match.submit({ id: nextCmdId(0), player: 0, type: CMD.CONCEDE });
      }
      game.match = null;
      game.lesson = null;
      audio.stopAll();
      platform.activityEnd();
      openModes();
      break;
    }
    case 'undo': closePauseAnd(doUndo); break;

    // ---- results
    case 'results-next': {
      const ctx = game.ctx;
      app.close('results');
      if (ctx?.mode === 'journey' && ctx.ref && game.match?.result?.winner === 0) {
        const next = getJourneyLevel(ctx.ref.index + 1);
        if (next) { handleAction('journey-level', { id: next.id }); break; }
        app.show('journey', { progress, title: 'Journey' });
      } else if (ctx?.mode === 'learn') {
        app.show('learn', { settings, title: 'Learn' });
      } else {
        openModes();
      }
      break;
    }
    case 'results-retry':
      app.close('results');
      platform.telemetry('retry', { mode: game.ctx?.mode });
      if (game.ctx?.lesson) handleAction('lesson', { id: game.ctx.lesson.id });
      else startMatch();
      break;
    case 'results-verify': {
      const rep = game.match?.replay;
      if (!rep) { app.toast('No replay recorded.', { kind: 'error' }); break; }
      const res = verifyReplay(rep);
      app.toast(res.ok ? 'Replay verified — deterministic result confirmed ✓' : `Replay mismatch at tick ${res.mismatchTick}`, { kind: res.ok ? 'success' : 'error', ms: 3600 });
      break;
    }

    // ---- hosted play
    case 'host-local':
      startMatch({
        mode: 'hosted-local', contentId: 'local-2p',
        title: 'Shared-screen 2P',
        brief: 'P1: ← → move, Space serve. P2: A / D move, W serve.',
        theme: 'neon-district', seed: ((Date.now() ^ 0x2b992) >>> 0) || 7,
        ruleset: {},
        seats: buildSeats('human', null, [settings.displayName, 'Player 2']),
        ranked: false, allowUndo: false,
      });
      break;
    case 'host-create':
    case 'host-ready':
    case 'host-start': {
      const error = platform.hosted
        ? 'Online rooms are provided by the host shell in this build.'
        : 'Online rooms need the host shell. Shared-screen 2P works offline.';
      app.close('lobby');
      app.show('lobby', { state: 'idle', error, title: 'Hosted Play' });
      break;
    }
    case 'host-leave': app.close('lobby'); openModes(); break;

    // ---- settings / profile
    case 'remap':
      remapKey = params.key;
      app.toast(`Press a key for “${params.key}”…`, { ms: 4000 });
      break;
    case 'sync-cloud':
      platform.saveCloud({ settings, progress }).then((ok) => {
        app.toast(ok ? 'Cloud save synced.' : 'Cloud save unavailable — local progress is safe.', { kind: ok ? 'success' : 'error' });
      });
      break;
    case 'reset-progress':
      if (window.confirm('Reset ALL progress on this device? This cannot be undone.')) {
        const fresh = defaultProgress();
        Object.assign(progress, fresh);
        saveProgress();
        app.toast('Progress reset.');
        app.close('settings');
      }
      break;
    case 'sign-in':
      app.toast(platform.requestSignIn() ? 'Sign-in requested from the host shell.' : 'Sign-in is offered by the host shell when available.', { kind: 'info' });
      break;
    case 'replay-tutorials': break; // informational checkbox (disabled)

    // ---- snapshot resume
    case 'resume-snapshot': {
      const snap = game.resumeSnapshot;
      if (!snap) break;
      try {
        game.match = LocalMatch.restore(snap.json, BUILD);
        game.ctx = {
          mode: game.match.mode, contentId: game.match.contentId,
          title: 'Resumed match', brief: '',
          theme: 'neon-district', seed: game.match.state.seed,
          ruleset: game.match.state.ruleset,
          seats: game.match.seats,
          ranked: false, allowUndo: game.match.allowUndo,
        };
        renderer.build(game.match.state.ruleset, 'neon-district', { side: 0, cvd: settings.accessibility.palette, view: settings.camera.view });
        app.closeAll();
        ui.hud.hidden = false;
        ui.name0.textContent = game.match.seats[0].name || 'You';
        ui.name1.textContent = game.match.seats[1].name || 'Opponent';
        ui.objective.textContent = 'Resumed match.';
        ui.sub.textContent = '';
        updateHud();
        resumeMatch();
      } catch {
        app.toast('Snapshot could not be restored.', { kind: 'error' });
        storage.clear('snapshot');
        game.resumeSnapshot = null;
      }
      break;
    }
    case 'discard-snapshot':
      storage.clear('snapshot');
      game.resumeSnapshot = null;
      app.close('resume');
      break;

    default:
      app.toast(`Unknown action: ${action}`, { kind: 'error' });
  }
}

function practiceCtx(diff) {
  return {
    mode: 'practice', contentId: 'practice-' + diff.id, ref: diff,
    title: `Practice — ${diff.name}`,
    brief: 'Unranked. Restart and undo are always available.',
    theme: 'neon-district',
    seed: (Date.now() ^ 0x9e3779b9) >>> 0,
    ruleset: { ...diff.ruleset },
    seats: buildSeats('ai', diff.ai),
    ranked: false, allowUndo: true,
  };
}

function refreshSettingsScreen() {
  if (app.isOpen('settings')) {
    app.close('settings');
    app.show('settings', { settings, tiers: ['auto', ...Object.keys(QUALITY_TIERS)], title: 'Settings' });
  }
}

// Shared-screen 2P: second player on A/D + W.
document.addEventListener('keydown', (e) => {
  if (game.phase !== 'active' || game.ctx?.mode !== 'hosted-local' || !game.match) return;
  const m = game.match;
  const half = m.state.ruleset.arena.w / 2 - m.state.paddles[1].halfW;
  if (e.code === 'KeyA') m.submit({ id: nextCmdId(1), player: 1, type: CMD.MOVE, x: Math.max(-half, m.state.paddles[1].tx - 2) });
  else if (e.code === 'KeyD') m.submit({ id: nextCmdId(1), player: 1, type: CMD.MOVE, x: Math.min(half, m.state.paddles[1].tx + 2) });
  else if (e.code === 'KeyW') m.submit({ id: nextCmdId(1), player: 1, type: CMD.SERVE });
});

// ---------------------------------------------------------------------------
// Settings inputs (change events are not data-action clicks)
// ---------------------------------------------------------------------------

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.setting != null) {
    const path = el.dataset.setting;
    const value = el.type === 'checkbox' ? el.checked : el.value;
    setPath(settings, path, value);
    saveSettings();
    applySettings();
    platform.telemetry('settings-change', { key: path });
    if (path.startsWith('controls.')) refreshSettingsScreen();
  } else if (el.dataset.audio != null) {
    settings.audio[el.dataset.audio] = Number(el.value);
    saveSettings();
    applySettings();
    const label = el.closest('.slider-row')?.querySelector('.slider-val');
    if (label) label.textContent = Math.round(Number(el.value) * 100) + '%';
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.settingRange != null) {
    setPath(settings, el.dataset.settingRange, Number(el.value));
    saveSettings();
    applySettings();
    const label = el.closest('.slider-row')?.querySelector('.slider-val');
    if (label) label.textContent = Math.round(Number(el.value) * 100) + '%';
  } else if (el.dataset.audio != null) {
    settings.audio[el.dataset.audio] = Number(el.value);
    saveSettings();
    applySettings();
    const label = el.closest('.slider-row')?.querySelector('.slider-val');
    if (label) label.textContent = Math.round(Number(el.value) * 100) + '%';
  }
});

// Forms (join-by-code, profile name).
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === 'profile') {
    const name = String(new FormData(form).get('displayName') || '').trim().slice(0, 24);
    settings.displayName = name || 'Guest';
    saveSettings();
    app.toast('Profile saved.', { kind: 'success' });
    app.close('profile');
  } else if (form.dataset.form === 'join') {
    app.close('lobby');
    app.show('lobby', {
      state: 'idle',
      error: 'Online rooms need the host shell. Shared-screen 2P works offline.',
      title: 'Hosted Play',
    });
  }
});

// After the title screen is up, offer snapshot resume if one exists.
const origGoTitle = goTitle;
goTitle = function () {
  origGoTitle();
  if (game.resumeSnapshot) {
    const ago = Math.max(1, Math.round((Date.now() - game.resumeSnapshot.savedAt) / 1000));
    app.show('resume', { tickSeconds: fmtTime(ago) + ' (' + ago + 's)', title: 'Match in progress' });
  }
};

boot();
