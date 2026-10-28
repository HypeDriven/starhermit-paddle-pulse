// Paddle Pulse on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, AI, session and content
// (js/rules/*.js, js/session/*.js, js/content/*.js) are the browser build's,
// unchanged in what they decide; this module is what js/main.js did around
// them: the flow (boot → title → mode screens → setup → 3-2-1 countdown →
// active ⇄ paused → results → next stage / retry / modes), input into the
// session's validated commands (keys and pads through the runtime's actions,
// drags and taps on the arena, the HUD's Serve and Pause, the shared-screen
// second player), the lessons' step checks, hints, undo and the camera, the
// rules events' presentation (sparks and shake in render.ts, sounds and
// captions in audio.ts, live announcements), results with their breakdown,
// stars, achievements, the local and daily boards and posting the longest
// rally, the resume snapshot, and the lifecycle (a hidden window pauses solo
// play, as visibilitychange did). The screens and HUD are drawn by screens.ts
// (starhermit:ui), the arena by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps at the rules' 120 Hz (js/rules/engine.js
// TICK_RATE): one rules tick per fixed step while a match is active, so
// pauses, a hidden window and slow frames never cost time and play scripts
// replay exactly. The countdown, the results delay and the lessons' close-out
// (setInterval / setTimeout in the browser build) count the same steps, and
// the arena is drawn between steps by the frame's interpolation.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { isDown, onAction, onPointerButton, onPointerMove, onTouch, value, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, reportBug, requestSignIn } from "starhermit:platform";
import {
  Ach, Daily, Levels, Rules, Sess, Store, Themes, Tutorials, type Breakdown, type Challenge, type Daily as DailyCard, type Difficulty, type Lesson,
  type Level, type Match, type Ruleset, type RulesEvent, type Seat, type Terminal,
} from "./game.ts";
import * as audio from "./audio.ts";
import { fmtTime, t, tc } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

const TICK = Rules.TICK_RATE;
const DT = Rules.DT;
const BUILD = "engine-1.0";
export const settings = platform.settings;
export const progress = platform.progress;

export type Screen =
  | "title" | "modes" | "journey" | "challenges" | "learn" | "setup" | "daily" | "lobby" | "pause" | "results" | "settings"
  | "achievements" | "boards" | "help" | "profile" | "resume";
export type Phase = "boot" | "title" | "setup" | "countdown" | "active" | "paused" | "resolving" | "results";
export interface Ctx {
  mode: string; contentId: string; title: string; brief: string; objective?: string; theme: string; seed: number;
  ruleset: Partial<Ruleset>; seats: Seat[]; allowUndo: boolean; ranked: boolean; aiIdle?: boolean;
  ref?: Level | Challenge | Difficulty; lesson?: Lesson; daily?: DailyCard; startLabel?: string;
}
export interface ResultsView {
  title: string; headline: string; sub: string; breakdown: [string, string][]; starsEarned: number | null;
  unlocked: { name: string; desc: string; icon: string }[]; nextLabel: string; canVerify: boolean; won: boolean;
}

export const app = {
  /** Screens open over the arena, top last (js/ui/app.js's stack). */
  stack: [] as Screen[],
  phase: "boot" as Phase,
  match: null as Match | null,
  ctx: null as Ctx | null,
  lesson: null as { def: Lesson; stepIndex: number } | null,
  angledHits: 0,
  /** Frame the top screen opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  countdown: "" as string,
  objective: "",
  sub: "",
  results: null as ResultsView | null,
  lb: null as platform.Posted | "posting" | null,
  boards: null as platform.BoardLine[] | null | "loading",
  confirmReset: false,
  nameField: "",
  reportField: "",
  reportSending: false,
  resumeAgo: 0,
  toasts: [] as { text: string; kind: string; until: number }[],
  caption: null as { text: string; until: number } | null,
};
const now = (): number => frame().time;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** app.js toast(): kind info | success | error, `ms` long; errors are also announced. */
export function toast(text: string, kind = "info", ms = 2600): void {
  app.toasts.push({ text, kind, until: now() + ms / 1000 });
  while (app.toasts.length > 4) app.toasts.shift();
  if (kind === "error") announce(text, true);
}
/** Audio captions arrive as English cue ids ('[serve]'); shown in the game language (main.js CAPTION_KEYS). */
const CAPTION_KEYS: Record<string, string> = {
  "[serve]": "caption.serve", "[goal for you]": "caption.goalFor", "[goal conceded]": "caption.goalAgainst",
  "[victory]": "caption.victory", "[defeat]": "caption.defeat", "[action not allowed]": "caption.invalid", "[go]": "caption.go",
};
function showCaption(cue: string): void {
  if (!settings.accessibility.captions) return;
  app.caption = { text: CAPTION_KEYS[cue] ? `[${t(CAPTION_KEYS[cue]!)}]` : cue, until: now() + 1.8 };
}
/** setTimeout on the fixed steps. */
const timers: { left: number; fn: () => void }[] = [];
function after(ms: number, fn: () => void): void { timers.push({ left: ms / 1000, fn }); }
const pendingActs: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pendingActs.push(fn); }

export function playerName(): string {
  if (platform.signedIn() && platform.displayName()) return platform.displayName();
  return settings.displayName === "Guest" ? t("common.guest") : settings.displayName;
}
export function dailyNow(): DailyCard { return Daily.dailyContent(Daily.utcDateString(platform.nowMs())); }
export function msUntilNextDaily(): number { return Daily.msUntilNextDaily(platform.nowMs()); }
export function reducedMotion(): boolean { return preferences().reducedMotion; }
function haptic(ms: number): void {
  if (!settings.accessibility.haptics) return;
  try { vibrate(ms); } catch { /* no motor */ }
}

// ------------------------------------------------------------------ screens
export function top(): Screen | null { return app.stack[app.stack.length - 1] ?? null; }
export function isOpen(s: Screen): boolean { return app.stack.includes(s); }
function opened(focus: string | null): void {
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  app.confirmReset = false;
  ui.setFocus(null);
}
/** app.js show(): the screen on top (moved there when already open). */
export function show(s: Screen, focus: string | null = null): void {
  app.stack = app.stack.filter((x) => x !== s);
  app.stack.push(s);
  if (s === "profile") app.nameField = settings.displayName === "Guest" ? "" : settings.displayName;
  if (s === "boards") refreshBoards();
  opened(focus);
}
/** app.js close(): the named screen (the top one by default). */
export function close(s: Screen | null = null): void {
  const name = s ?? top();
  app.stack = app.stack.filter((x) => x !== name);
  opened(null);
}
export function closeAll(): void { app.stack = []; opened(null); }

function goTitle(): void {
  app.phase = "title";
  app.match = null;
  app.lesson = null;
  closeAll();
  render.showAttract();
  show("title", "btn-play");
  const snap = resumeSnapshot();
  if (snap) {
    app.resumeAgo = Math.max(1, Math.round((Date.now() - snap.savedAt) / 1000));
    show("resume", "btn-resume-snapshot");
  }
}

// ------------------------------------------------------------------ match contexts (main.js localizeCtx)
export function localizeCtx(ctx: Ctx): Ctx {
  if (ctx.mode === "journey" && ctx.ref) {
    const l = ctx.ref as Level;
    ctx.title = t("match.stageTitle", { n: l.index, title: tc(l.title) });
    ctx.brief = ctx.objective = tc(l.brief);
  } else if (ctx.mode === "challenge" && ctx.ref) {
    const c = ctx.ref as Challenge;
    ctx.title = tc(c.title);
    ctx.brief = ctx.objective = tc(c.brief);
  } else if (ctx.mode === "learn" && ctx.lesson) {
    ctx.title = tc(ctx.lesson.title);
    ctx.brief = ctx.objective = tc(ctx.lesson.objective);
  } else if (ctx.mode === "daily" && ctx.daily) {
    ctx.title = t("match.dailyTitle", { name: tc(ctx.daily.name) });
    ctx.brief = t("match.dailyBrief", { date: ctx.daily.date });
  } else if (ctx.mode === "practice" && ctx.ref) {
    ctx.title = t("match.practiceTitle", { name: tc((ctx.ref as Difficulty).name) });
    ctx.brief = t("match.practiceBrief");
  } else if (ctx.mode === "hosted-local") {
    ctx.title = t("match.localTitle");
    ctx.brief = t("match.localBrief");
  } else if (ctx.mode === "resumed") {
    ctx.title = ctx.objective = t("match.resumed");
    ctx.brief = "";
  }
  return ctx;
}
function buildSeats(kind: "ai" | "human", aiLevel: number | null, names?: string[]): Seat[] {
  const lv = aiLevel ?? 2;
  return [
    { kind: "human", name: names?.[0] || playerName() },
    kind === "ai" ? { kind: "ai", level: lv, name: Levels.AI_LEVELS[lv]!.name } : { kind: "human", name: names?.[1] || t("match.player2") },
  ];
}
/** A practice seed: the device clock (Date.now) as before, so practice matches differ. */
function practiceCtx(diff: Difficulty): Ctx {
  return localizeCtx({
    mode: "practice", contentId: "practice-" + diff.id, ref: diff, theme: "neon-district", seed: (Date.now() ^ 0x9e3779b9) >>> 0,
    ruleset: { ...diff.ruleset }, seats: buildSeats("ai", diff.ai), ranked: false, allowUndo: true, title: "", brief: "",
  });
}
export function journeyCtx(level: Level): Ctx {
  return localizeCtx({
    mode: "journey", contentId: level.id, ref: level, theme: level.theme, seed: level.seed, ruleset: { ...level.ruleset },
    seats: buildSeats("ai", level.ai), ranked: false, allowUndo: false, title: "", brief: "",
  });
}
export function challengeCtx(ch: Challenge): Ctx {
  return localizeCtx({
    mode: "challenge", contentId: ch.id, ref: ch, theme: ch.theme, seed: ch.seed, ruleset: { ...ch.ruleset },
    seats: buildSeats("ai", ch.ai), ranked: false, allowUndo: false, title: "", brief: "",
  });
}
export function currentDifficulty(): Difficulty {
  return Levels.PRACTICE_DIFFICULTIES.find((d) => d.id === settings.solo.difficulty) ?? Levels.PRACTICE_DIFFICULTIES[1]!;
}

// ------------------------------------------------------------------ actions from the screens
export function click(): void { audio.ui("click"); }
export function openSetup(ctx: Ctx): void {
  app.ctx = ctx;
  app.phase = "setup";
  show("setup", "btn-start-match");
}
export function quickPlay(): void { click(); openSetup(practiceCtx(currentDifficulty())); }
export function setDifficulty(id: string): void {
  click();
  settings.solo.difficulty = id;
  platform.saveSettings();
  if (app.ctx?.mode === "practice") app.ctx = practiceCtx(currentDifficulty());
}
export function openScreen(s: Screen, focus: string | null = null): void { click(); show(s, focus); }
export function playLesson(lesson: Lesson): void {
  click();
  startMatch(localizeCtx({
    mode: "learn", contentId: lesson.id, lesson, theme: "neon-district", seed: 0x1e550 + lesson.id.length, ruleset: { ...lesson.ruleset },
    seats: buildSeats("ai", lesson.ai), aiIdle: !!lesson.aiIdle, ranked: false, allowUndo: true, title: "", brief: "",
  }));
}
export function playDaily(): void {
  click();
  const d = dailyNow();
  startMatch(localizeCtx({
    mode: "daily", contentId: d.id, daily: d, theme: d.theme, seed: d.seed, ruleset: { ...d.ruleset }, seats: buildSeats("ai", d.ai),
    ranked: !progress.dailies[d.date], allowUndo: false, title: "", brief: "",
  }));
}
export function hostLocal(): void {
  click();
  startMatch(localizeCtx({
    mode: "hosted-local", contentId: "local-2p", theme: "neon-district", seed: ((Date.now() ^ 0x2b992) >>> 0) || 7, ruleset: {},
    seats: buildSeats("human", null, [playerName(), t("match.player2")]), ranked: false, allowUndo: false, title: "", brief: "",
  }));
}
/** A page's Back, Escape or the pad's East (main.js handleBack). */
export function back(): void {
  const s = top();
  audio.ui("back");
  if (s === "pause") { resumeMatch(); return; }
  if (s === "title") return;
  if (s === "setup" && app.phase === "setup") app.phase = "title";
  if (s) close();
  if (!app.stack.length && app.phase !== "active" && app.phase !== "countdown" && app.phase !== "paused" && app.phase !== "resolving") goTitle();
}
export function leaveMatch(): void {
  const m = app.match;
  if (m && !m.finished && (app.phase === "active" || app.phase === "paused" || app.phase === "countdown")) {
    m.submit({ id: Sess.nextCmdId(0), player: 0, type: Rules.CMD.CONCEDE });
  }
  try { platform.storage.clear("snapshot"); } catch { /* none */ }
  app.match = null;
  app.lesson = null;
  audio.stopAll();
  closeAll();
  app.phase = "title";
  render.showAttract();
  show("title");
  show("modes", "mode-learn");
}

// ------------------------------------------------------------------ the match
function effectiveRuleset(ctx: Ctx): Partial<Ruleset> {
  const r = { ...ctx.ruleset };
  if (settings.accessibility.timingAssist && ctx.seats[1]!.kind === "ai") r.paddleWidth = (r.paddleWidth ?? 3.4) * 1.25; // declared assist, solo only
  return r;
}
let keyTarget = 0;
let p2Target = 0;
let pointerX: number | null = null;
let lastMoveSent = 0;
let keyOrigin: number | null = null;
let keyDir = 0;
let lastInvalidToast = -10;
export function startMatch(ctx: Ctx | null = app.ctx): void {
  if (!ctx) return;
  app.ctx = ctx;
  closeAll();
  app.match = new Sess.LocalMatch({
    seats: ctx.seats, mode: ctx.mode, contentId: ctx.contentId, ruleset: effectiveRuleset(ctx), seed: ctx.seed, allowUndo: !!ctx.allowUndo,
    build: BUILD, aiIdle: !!ctx.aiIdle,
  });
  app.lesson = ctx.lesson ? { def: ctx.lesson, stepIndex: 0 } : null;
  app.angledHits = 0;
  app.results = null;
  app.lb = null;
  keyTarget = 0;
  p2Target = 0;
  lastMoveSent = 0;
  keyOrigin = null;
  pointerX = null;
  timers.length = 0;
  render.build(app.match.state.ruleset, ctx.theme || "neon-district", { side: 0, cvd: settings.accessibility.palette, view: settings.camera.view });
  const theme = ctx.theme || "neon-district";
  audio.startTheme(themeBed(theme));
  app.objective = ctx.objective || t("hud.objectiveDefault", { score: app.match.state.ruleset.targetScore, margin: app.match.state.ruleset.winMargin });
  updateHudSub();
  announce(t("announce.matchStart", { title: ctx.title, objective: app.objective }));
  app.phase = "countdown";
  runCountdown(() => { app.phase = "active"; });
}
function themeBed(themeId: string): { root: number; mood: string } { return Themes.getTheme(themeId).ambience; }
let countdownGen = 0;
/** main.js runCountdown: 3, 2, 1, GO every 650 ms, then play. */
function runCountdown(done: () => void): void {
  const gen = ++countdownGen;
  let n = 3;
  app.countdown = String(n);
  audio.countdown(n);
  const tick = (): void => {
    if (gen !== countdownGen) return;
    n--;
    app.countdown = n > 0 ? String(n) : t("hud.go");
    audio.countdown(n);
    if (n < 0) { app.countdown = ""; done(); return; }
    after(650, tick);
  };
  after(650, tick);
}
export function updateHudSub(): void {
  const m = app.match;
  if (!m) return;
  if (app.lesson) {
    const step = app.lesson.def.steps[app.lesson.stepIndex];
    app.sub = step ? tc(step.text) : t("lesson.headline");
  } else {
    let sub = app.ctx?.brief || t("hud.subFmt", { target: m.state.ruleset.targetScore, margin: m.state.ruleset.winMargin });
    if (!settings.tutorialDone["t-move"]) sub += " · " + t("hud.firstHint");
    app.sub = sub;
  }
}
/** The HUD's Serve: enabled when the player holds the serve. */
export function canServe(): boolean {
  const m = app.match;
  return !!m && app.phase === "active" && m.state.phase === Rules.PHASE.SERVE && m.state.server === 0;
}

export function openPause(): void {
  if (app.phase !== "active" && app.phase !== "countdown") return;
  countdownGen++; // a pause during the countdown restarts it on resume
  app.countdown = "";
  app.phase = "paused";
  saveSnapshot();
  show("pause", "btn-resume");
  announce(t("toast.paused"));
}
export function resumeMatch(): void {
  closeAll();
  try { platform.storage.clear("snapshot"); } catch { /* none */ }
  app.phase = "countdown";
  runCountdown(() => { app.phase = "active"; });
}
export function restartMatch(): void { click(); startMatch(); }
export function canUndo(): boolean { return !!app.match?.allowUndo && app.match.snapshots.length > 0; }
export function doUndo(): void {
  const m = app.match;
  if (!m?.allowUndo) { toast(t("toast.undoOnly"), "error"); return; }
  if (m.undo()) {
    audio.undo();
    toast(t("toast.undone"));
    if (isOpen("pause")) close("pause");
    app.phase = "active";
  } else toast(t("toast.nothingToUndo"), "error");
}
export function toggleCamera(): void {
  settings.camera.view = settings.camera.view === "broadcast" ? "behind" : "broadcast";
  render.setView(settings.camera.view);
  platform.saveSettings();
  toast(t("toast.camera", { view: t(settings.camera.view === "behind" ? "settings.camBehind" : "settings.camBroadcast") }));
}
export function showHint(): void {
  const m = app.match;
  if (!m) return;
  if (app.lesson) {
    const step = app.lesson.def.steps[app.lesson.stepIndex];
    if (step) toast(tc(step.hint), "info", 3600);
    return;
  }
  if (m.state.phase === Rules.PHASE.SERVE) toast(m.state.server === 0 ? t("toast.yourServe") : t("toast.oppServe"));
  else toast(t("toast.meetBall"));
}

function submitMove(player: number, x: number): void {
  const m = app.match;
  if (!m || m.finished) return;
  if (player === 0 && Math.abs(x - lastMoveSent) < 0.05) return;
  if (player === 0) lastMoveSent = x;
  const prevTx = m.state.paddles[player]!.tx;
  const res = m.submit({ id: Sess.nextCmdId(player), player, type: Rules.CMD.MOVE, x });
  if (!res.ok) explainInvalid(res.reason ?? "");
  // The Move lesson asks for a move of more than half a unit: a held key sends the target in quarter-unit steps,
  // so its moves count from where the paddle was when the key went down (the browser build only saw drags pass).
  else if (app.lesson && player === 0) lessonEvent({ t: "cmd", type: "move", dx: x - (keyOrigin ?? prevTx) });
}
export function submitServe(player = 0): void {
  const m = app.match;
  if (!m || app.phase !== "active") return;
  const res = m.submit({ id: Sess.nextCmdId(player), player, type: Rules.CMD.SERVE });
  if (!res.ok) explainInvalid(res.reason ?? "");
}
function explainInvalid(reason: string): void {
  if (now() - lastInvalidToast < 1) return;
  lastInvalidToast = now();
  const key = ({
    "match-finished": "invalid.finished", "not-serve-phase": "invalid.notServePhase", "not-your-serve": "invalid.notYourServe",
    "out-of-bounds": "invalid.outOfBounds", "move-limit-exceeded": "invalid.moveLimit",
  } as Record<string, string>)[reason] ?? "invalid.fallback";
  toast(t(key), "error");
}

function lessonEvent(evt: Record<string, unknown>): void {
  const l = app.lesson;
  if (!l) return;
  const step = l.def.steps[l.stepIndex];
  if (!step || !Tutorials.stepSatisfied(step, evt)) return;
  l.stepIndex++;
  const next = l.def.steps[l.stepIndex];
  if (next) {
    toast(tc(next.text), "success", 3400);
    app.sub = tc(next.text);
    return;
  }
  settings.tutorialDone[l.def.id] = true;
  platform.saveSettings();
  toast(t("lesson.complete", { objective: tc(l.def.objective) }), "success", 3200);
  if (l.def.id === "t-score") return;
  // Lessons that don't end by winning: close out cleanly.
  app.phase = "resolving";
  const def = l.def;
  after(700, () => {
    app.phase = "results";
    audio.stopAll();
    app.lb = null;
    app.results = {
      title: t("lesson.headline"), headline: t("lesson.headline"), sub: tc(def.objective),
      breakdown: [[t("lesson.lesson"), tc(def.title)], [t("lesson.steps"), String(def.steps.length)]],
      starsEarned: null, unlocked: [], nextLabel: t("lesson.backToLearn"), canVerify: false, won: true,
    };
    show("results", "btn-results-next");
  });
}

// ------------------------------------------------------------------ results and progress
function endMatch(): void {
  const m = app.match!, ctx = app.ctx!;
  app.phase = "resolving";
  audio.setIntensity(0.2);
  after(900, () => { if (app.match === m) showResults(m, ctx); });
}
function countMasteryCleared(): number {
  return Levels.JOURNEY_LEVELS.filter((l) => l.mastery && (progress.journey[l.id]?.stars || 0) > 0).length;
}
function showResults(m: Match, ctx: Ctx): void {
  app.phase = "results";
  try { platform.storage.clear("snapshot"); } catch { /* none */ }
  const terminal = m.result!;
  const won = terminal.winner === 0;
  const bd = terminal.breakdown;
  recordProgress(ctx, won, terminal);
  let starsEarned: number | null = null;
  if (ctx.mode === "journey" && won && ctx.ref) {
    const lv = ctx.ref as Level;
    const par = lv.goals.par;
    starsEarned = 1 + (bd.goals[1]! <= par.star2 ? 1 : 0) + (bd.goals[1]! <= par.star3 ? 1 : 0);
    const rec = progress.journey[lv.id] || { stars: 0, wins: 0 };
    rec.stars = Math.max(rec.stars, starsEarned);
    rec.wins = (rec.wins || 0) + 1;
    progress.journey[lv.id] = rec;
    if (lv.mastery) progress.totals.masteryCleared = Math.max(progress.totals.masteryCleared, countMasteryCleared());
  }
  const unlocked = awardAchievements(m, won);
  if (starsEarned) for (let s = 0; s < starsEarned; s++) after(300 + s * 250, () => audio.ui("star"));
  let nextLabel = t("common.cont");
  if (ctx.mode === "journey" && won && ctx.ref) {
    const next = Levels.getJourneyLevel((ctx.ref as Level).index + 1);
    nextLabel = next ? t("results.nextStage", { title: tc(next.title) }) : t("results.journeyDone");
  }
  platform.saveProgress();
  audio.stopAll();
  const headline = won ? t("results.victory") : terminal.reason === "match-conceded" ? t("results.conceded") : t("results.defeat");
  app.results = {
    title: "Results", headline, sub: t("results.sub", { title: ctx.title, a: bd.goals[0]!, b: bd.goals[1]! }), breakdown: breakdownRows(terminal),
    starsEarned, unlocked, nextLabel, canVerify: true, won,
  };
  show("results", "btn-results-next");
  postToLeaderboard(ctx, bd);
  announce(t("announce.result", { headline: won ? t("results.victory") : t("results.defeat"), a: bd.goals[0]!, b: bd.goals[1]! }), true);
}
export function breakdownRows(terminal: Terminal): [string, string][] {
  const bd = terminal.breakdown;
  return [
    [t("results.finalScore"), `${bd.goals[0]} – ${bd.goals[1]}`],
    [t("setup.ruleTarget"), t("results.targetRow", { score: bd.targetScore, margin: bd.winMargin })],
    [t("results.rallies"), String(bd.rallies)],
    [t("results.longestRow"), t("results.longest", { n: bd.longestRally })],
    [t("results.returns"), String(bd.hits[0])],
    [t("results.fastestRow"), t("results.fastest", { v: bd.fastestReturn })],
    [t("results.duration"), fmtTime(bd.elapsedSeconds)],
    [t("results.reason"), t("reason." + terminal.reason)],
  ];
}
let lbSeq = 0;
/** Signed in: Journey, Daily and Challenge matches post their longest rally (score-script.js) and show the rank. */
function postToLeaderboard(ctx: Ctx, bd: Breakdown): void {
  const seq = ++lbSeq;
  app.lb = null;
  if (!platform.signedIn() || !["journey", "daily", "challenge"].includes(ctx.mode)) return;
  app.lb = "posting";
  void platform.postLongestRally(bd.longestRally | 0).then((r) => { if (seq === lbSeq) app.lb = r; });
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return t("results.lbPosting");
  return !r.posted ? t("results.lbNotPosted") : r.rank ? t("results.lbRank", { rank: r.rank }) : t("results.lbPosted");
}
function recordProgress(ctx: Ctx, won: boolean, terminal: Terminal): void {
  progress.totals.matches++;
  progress.totals.angledHits += app.angledHits;
  if (won) {
    progress.totals.wins++;
    progress.streak.current++;
    progress.streak.best = Math.max(progress.streak.best, progress.streak.current);
  } else progress.streak.current = 0;
  progress.rating.matches++;
  progress.rating.mu = Math.max(1, progress.rating.mu + (won ? 0.5 : -0.35));
  if (ctx.mode === "challenge" && won && ctx.ref) progress.challenges[ctx.ref.id] = { cleared: true, best: terminal.score.join("-") };
  if (ctx.mode === "daily" && ctx.ranked) {
    // One ranked result per day: the match context carries the day's date.
    const date = ctx.contentId.startsWith("daily-") ? ctx.contentId.slice(6) : dailyNow().date;
    if (!progress.dailies[date]) {
      progress.dailies[date] = {
        won, score: [...terminal.score], duration: Math.round(terminal.breakdown.elapsedSeconds), seed: ctx.seed, rulesetVersion: Daily.DAILY_RULESET_VERSION,
      };
      const entry = {
        name: playerName(), score: terminal.score[0]!, duration: Math.round(terminal.breakdown.elapsedSeconds),
        rulesetVersion: Daily.DAILY_RULESET_VERSION, seed: ctx.seed, assists: settings.accessibility.timingAssist,
      };
      if (Store.validateLeaderboardEntry(entry, { targetScore: 99 }).ok) {
        const board = (progress.leaderboards.daily[date] ||= []);
        board.push(entry);
        board.sort((a, b) => b.score - a.score || a.duration - b.duration);
        progress.leaderboards.daily[date] = board.slice(0, 20);
      }
    }
  }
  const local = progress.leaderboards.local;
  const me = local.find((e) => e.name === playerName());
  if (me) {
    me.score = progress.totals.wins;
    me.duration = Math.min(me.duration, Math.round(terminal.breakdown.elapsedSeconds));
  } else local.push({ name: playerName(), score: progress.totals.wins, duration: Math.round(terminal.breakdown.elapsedSeconds) });
  local.sort((a, b) => b.score - a.score || a.duration - b.duration);
  progress.leaderboards.local = local.slice(0, 20);
}
function awardAchievements(m: Match, won: boolean): ResultsView["unlocked"] {
  const unlocked: ResultsView["unlocked"] = [];
  const grant = (key: string, prog: number | null = null): void => {
    const rec = (progress.achievements[key] ||= { at: null, progress: 0 });
    if (prog != null) rec.progress = Math.max(rec.progress, prog);
    const def = Ach.getAchievement(key)!;
    const done = def.progress ? rec.progress >= def.progress : true;
    if (!rec.at && done) {
      rec.at = Date.now();
      unlocked.push(def);
      audio.ui("unlock");
      toast(t("toast.achievement", { name: tc(def.name) }), "success");
    }
  };
  const cleared = Object.values(progress.journey).filter((j) => j.stars > 0).length;
  if (won) grant("first-win");
  grant("angle-master", progress.totals.angledHits);
  grant("streak-5", progress.streak.current);
  grant("mastery-all", countMasteryCleared());
  grant("centurion", progress.totals.matches);
  grant("daily-devotee", Object.keys(progress.dailies).length);
  grant("journey-half", Math.min(20, cleared));
  grant("journey-complete", cleared);
  if (won && m.state.score[1] === 0 && app.ctx?.mode !== "learn") grant("untouchable");
  grant("challenger", Levels.CHALLENGES.filter((c) => progress.challenges[c.id]?.cleared).length);
  return unlocked;
}
export function resultsNext(): void {
  click();
  const ctx = app.ctx;
  close("results");
  if (ctx?.mode === "journey" && ctx.ref && app.match?.result?.winner === 0) {
    const next = Levels.getJourneyLevel((ctx.ref as Level).index + 1);
    if (next) { toTitleThen("journey"); openSetup(journeyCtx(next)); return; }
    toTitleThen("journey");
  } else if (ctx?.mode === "learn") toTitleThen("learn");
  else toTitleThen("modes");
}
function toTitleThen(s: Screen): void {
  app.match = null;
  app.lesson = null;
  app.phase = "title";
  render.showAttract();
  closeAll();
  show("title");
  show(s, null);
}
export function resultsRetry(): void {
  click();
  close("results");
  if (app.ctx?.lesson) playLesson(app.ctx.lesson);
  else startMatch();
}
export function resultsVerify(): void {
  click();
  const rep = app.match?.replay;
  if (!rep) { toast(t("toast.noReplay"), "error"); return; }
  const res = Rules.verifyReplay(rep);
  toast(res.ok ? t("toast.replayOk") : t("toast.replayBad", { tick: res.mismatchTick ?? -1 }), res.ok ? "success" : "error", 3600);
}

// ------------------------------------------------------------------ the resume snapshot
function saveSnapshot(): void {
  const m = app.match;
  if (!m || m.finished || app.ctx?.mode === "hosted-local") return;
  platform.storage.saveDoc("snapshot", { v: 1, savedAt: Date.now(), json: m.snapshot(), ctx: { mode: app.ctx?.mode, theme: app.ctx?.theme } });
}
function resumeSnapshot(): { json: string; savedAt: number; theme: string } | null {
  const snap = platform.storage.loadDoc<{ json?: string; savedAt?: number; ctx?: { theme?: string } }>("snapshot");
  if (!snap?.data?.json) return null;
  try {
    const parsed = JSON.parse(snap.data.json) as { state?: { phase?: string } };
    if (parsed?.state?.phase === Rules.PHASE.OVER) return null;
  } catch { return null; }
  return { json: snap.data.json, savedAt: snap.data.savedAt || snap.updatedAt || Date.now(), theme: snap.data.ctx?.theme || "neon-district" };
}
export function resumeFromSnapshot(): void {
  click();
  const snap = resumeSnapshot();
  if (!snap) { close("resume"); return; }
  try {
    const m = Sess.LocalMatch.restore(snap.json, BUILD);
    app.match = m;
    app.ctx = localizeCtx({
      mode: "resumed", contentId: m.contentId, title: "", brief: "", theme: snap.theme, seed: m.state.seed, ruleset: m.state.ruleset,
      seats: m.seats, ranked: false, allowUndo: m.allowUndo,
    });
    app.lesson = null;
    app.angledHits = 0;
    keyTarget = m.state.paddles[0]!.tx;
    pointerX = null;
    render.build(m.state.ruleset, snap.theme, { side: 0, cvd: settings.accessibility.palette, view: settings.camera.view });
    audio.startTheme(themeBed(snap.theme));
    app.objective = t("match.resumed");
    app.sub = "";
    resumeMatch();
  } catch {
    toast(t("toast.snapshotBad"), "error");
    try { platform.storage.clear("snapshot"); } catch { /* none */ }
    close("resume");
  }
}
export function discardSnapshot(): void {
  click();
  try { platform.storage.clear("snapshot"); } catch { /* none */ }
  close("resume");
}

// ------------------------------------------------------------------ settings and profile
export function setSetting(fn: () => void): void {
  fn();
  platform.saveSettings();
  applySettings();
}
export function applySettings(): void {
  audio.setMuted(!!settings.audio.muted);
  render.setTrails(!!settings.graphics.trails);
  render.setView(settings.camera.view);
}
export function saveProfileName(): void {
  click();
  settings.displayName = app.nameField.trim().slice(0, 24) || "Guest";
  platform.saveSettings();
  toast(t("toast.profileSaved"), "success");
  close("profile");
}
export function resetProgress(): void {
  platform.resetProgress();
  app.confirmReset = false;
  toast(t("toast.resetDone"));
  close("settings");
}
export function replayTutorials(): void {
  click();
  settings.tutorialDone = {};
  platform.saveSettings();
  toast(t("nat.tutorialsReset"), "success");
}
export function syncNow(): void {
  click();
  void platform.flush().then((ok) => toast(ok ? t("toast.cloudOk") : t("toast.cloudBad"), ok ? "success" : "error"));
}
export function copyInvite(): void {
  click();
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(t("toast.inviteCopied"), "success"); }
  catch { toast(t("toast.inviteFailed"), "error"); }
}
/** Settings › Report a problem (signed in): a bug report with a small non-personal context (the browser build's game-options.js report). */
export function sendReport(): void {
  const text = app.reportField.trim();
  if (!text || app.reportSending) return;
  click();
  app.reportSending = true;
  const f = frame();
  const context = { viewport: [f.width, f.height, f.scale], language: preferences().language, level: f.level, phase: app.phase, mode: app.ctx?.mode ?? null };
  reportBug({ title: `Paddle Pulse: ${text.slice(0, 80)}`, description: text.slice(0, 4000), context }).then(
    () => { app.reportField = ""; app.reportSending = false; toast(t("nat.reportSent"), "success"); },
    () => { app.reportSending = false; toast(t("nat.reportFailed"), "error"); },
  );
}
export function signIn(): void { click(); void requestSignIn().catch(() => undefined); }
export function refreshBoards(): void {
  app.boards = "loading";
  void platform.readBoard().then((lines) => { app.boards = lines; });
}

// ------------------------------------------------------------------ input
const playing = (): boolean => app.phase === "active" && !app.stack.length;
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  const s = top();
  if (s) {
    if (e.action === "pause" && fresh && !ui.capturingKeys()) back();
    return;
  }
  if (app.phase !== "active" && app.phase !== "countdown") return;
  switch (e.action) {
    case "pause": if (fresh) { audio.ui("back"); openPause(); } break;
    case "serve": ui.setFocus(null); submitServe(0); break;
    case "undo": doUndo(); break;
    case "camera": toggleCamera(); break;
    case "hint": showHint(); break;
    case "left": case "right": ui.setFocus(null); break;
    case "p2serve":
      if (app.ctx?.mode === "hosted-local" && app.match && app.phase === "active") app.match.submit({ id: Sess.nextCmdId(1), player: 1, type: Rules.CMD.SERVE });
      break;
    default: break;
  }
});

/** HUD rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
const queued: { kind: "down" | "move" | "up" | "cancel"; x: number; y: number }[] = [];
let lastTouch = -1e9;
let dragging = false;
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  queued.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y });
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) queued.push({ kind: "move", x, y }); });
onTouch((e) => {
  if (!e.primary || e.control) return;
  lastTouch = now();
  if (e.phase === "start") queued.push({ kind: "down", x: e.x, y: e.y });
  else if (e.phase === "move") queued.push({ kind: "move", x: e.x, y: e.y });
  else if (e.phase === "end") queued.push({ kind: "up", x: e.x, y: e.y });
  else queued.push({ kind: "cancel", x: e.x, y: e.y });
});
/** Arena drags and taps (main.js pointer capture), decided once the frame's UI is built. */
function pointerInput(): void {
  for (const q of queued.splice(0)) {
    if (q.kind === "down") {
      dragging = playing() && !onHud(q.x, q.y);
      if (dragging) { ui.setFocus(null); pointerX = render.screenToArenaX(q.x); }
    } else if (q.kind === "move") {
      if (dragging && playing()) pointerX = render.screenToArenaX(q.x);
    } else if (q.kind === "up") {
      if (!dragging) continue;
      dragging = false;
      // A tap serves only when serving is part of the current lesson (or in normal play): movement-only lessons keep taps for steering.
      const lessonAllowsServe = !app.lesson || app.lesson.def.steps.some((st) => st.require?.type === "serve");
      if (lessonAllowsServe && canServe()) submitServe(0);
      pointerX = null;
      if (app.match) keyTarget = app.match.state.paddles[0]!.tx;
    } else { dragging = false; pointerX = null; }
  }
}

/** Keys, pads and the pointer → commands each rules tick (main.js pollInputs). */
function pollInputs(): void {
  const m = app.match;
  if (!m || m.finished) return;
  const r = m.state.ruleset;
  const half = r.arena.w / 2 - m.state.paddles[0]!.halfW;
  const speed = r.paddleSpeed;
  if (pointerX != null) {
    submitMove(0, Math.max(-half, Math.min(half, pointerX)));
  } else {
    // The actions' values: keys give 1, a stick or trigger a fraction (its speed share).
    let dir = value("right") - value("left");
    if (Math.abs(dir) < 0.2) dir = 0;
    if (settings.accessibility.leftHanded) dir = -dir;
    if (dir !== 0) {
      if (keyOrigin === null || Math.sign(dir) !== keyDir) { keyOrigin = m.state.paddles[0]!.tx; keyDir = Math.sign(dir); }
      keyTarget = Math.max(-half, Math.min(half, keyTarget + dir * speed * DT));
      if (Math.abs(keyTarget - m.state.paddles[0]!.tx) > 0.25) submitMove(0, keyTarget);
    } else { keyTarget = m.state.paddles[0]!.tx; keyOrigin = null; }
  }
  if (app.ctx?.mode === "hosted-local") {
    const half2 = r.arena.w / 2 - m.state.paddles[1]!.halfW;
    const d2 = (isDown("p2right") ? 1 : 0) - (isDown("p2left") ? 1 : 0);
    if (d2 !== 0) {
      p2Target = Math.max(-half2, Math.min(half2, p2Target + d2 * speed * DT));
      if (Math.abs(p2Target - m.state.paddles[1]!.tx) > 0.25) m.submit({ id: Sess.nextCmdId(1), player: 1, type: Rules.CMD.MOVE, x: p2Target });
    } else p2Target = m.state.paddles[1]!.tx;
  }
}

function handleEvents(events: RulesEvent[]): void {
  render.handleEvents(events);
  for (const e of events) {
    audio.event(e);
    if (app.lesson) lessonEvent(e as unknown as Record<string, unknown>);
    if (e.t === "paddle" && e.player === 0 && Math.abs(e.offset ?? 0) >= 0.5) app.angledHits++;
    if (e.t === "paddle" && e.player === 0) haptic(15);
    if (e.t === "goal") {
      haptic(e.player === 0 ? 40 : 80);
      announce(t("announce.score", { a: e.score![0]!, b: e.score![1]!, suffix: e.player === 0 ? t("announce.yourPoint") : "" }));
    }
    if (e.t === "match-end") announce(e.winner === 0 ? t("announce.won") : t("announce.lost"), true);
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(TICK);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  audio.setOnCaption(showCaption);
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applySettings();
  goTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onSettingsChange(() => applySettings());
platform.onProgressMerged(() => toast(t("toast.cloudOk"), "success"));
platform.onPlayer((on) => { if (!on) toast(t("toast.signedOut")); });
onSessionEnded(() => toast(t("toast.signedOut")));
let hidden = false;
onSuspend(() => {
  hidden = true;
  if (app.phase === "active" || app.phase === "countdown") openPause();
  else if (app.phase === "paused") saveSnapshot();
  audio.setSuspended(true);
  void platform.flush();
});
onResume(() => { hidden = false; audio.setSuspended(false); });
onQuit(() => { if (app.phase === "paused") saveSnapshot(); });

onFixedUpdate(() => {
  if (hidden) return;
  for (let i = 0; i < timers.length; i++) {
    const tm = timers[i]!;
    tm.left -= DT;
    if (tm.left <= 1e-9) { timers.splice(i, 1); i--; tm.fn(); }
  }
  const m = app.match;
  if (app.phase === "active" && m && !m.finished && !app.stack.length) {
    pollInputs();
    const events = m.step();
    if (events.length) handleEvents(events);
    if (m.finished && app.phase === "active") endMatch();
  }
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast, settings.accessibility.palette);
  const m = app.match;
  if (m && app.phase === "active") audio.setIntensity(Math.min(1, 0.3 + (m.state.ball.speed / m.state.ruleset.maxBallSpeed) * 0.7));
  if (app.phase === "active" && (isDown("left") || isDown("right"))) ui.setFocus(null);
  audio.update(dt);
  const tm = now();
  app.toasts = app.toasts.filter((x) => x.until > tm);
  if (app.caption && app.caption.until <= tm) app.caption = null;
});
onRender((alpha) => {
  hudRects.length = 0;
  drawScreens();
  for (const fn of pendingActs.splice(0)) fn();
  pointerInput();
  const f = frame();
  render.setViewport(f.width, f.height);
  const m = app.match;
  if (m && (app.phase === "active" || app.phase === "paused" || app.phase === "countdown" || app.phase === "resolving" || app.phase === "results")) {
    const a = app.phase === "active" ? Math.min(1, Math.max(0, alpha)) : 1;
    const ip = m.interpolation(a);
    render.update(ip.prev, ip.cur, a, frameDt);
  } else render.idle(frameDt);
});
