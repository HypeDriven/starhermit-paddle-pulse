// The browser build's DOM shell (index.html's HUD, js/ui/app.js and
// js/ui/screens.js, style.css) as starhermit:ui, built every frame over the
// arena: the match HUD (the score pill with both names, the objective rail
// with its sub-line, the Serve and Pause rail, the 3-2-1-GO countdown), the
// screens on their wash (title with Play, the Daily / Journey / profile cards
// and the More row; modes; the Journey map by chapter with stars, mastery and
// locks; Challenges; Learn; the setup card with the rules summary, chips, seed
// and timing assist; the Daily; Hosted Play (shared-screen 2P); pause;
// results with stars, the breakdown table, achievements and the leaderboard
// line; settings; achievements; leaderboards; help with the effective keys;
// profile; the resume offer), the toasts and the audio captions. The old
// media queries are layouts picked by the window's logical size: wide desktop
// (rails at the sides), compact (< 1024 px: rails at the bottom), portrait
// phone (≤ 700 px: the objective above a thumb tray, screens as bottom
// sheets) and short landscape (≤ 500 px tall: slim rails). Left-handed
// controls swap the rails, as before.
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Ach, Levels, Tutorials, type Level } from "./game.ts";
import { fmtInt, fmtTime, t, tc } from "./i18n.ts";
import * as platform from "./platform.ts";
import {
  app, back, canServe, canUndo, challengeCtx, click, copyInvite, dailyNow, discardSnapshot, doUndo, hostLocal, hudRects, journeyCtx,
  later, leaderboardLine, leaveMatch, msUntilNextDaily, openPause, openScreen, openSetup, playDaily, playLesson, playerName, progress,
  quickPlay, replayTutorials, resetProgress, restartMatch, resultsNext, resultsRetry, resultsVerify, resumeFromSnapshot, resumeMatch,
  saveProfileName, setSetting, settings, signIn, startMatch, submitServe, syncNow, top, type Screen,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; phone: boolean; short: boolean; compact: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, phone: lw <= 700 && lh > 500, short: lh <= 500 && lw > lh, compact: lw < 1024 };
}
const fresh = (): boolean => frame().frame !== app.openedFrame;
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
const lastSize = new Map<string, number>();
const gap = (h: number): void => { ui.widget("", { role: "none", size: { width: 1, height: h } }); };
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }

interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; selected?: boolean; name?: string }
const PADX: Record<string, number> = { btn: 38, "btn-primary": 38, "btn-big": 58, "btn-huge": 130, "btn-small": 26, "btn-danger": 38, "btn-tray": 38, "btn-tray-primary": 38 };
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + (PADX[style] ?? 38);
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): boolean {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - (PADX[style] ?? 38));
    opts.content = () => { ui.style({ text: { align: "center", weight: "600" } }).paragraph(b.text, inner); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.style({ text: { weight: "600" } }).label(b.text); };
  const hit = ui.style(style, s).id(b.id).button(b.name ?? b.text, opts);
  if (hit && fresh() && !b.disabled) later(b.act);
  return hit;
}
/** .row-gap: buttons at their own widths in rows that wrap at `width`. */
function flow(label: string, list: Btn[], width: number, gapPx = 10, justify: "start" | "center" | "end" = "start", role?: "radiogroup"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gapPx + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gapPx : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  const build = (): void => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, bw(b) >= width ? width : null);
    }, { spacing: gapPx, width, justify }));
  };
  ui.column(label, build, { spacing: gapPx, width, ...(role ? { role } : {}) });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string, align: "start" | "center" | "end" = "start"): void {
  if (!text) return;
  let u = ui.style(cls, { text: { align } });
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, id?: string): void {
  if (textWidth(text, cls, "heading") <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
/** A label – value row (.rules-summary dt/dd). */
function dlRow(key: string, dt: string, dd: string, width: number): void {
  const ddw = Math.min(width * 0.6, textWidth(dd, "rules-dd") + 2);
  const dtw = width - ddw - 16;
  ui.row(key, () => {
    para(dt, dtw, "rules-dt");
    ui.spacer();
    para(dd, ddw, "rules-dd", undefined, "end");
  }, { width, style: "rules-row", spacing: 16, align: "start" });
}
/** A check box whose label wraps (a toggle button with a drawn box). */
function check(id: string, label: string, checked: boolean, width: number, onChange: (v: boolean) => void, disabled = false): void {
  const inner = width - 44;
  const opts: ui.ButtonOptions = {
    selected: checked,
    content: () => ui.row(`${id}-face`, () => {
      ui.widget("", {
        role: "none", size: { width: 22, height: 22 },
        draw: (r, s) => {
          const k = s.scale;
          draw.box(r.x, r.y, r.width, r.height, { background: checked ? "$cyan" : "#4a4a4a", border: { width: 1, color: "$line" }, radius: 3 });
          if (checked) {
            draw.line(r.x + 5 * k, r.y + 11 * k, r.x + 9 * k, r.y + 16 * k, "#03050c", 2.5 * k);
            draw.line(r.x + 9 * k, r.y + 16 * k, r.x + 17 * k, r.y + 6 * k, "#03050c", 2.5 * k);
          }
        },
      });
      para(label, inner, "check-label");
    }, { spacing: 10, align: "center" }),
  };
  if (disabled) opts.disabled = true;
  if (ui.style({ width, padding: 4, background: "#00000000", border: { width: 0 }, text: { align: "start" } }).id(id).button(label, opts) && fresh() && !disabled) {
    later(() => onChange(!checked));
  }
}
function chips(key: string, list: [string, boolean][]): void {
  ui.row(key, () => {
    for (const [text, ranked] of list) ui.row(`${key}-${text}`, () => ui.style(ranked ? "chip-ranked-text" : "chip-text").label(text.toUpperCase()), { style: ranked ? "chip-ranked" : "chip" });
  }, { spacing: 6 });
}
/** A card button (.card): a bold title and a dim sub-line, maybe a chip line. */
function card(id: string, title: string, sub: string, width: number, act: () => void, done = false, extra?: () => void, name?: string): void {
  const inner = width - 34;
  const face = (): void => {
    ui.column(`${id}-face`, () => {
      para(title, inner, "card-title");
      if (sub) para(sub, inner, "card-sub");
      if (extra) extra();
    }, { spacing: 6, width: inner });
  };
  if (ui.style(done ? "card-done" : "card", { width }).id(id).button(name ?? title, { content: face }) && fresh()) later(act);
}
/** .card-grid: cards at least `min` wide filling `width`. */
function cardGrid<T>(key: string, items: T[], width: number, min: number, each: (item: T, w: number, i: number) => void, gapPx = 12): void {
  const cols = Math.max(1, Math.floor((width + gapPx) / (min + gapPx)));
  const cw = (width - (cols - 1) * gapPx) / cols;
  ui.column(key, () => {
    for (let r = 0; r * cols < items.length; r++) {
      ui.row(`${key}-r${r}`, () => {
        for (let i = r * cols; i < Math.min(items.length, (r + 1) * cols); i++) each(items[i]!, cw, i);
      }, { spacing: gapPx, align: "stretch" });
    }
  }, { spacing: gapPx, width });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  const hudShown = !!app.match && ["countdown", "active", "paused", "resolving"].includes(app.phase);
  if (hudShown) hud(L);
  captions(L);
  const s = top();
  if (s) {
    backdrop(app.stack.length > 1 ? "screen-wash-dark" : "screen-wash", L);
    screen(s, L);
  }
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** The screen's wash over the arena: a placed role-"none" widget covering what was built before it. */
function backdrop(cls: string, L: Layout): void {
  const f = frame();
  ui.place("backdrop", { anchor: "top-start", x: -f.safeArea.left / L.sc, y: -f.safeArea.top / L.sc }, () => {
    ui.widget("", { role: "none", size: { width: f.width / L.sc, height: f.height / L.sc }, draw: () => draw.box(0, 0, f.width, f.height, cls) });
  });
}
const WIDE: Partial<Record<Screen, boolean>> = { journey: true, settings: true, help: true };
/** A screen (.screen > .panel): centred, at most 680 (wide 920) px, scrolling when taller than the room; a bottom sheet on phones. */
function page(key: string, L: Layout, build: (w: number) => void, maxWidth: number, bare = false): void {
  const pad = bare ? 0 : L.phone ? 16 : L.short ? 14 : L.compact ? 22 : 30;
  const margin = L.phone || L.short ? 8 : 20;
  const outer = Math.min(maxWidth, L.lw - 2 * margin);
  const avail = Math.max(80, L.lh - 2 * margin);
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail + 1;
  const inner = outer - 2 * pad - (scroll ? 14 : 0);
  const opening = frame().frame - app.openedFrame <= 5;
  const anchor = L.phone && !bare ? "bottom" : "center";
  ui.place(`page-${key}`, { anchor, y: L.phone && !bare ? 0 : 0 }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(inner), {
        width: outer - (scroll ? 14 : 0), spacing: L.short ? 8 : 12, padding: pad, ...(bare ? { align: "center" as const } : {}),
        ...(bare || scroll ? {} : { style: L.phone ? "panel-sheet" : "panel" }),
      });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) {
      ui.column(`${key}-frame`, () => {
        ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      }, bare ? {} : { style: L.phone ? "panel-sheet" : "panel", padding: 0 });
    } else body();
  });
}
function screen(s: Screen, L: Layout): void {
  const w = WIDE[s] ? 920 : 680;
  switch (s) {
    case "title": page("title", L, (iw) => titleScreen(iw, L), 760, true); break;
    case "modes": page("modes", L, modesScreen, w); break;
    case "journey": page("journey", L, journeyScreen, w); break;
    case "challenges": page("challenges", L, challengesScreen, w); break;
    case "learn": page("learn", L, learnScreen, w); break;
    case "setup": page("setup", L, setupScreen, w); break;
    case "daily": page("daily", L, dailyScreen, w); break;
    case "lobby": page("lobby", L, lobbyScreen, w); break;
    case "pause": page("pause", L, pauseScreen, w); break;
    case "results": page("results", L, resultsScreen, w); break;
    case "settings": page("settings", L, (iw) => settingsScreen(iw, L), w); break;
    case "achievements": page("achievements", L, achievementsScreen, w); break;
    case "boards": page("boards", L, boardsScreen, w); break;
    case "help": page("help", L, helpScreen, w); break;
    case "profile": page("profile", L, profileScreen, w); break;
    case "resume": page("resume", L, resumeScreen, w); break;
  }
}
function backButton(w: number, text = t("common.back"), id = "btn-back"): void {
  flow("back-row", [{ id, text, act: back }], w, 10, "end");
}

// ------------------------------------------------------------------ the HUD
function hud(L: Layout): void {
  const m = app.match!;
  const f = frame();
  const left = settings.accessibility.leftHanded;
  const small = L.phone || L.short;
  // the score pill (.hud-status)
  const pill = ui.place("hud-status", { anchor: "top", y: L.short ? 4 : 8 }, () => {
    ui.row("hud-status-row", () => {
      const names = m.seats.map((s, i) => s.name || t(i === 0 ? "hud.you" : "hud.opponent"));
      const nameW = small ? 80 : 120;
      ui.style("hud-name").id("hud-name-0").label(clip(names[0]!, "hud-name", nameW));
      ui.style(small ? "hud-score-small" : "hud-score").id("hud-score").label(`${m.state.score[0]} – ${m.state.score[1]}`);
      ui.style("hud-name").id("hud-name-1").label(clip(names[1]!, "hud-name", nameW));
    }, { style: "hud-status", spacing: small ? 10 : 14, align: "center", padding: L.short ? { top: 3, bottom: 3, start: 14, end: 14 } : undefined });
  });
  rect(pill);

  // the objective rail
  const railText = (w: number): void => {
    para(app.objective, w, "hud-objective", "hud-objective");
    para(app.sub, w, "hud-sub", "hud-sub");
  };
  const btns = (style: "btn" | "btn-tray"): Btn[] => [
    { id: "hud-serve", text: t("hud.serve"), style: style === "btn" ? "btn-primary" : "btn-tray-primary", act: () => submitServe(0), disabled: !canServe() },
    { id: "hud-pause", text: t("hud.pause"), style, act: () => { click(); openPause(); } },
  ];
  if (L.phone) {
    // portrait: the objective above a thumb tray across the bottom
    const trayH = 52 + 20;
    const ow = L.lw - 16;
    const rr = ui.place("hud-rail-left", { anchor: "bottom", y: trayH + 10 }, () => {
      ui.column("hud-rail-left-col", () => railText(ow - 26), { style: "hud-rail", width: ow, spacing: 4, padding: { top: 8, bottom: 8, start: 12, end: 12 } });
    });
    rect(rr);
    const tray = ui.place("hud-tray", { anchor: "bottom" }, () => {
      ui.row("hud-tray-row", () => {
        const list = btns("btn-tray");
        if (left) list.reverse();
        const bw = Math.min(220, (L.lw - 24 - 14) / 2);
        for (const b of list) button(b, bw);
      }, { style: "tray", width: f.width / L.sc, spacing: 14, justify: "center", padding: { top: 10, bottom: 10, start: 12, end: 12 } });
    });
    rect(tray);
  } else if (L.compact && !L.short) {
    const ow = Math.min(300, L.lw * 0.6);
    const rr = ui.place("hud-rail-left", { anchor: left ? "bottom-end" : "bottom-start", x: 12, y: 76 }, () => {
      ui.column("hud-rail-left-col", () => railText(ow - 28), { style: "hud-rail", width: ow, spacing: 6 });
    });
    rect(rr);
    const rb = ui.place("hud-rail-right", { anchor: left ? "bottom-start" : "bottom-end", x: 12, y: 76 }, () => {
      ui.row("hud-rail-right-row", () => { for (const b of btns("btn")) button(b); }, { spacing: 12 });
    });
    rect(rb);
  } else {
    // wide desktop and short landscape: rails at the sides, centred
    const ow = L.short ? 180 : Math.min(240, L.lw * 0.22);
    const bw = L.short ? 120 : Math.min(180, L.lw * 0.2);
    const rr = ui.place("hud-rail-left", { anchor: left ? "end" : "start", x: L.short ? 8 : 16 }, () => {
      ui.column("hud-rail-left-col", () => railText(ow - 28), { style: "hud-rail", width: ow, spacing: 6, padding: L.short ? { top: 8, bottom: 8, start: 10, end: 10 } : undefined });
    });
    rect(rr);
    const rb = ui.place("hud-rail-right", { anchor: left ? "start" : "end", x: L.short ? 8 : 16 }, () => {
      ui.column("hud-rail-right-col", () => { for (const b of btns("btn")) button(b, bw); }, { spacing: L.short ? 8 : 12, width: bw });
    });
    rect(rb);
  }
  // the countdown
  if (app.countdown) {
    ui.place("hud-countdown", { anchor: "top", y: L.lh * 0.38 - 70 }, () => {
      ui.style("hud-countdown", { text: { size: Math.max(48, Math.min(112, L.lw * 0.12)) } }).id("hud-countdown").label(app.countdown);
    });
  }
}
function clip(text: string, cls: string, w: number): string {
  if (textWidth(text, cls) <= w) return text;
  let s = text;
  while (s.length > 1 && textWidth(s + "…", cls) > w) s = s.slice(0, -1);
  return s + "…";
}

function captions(L: Layout): void {
  const c = app.caption;
  if (!c) return;
  const at = L.phone ? { anchor: "top" as const, y: 56 } : { anchor: "bottom" as const, y: 84 };
  ui.place("captions", at, () => {
    ui.row("caption-row", () => ui.style("caption-text").id("caption").label(c.text), { style: "caption" });
  });
}
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const w = Math.min(480, L.lw * 0.9);
  ui.place("toasts", { anchor: "bottom", y: L.phone && app.match && !top() ? 170 : 18 }, () => {
    ui.column("toast-col", () => {
      app.toasts.forEach((x, i) => {
        const cls = x.kind === "error" ? "toast-error" : x.kind === "success" ? "toast-success" : x.kind === "info" ? "toast-info" : "toast";
        ui.row(`toast-${i}`, () => para(x.text, w - 40, x.kind === "error" ? "toast-error-text" : "toast-text", `toast-text-${i}`, "center"), { style: cls });
      });
    }, { spacing: 8, align: "center" });
  });
}

// ------------------------------------------------------------------ title and modes
function titleScreen(w: number, L: Layout): void {
  const cleared = Object.values(progress.journey).filter((j) => j.stars > 0).length;
  const totalStars = Object.values(progress.journey).reduce((a, j) => a + (j.stars || 0), 0);
  const daily = dailyNow();
  const dailyDone = progress.dailies[daily.date];
  const big = L.lw >= 640 && !L.short;
  const cls = big ? "logo" : "logo-small";
  ui.row("logo-row", () => {
    const ph = big ? 11.8 : 6.1, pw = big ? 40.5 : 21;
    ui.widget("", { role: "none", size: { width: pw, height: ph }, draw: (r) => draw.box(r.x, r.y, r.width, r.height, "logo-paddle") });
    ui.style(cls).id("logo").heading("Paddle Pulse");
  }, { spacing: big ? 13 : 7, align: "center" });
  para(t("title.tagline"), w, "tagline", "tagline", "center");
  gap(L.short ? 2 : 14);
  button({ id: "btn-play", text: t("title.play"), style: L.short ? "btn-big" : "btn-huge", act: quickPlay });
  gap(L.short ? 2 : 10);
  const cards = [
    { id: "card-daily", title: t("title.daily"), sub: t("title.dailySub", { name: tc(daily.name), state: dailyDone ? t("title.dailyDone") : t("title.dailyNew") }), act: () => openScreen("daily", "btn-play-daily"), done: !!dailyDone },
    { id: "card-journey", title: t("title.journey"), sub: t("title.journeySub", { cleared, stars: totalStars }), act: () => openScreen("journey", "stage-1"), done: false },
    { id: "card-profile", title: playerName(), sub: t("title.profileSub", { wins: progress.totals.wins, streak: progress.streak.current }), act: () => openScreen("profile", null), done: false },
  ];
  const cw = Math.min(w, 690);
  cardGrid("title-cards", cards, cw, L.short ? 150 : 160, (c, ww) => card(c.id, c.title, c.sub, ww, c.act, c.done), 12);
  gap(L.short ? 2 : 10);
  const nav: Btn[] = [
    { id: "nav-modes", text: t("nav.modes"), act: () => openScreen("modes", "mode-learn") },
    { id: "nav-achievements", text: t("nav.achievements"), act: () => openScreen("achievements", null) },
    { id: "nav-boards", text: t("nav.boards"), act: () => openScreen("boards", null) },
    { id: "nav-settings", text: t("nav.settings"), act: () => openScreen("settings", null) },
    { id: "nav-help", text: t("nav.help"), act: () => openScreen("help", null) },
  ];
  if (!platform.signedIn()) nav.push({ id: "nav-signin", text: t("profile.signIn"), act: signIn });
  if (platform.inviteLink()) nav.push({ id: "nav-invite", text: t("account.invite"), act: copyInvite });
  flow("title-nav", nav, cw, 10, "center");
}

const modes = (): [string, string, string, string, () => void][] => [
  ["learn", "modes.learn", "chip.unranked", "dur.lesson", () => openScreen("learn", null)],
  ["journey", "title.journey", "chip.unranked", "dur.stage", () => openScreen("journey", "stage-1")],
  ["daily", "title.daily", "chip.ranked", "dur.match", () => openScreen("daily", "btn-play-daily")],
  ["practice", "modes.practice", "chip.unranked", "dur.match", quickPlay],
  ["challenge", "modes.challenge", "chip.unranked", "dur.match", () => openScreen("challenges", null)],
  ["hosted", "lobby.title", "chip.unranked", "dur.hosted", () => openScreen("lobby", "btn-host-local")],
];
function modesScreen(w: number): void {
  heading("h2", t("modes.title"), w, "modes-h");
  cardGrid("modes-grid", modes(), w, 220, ([id, title, chip, dur, act], cw) => {
    card(`mode-${id}`, t(title), t(`modes.${id}Sub`), cw, act, false, () => chips(`mode-${id}-chips`, [[t(chip), chip !== "chip.unranked"], [t(dur), false]]));
  });
  backButton(w);
}

function starRow(key: string, n: number, big = false): void {
  ui.row(key, () => { for (const i of [1, 2, 3]) ui.style(i <= n ? (big ? "star-on-big" : "star-on") : big ? "star-off-big" : "star-off").label("★"); }, { spacing: big ? 4 : 1 });
}
function journeyScreen(w: number): void {
  const cleared = Object.values(progress.journey).filter((j) => j.stars > 0).length;
  heading("h2", `${t("title.journey")} ${t("journey.cleared", { n: cleared })}`, w, "journey-h");
  para(t("journey.blurb"), w, "dim");
  const chapters: { name: string; levels: Level[] }[] = [];
  for (const l of Levels.JOURNEY_LEVELS) {
    if (!chapters.length || chapters[chapters.length - 1]!.name !== l.chapter) chapters.push({ name: l.chapter, levels: [] });
    chapters[chapters.length - 1]!.levels.push(l);
  }
  for (const ch of chapters) {
    ui.style("chapter").label(tc(ch.name));
    cardGrid(`ch-${ch.name}`, ch.levels, w, 64, (l, cw) => {
      const rec = progress.journey[l.id];
      const done = (rec?.stars || 0) > 0;
      const prev = l.index === 1 || (progress.journey["j" + String(l.index - 1).padStart(2, "0")]?.stars || 0) > 0;
      const locked = !done && !prev;
      const name = t("journey.ariaStage", { n: l.index, title: tc(l.title) }) + (l.mastery ? t("journey.ariaMastery") : "") + (locked ? t("journey.ariaLocked") : "");
      const opts: ui.ButtonOptions = {
        content: () => ui.column(`lvf-${l.id}`, () => { ui.style("level-num").label(String(l.index)); starRow(`st-${l.id}`, rec?.stars || 0); }, { align: "center", width: cw - 12, spacing: 4 }),
        ariaDisabled: locked,
      };
      const cls = l.mastery ? "level-mastery" : "level-node";
      if (ui.style(cls, { width: cw, ...(locked ? { opacity: 0.38 } : {}) }).id(`stage-${l.index}`).button(name, opts) && fresh() && !locked) {
        later(() => { click(); openSetup(journeyCtx(l)); });
      }
    }, 10);
  }
  backButton(w);
}
function challengesScreen(w: number): void {
  heading("h2", t("challenges.title"), w, "challenges-h");
  para(t("challenges.blurb"), w, "dim");
  cardGrid("ch-grid", Levels.CHALLENGES, w, 220, (c, cw, i) => {
    const done = !!progress.challenges[c.id]?.cleared;
    card(`challenge-${i}`, tc(c.title) + (done ? " ✓" : ""), tc(c.brief), cw, () => { click(); openSetup(challengeCtx(c)); }, done,
      () => chips(`ch-${c.id}-chips`, [[t("constraint." + c.goals.constraint), false]]));
  });
  backButton(w);
}
function learnScreen(w: number): void {
  heading("h2", t("learn.title"), w, "learn-h");
  para(t("learn.blurb"), w, "dim");
  cardGrid("learn-grid", Tutorials.LESSONS, w, 220, (l, cw, i) => {
    const done = !!settings.tutorialDone[l.id];
    card(`lesson-${i}`, `${i + 1}. ${tc(l.objective)}${done ? " ✓" : ""}`, t(l.steps.length > 1 ? "learn.stepMany" : "learn.stepOne", { n: l.steps.length }), cw,
      () => playLesson(l), done);
  });
  backButton(w);
}

// ------------------------------------------------------------------ setup, daily, lobby
function setupScreen(w: number): void {
  const ctx = app.ctx;
  if (!ctx) { backButton(w); return; }
  const r = ctx.ruleset;
  heading("h2", ctx.title, w, "setup-h");
  if (ctx.brief) para(ctx.brief, w, "dim", "setup-brief");
  const rows: [string, string][] = [
    [t("setup.ruleTarget"), t("setup.valTarget", { score: r.targetScore ?? 5, margin: r.winMargin ?? 2 })],
    [t("setup.ruleBallSpeed"), t("setup.valBallSpeed", { speed: r.ballSpeed ?? 14 })],
  ];
  if (ctx.seats[1]!.kind === "ai") rows.push([t("setup.ruleOpponent"), Levels.AI_LEVELS[ctx.seats[1]!.level ?? 2]!.name]);
  if (ctx.allowUndo) rows.push([t("setup.ruleRecovery"), t("setup.valRecovery")]);
  ui.column("setup-rules", () => rows.forEach(([k, v], i) => dlRow(`rule-${i}`, k, v, w)), { spacing: 6, width: w });
  chips("setup-chips", [
    [ctx.ranked ? t("chip.ranked") : t("chip.unranked"), ctx.ranked],
    [ctx.seats[1]!.kind === "ai" ? t("setup.playersSolo") : t("setup.playersDuet"), false],
    [t("setup.minutes", { m: 2 }), false],
  ]);
  ui.row("seed-row", () => {
    ui.style("seed").label(t("setup.seed"));
    ui.row("seed-code", () => ui.style("code-text").id("setup-seed").label(String(ctx.seed)), { style: "code" });
  }, { spacing: 6, align: "center" });
  check("chk-timing-assist", t("setup.timingAssist"), settings.accessibility.timingAssist, w, (v) => setSetting(() => { settings.accessibility.timingAssist = v; }));
  flow("setup-actions", [
    { id: "btn-start-match", text: ctx.startLabel || t("common.start"), style: "btn-big", act: () => { click(); startMatch(); } },
    { id: "btn-back", text: t("common.back"), act: back },
  ], w, 10);
}
function dailyScreen(w: number): void {
  const daily = dailyNow();
  const done = progress.dailies[daily.date];
  heading("h2", t("daily.heading", { name: tc(daily.name) }), w, "daily-h");
  para(t("daily.blurb"), w, "dim");
  ui.column("daily-rules", () => {
    dlRow("d-date", t("daily.date"), daily.date, w);
    dlRow("d-seed", t("daily.seed"), String(daily.seed), w);
    dlRow("d-target", t("setup.ruleTarget"), t("setup.valTarget", { score: daily.ruleset.targetScore ?? 5, margin: daily.ruleset.winMargin ?? 2 }), w);
    dlRow("d-next", t("daily.nextIn"), fmtTime(msUntilNextDaily() / 1000), w);
  }, { spacing: 6, width: w });
  if (done) chips("daily-chip", [[t("daily.completed", { a: done.score[0]!, b: done.score[1]!, won: done.won ? t("daily.won") : "" }), false]]);
  else chips("daily-chip", [[t("daily.rankedChip"), true]]);
  flow("daily-actions", [
    { id: "btn-play-daily", text: done ? t("daily.playAgain") : t("daily.play"), style: "btn-big", act: playDaily },
    { id: "btn-back", text: t("common.back"), act: back },
  ], w, 10);
}
function lobbyScreen(w: number): void {
  heading("h2", t("lobby.title"), w, "lobby-h");
  para(t("lobby.idleBlurb"), w, "dim");
  flow("lobby-actions", [{ id: "btn-host-local", text: t("lobby.local"), style: "btn-primary", act: hostLocal }], w);
  para(t("lobby.onlineNote"), w, "dim");
  para(platform.signedIn() ? t("lobby.statusOnline") : t("nat.lobbyOffline"), w, "dim", "lobby-net-status");
  backButton(w);
}

// ------------------------------------------------------------------ pause and results
function pauseScreen(w: number): void {
  heading("h2", t("pause.title"), w, "pause-h");
  para(app.ctx?.brief || app.ctx?.title || t("pause.title"), w, "dim");
  const bw = w;
  ui.column("pause-actions", () => {
    button({ id: "btn-resume", text: t("pause.resume"), style: "btn-big", act: () => { click(); resumeMatch(); } }, bw);
    if (canUndo()) button({ id: "btn-undo", text: t("pause.undo"), act: () => { click(); doUndo(); } }, bw);
    button({ id: "btn-restart", text: t("pause.restart"), act: restartMatch }, bw);
    button({ id: "btn-pause-settings", text: t("nav.settings"), act: () => openScreen("settings", null) }, bw);
    button({ id: "btn-pause-help", text: t("nav.help"), act: () => openScreen("help", null) }, bw);
    button({ id: "btn-leave", text: t("pause.leave"), style: "btn-danger", act: () => { click(); leaveMatch(); } }, bw);
  }, { spacing: 10, width: bw });
}
function resultsScreen(w: number): void {
  const r = app.results;
  if (!r) return;
  heading(r.won ? "result-won" : "result-lost", r.headline, w, "results-h");
  if (r.sub) para(r.sub, w, "dim", "results-sub");
  if (r.starsEarned != null) starRow("results-stars", r.starsEarned, true);
  ui.style("h3").label(t("results.breakdown"));
  ui.column("breakdown", () => {
    r.breakdown.forEach(([k, v], i) => {
      ui.row(`bd-${i}`, () => {
        para(k, w * 0.5, "table-th");
        ui.spacer();
        para(v, w * 0.45, "table-cell", `bd-v-${i}`, "end");
      }, { width: w, style: "table-row" });
    });
  }, { spacing: 0, width: w });
  if (r.unlocked.length) {
    ui.style("h3").label(t("results.achievements"));
    for (const a of r.unlocked) para(`${a.icon} ${tc(a.name)} — ${tc(a.desc)}`, w, "body");
  }
  const lb = leaderboardLine();
  if (lb) para(lb, w, "dim", "results-lb");
  const list: Btn[] = [
    { id: "btn-results-next", text: r.nextLabel || t("common.cont"), style: "btn-primary", act: resultsNext },
    { id: "btn-results-retry", text: t("results.retry"), act: resultsRetry },
  ];
  if (r.canVerify) list.push({ id: "btn-results-verify", text: t("results.verify"), act: resultsVerify });
  list.push({ id: "btn-results-modes", text: t("results.modes"), act: () => { click(); leaveMatch(); } });
  flow("results-actions", list, w, 10);
}

// ------------------------------------------------------------------ settings
const PALETTES = ["none", "deuteranopia", "protanopia", "tritanopia", "high-contrast"];
const ACTIONS = ["left", "right", "serve", "pause", "undo", "camera", "hint"];
function section(key: string, title: string, w: number, build: (w: number) => void): void {
  ui.column(key, () => { ui.style("h3").label(title); build(w); }, { spacing: 8, width: w });
}
function settingsScreen(w: number, L: Layout): void {
  heading("h2", t("settings.title"), w, "settings-h");
  const two = w >= 600;
  const cw = two ? (w - 28) / 2 : w;
  const a = settings.accessibility;
  const audio = (sw: number): void => section("set-audio", t("settings.audio"), sw, (iw) => {
    check("chk-mute", t("settings.muteAll"), settings.audio.muted, iw, (v) => setSetting(() => { settings.audio.muted = v; }));
    check("chk-captions", t("settings.captions"), a.captions, iw, (v) => setSetting(() => { a.captions = v; }));
  });
  const display = (sw: number): void => section("set-graphics", t("settings.graphics"), sw, (iw) => {
    check("chk-trails", t("settings.trails"), settings.graphics.trails, iw, (v) => setSetting(() => { settings.graphics.trails = v; }));
    para(t("settings.camera"), iw, "dim-small");
    flow("cam-group", [
      { id: "cam-broadcast", text: t("settings.camBroadcast"), selected: settings.camera.view === "broadcast", act: () => setSetting(() => { settings.camera.view = "broadcast"; }) },
      { id: "cam-behind", text: t("settings.camBehind"), selected: settings.camera.view === "behind", act: () => setSetting(() => { settings.camera.view = "behind"; }) },
    ], iw, 8, "start", "radiogroup");
    para(t("nat.optionsNote"), iw, "dim-small");
    flow("options-row", [{ id: "btn-options", text: t("nat.options"), act: () => { click(); openMenu(); } }], iw);
  });
  const access = (sw: number): void => section("set-a11y", t("settings.a11y"), sw, (iw) => {
    para(t("settings.palette"), iw, "dim-small");
    flow("palette-group", PALETTES.map((p) => ({
      id: `palette-${p}`, text: t("palette." + p), style: "btn-small", selected: a.palette === p, act: () => setSetting(() => { a.palette = p; }),
    })), iw, 8, "start", "radiogroup");
    check("chk-left", t("settings.leftHanded"), a.leftHanded, iw, (v) => setSetting(() => { a.leftHanded = v; }));
    check("chk-assist", t("settings.timingAssist"), a.timingAssist, iw, (v) => setSetting(() => { a.timingAssist = v; }));
    check("chk-haptics", t("settings.haptics"), a.haptics, iw, (v) => setSetting(() => { a.haptics = v; }));
    para(t("settings.tutorialReplay"), iw, "dim-small");
    flow("tutorials-row", [{ id: "btn-replay-tutorials", text: t("nat.replayTutorials"), style: "btn-small", act: replayTutorials }], iw);
  });
  const controls = (sw: number): void => section("set-controls", t("settings.controls"), sw, (iw) => {
    for (const act of ACTIONS) {
      const label = t("action." + act);
      const key = bindingLabel(act) || "—";
      ui.row(`bind-${act}`, () => {
        para(label, iw - 130, "body");
        ui.spacer();
        button({ id: `rebind-${act}`, text: key, name: `${label}: ${key}`, style: "btn-small", act: () => { click(); requestRebind(act); } });
      }, { width: iw, align: "center" });
    }
    para(t("settings.gamepadNote"), iw, "dim-small");
  });
  const data = (sw: number): void => section("set-data", t("settings.data"), sw, (iw) => {
    const st = platform.syncState();
    const key = st === "local" ? "sync.stateOffline" : st === "synced" ? "sync.stateSynced" : st === "offline" ? "sync.stateError" : "sync.stateSaving";
    para(t("settings.syncStatus", { state: t(key) }), iw, "dim-small", "cloud-sync-status");
    const list: Btn[] = [];
    if (platform.signedIn()) list.push({ id: "btn-sync", text: t("settings.syncCloud"), style: "btn-small", act: syncNow });
    if (!app.confirmReset) list.push({ id: "btn-reset", text: t("settings.reset"), style: "btn-danger", act: () => { click(); app.confirmReset = true; } });
    if (list.length) flow("data-row", list, iw);
    if (app.confirmReset) {
      para(t("confirm.reset"), iw, "error-text");
      flow("reset-confirm", [
        { id: "btn-reset-yes", text: t("settings.reset"), style: "btn-danger", act: resetProgress },
        { id: "btn-reset-no", text: t("nat.cancel"), act: () => { click(); app.confirmReset = false; } },
      ], iw);
    }
  });
  if (two) {
    ui.row("settings-cols-1", () => { audio(cw); display(cw); }, { spacing: 28, align: "start" });
    ui.row("settings-cols-2", () => { access(cw); controls(cw); }, { spacing: 28, align: "start" });
    data(w);
  } else { audio(w); display(w); access(w); controls(w); data(w); }
  void L;
  backButton(w, t("settings.done"), "btn-settings-done");
}

// ------------------------------------------------------------------ achievements, boards, help, profile, resume
function achievementsScreen(w: number): void {
  heading("h2", t("achievements.title"), w, "achievements-h");
  cardGrid("ach-grid", Ach.ACHIEVEMENTS, w, 220, (a, cw) => {
    const rec = progress.achievements[a.key];
    const cur = rec?.progress || 0;
    const done = !!rec?.at;
    const inner = cw - 34;
    ui.column(`ach-${a.key}`, () => {
      para(`${a.icon} ${tc(a.name)}`, inner, "card-title");
      para(tc(a.desc), inner, "card-sub");
      if (a.progress) {
        const k = Math.min(1, cur / a.progress);
        ui.widget(`${tc(a.name)} ${Math.round(k * 100)}%`, {
          role: "meter", value: k, min: 0, max: 1, size: { width: inner, height: 6 },
          draw: (r) => { draw.box(r.x, r.y, r.width, r.height, "progress-track"); if (k > 0) draw.box(r.x, r.y, Math.max(r.height, r.width * k), r.height, "progress-fill"); },
        });
        para(done ? t("achievements.unlocked") : t("achievements.progressFmt", { cur: fmtInt(cur), total: fmtInt(a.progress) }), inner, "dim-small");
      } else para(done ? t("achievements.unlocked") : t("achievements.locked"), inner, "dim-small");
    }, { style: done ? "card-static-done" : "card-static", width: cw, spacing: 6 });
  });
  backButton(w);
}
function table(key: string, rows: string[][], heads: string[], w: number): void {
  if (!rows.length) { para(t("boards.empty"), w, "dim"); return; }
  const cols = heads.length;
  const cw = (w - 20) / cols;
  ui.column(key, () => {
    ui.row(`${key}-head`, () => { heads.forEach((h, i) => ui.style("table-head", { width: cw }).id(`${key}-h${i}`).label(h)); }, { style: "table-row", width: w });
    rows.forEach((r, ri) => ui.row(`${key}-r${ri}`, () => {
      r.forEach((c, i) => ui.style("table-cell", { width: cw }).id(`${key}-${ri}-${i}`).label(clip(c, "table-cell", cw - 4)));
    }, { style: "table-row", width: w }));
  }, { spacing: 0, width: w });
}
function boardsScreen(w: number): void {
  const daily = dailyNow();
  heading("h2", t("boards.title"), w, "boards-h");
  ui.style("h3").label(t("boards.dailyFmt", { date: daily.date }));
  const dl = progress.leaderboards.daily[daily.date] || [];
  table("board-daily", dl.slice(0, 20).map((e) => [e.name, String(e.score) + (e.assists ? " A" : ""), fmtTime(e.duration)]),
    [t("boards.colPlayer"), t("boards.colGoals"), t("boards.colTime")], w);
  ui.style("h3").label(t("boards.local"));
  table("board-local", progress.leaderboards.local.slice(0, 20).map((e) => [e.name, String(e.score), fmtTime(e.duration)]),
    [t("boards.colPlayer"), t("boards.colWins"), t("boards.colBestTime")], w);
  ui.style("h3").label(t("nat.boardStarHermit"));
  const b = app.boards;
  if (b === "loading") para(t("nat.loading"), w, "dim");
  else if (!b) para(t("nat.boardUnavailable"), w, "dim");
  else table("board-sh", b.map((e) => [`#${e.rank}`, e.name + (e.me ? " ★" : ""), t("results.longest", { n: e.score })]), ["#", t("boards.colPlayer"), t("results.longestRow")], w);
  ui.style("h3").label(t("boards.friends"));
  para(t("boards.friendsBlurb"), w, "dim");
  backButton(w);
}
function key(act: string): string { return bindingLabel(act) || "—"; }
function helpScreen(w: number): void {
  heading("h2", t("help.title"), w, "help-h");
  const cards: [string, string][] = [
    [t("help.goal"), t("help.goalBody")],
    [t("help.move"), t("help.moveBody", { left: key("left"), right: key("right") })],
    [t("help.serve"), t("help.serveBody", { serve: key("serve") })],
    [t("help.angles"), t("help.anglesBody")],
    [t("help.obstacles"), t("help.obstaclesBody")],
    [t("help.fair"), t("help.fairBody")],
  ];
  cardGrid("help-grid", cards, w, 220, ([title, body], cw, i) => {
    ui.column(`help-${i}`, () => { para(title, cw - 34, "card-title"); para(body, cw - 34, "card-sub"); }, { style: "card-static", width: cw, spacing: 6 });
  });
  ui.style("h3").label(t("help.keys"));
  ui.column("help-keys", () => {
    for (const [k, act] of [["help.keyPause", "pause"], ["help.keyUndo", "undo"], ["help.keyCamera", "camera"], ["help.keyHint", "hint"]] as const) {
      ui.row(`hk-${act}`, () => {
        para(t(k), w - 140, "body");
        ui.spacer();
        ui.row(`hk-${act}-kbd`, () => ui.style("code-text").label(key(act)), { style: "code" });
      }, { width: w, align: "center" });
    }
  }, { spacing: 6, width: w });
  backButton(w);
}
function profileScreen(w: number): void {
  heading("h2", t("profile.title"), w, "profile-h");
  if (platform.signedIn()) {
    ui.row("prof-account", () => {
      const av = platform.avatarBitmap();
      if (av) ui.widget("", { role: "none", size: { width: 24, height: 24 }, draw: (r) => draw.image(av, r.x, r.y, r.width, r.height) });
      para(t("profile.account", { name: platform.displayName() }), w - 34, "dim");
    }, { spacing: 8, align: "center" });
  }
  para(t("profile.displayName"), w, "dim-small");
  ui.row("prof-name", () => {
    const fw = Math.max(120, Math.min(320, w - 120));
    app.nameField = ui.style("field").id("profile-name").textField("profile-name", app.nameField, { maxChars: 24, width: fw, placeholder: t("common.guest") });
    button({ id: "btn-profile-save", text: t("profile.save"), style: "btn-primary", act: saveProfileName });
  }, { spacing: 10, align: "center" });
  if (ui.submitted("profile-name") && fresh()) later(saveProfileName);
  const acc: Btn[] = [];
  if (!platform.signedIn()) acc.push({ id: "prof-signin", text: t("profile.signIn"), act: signIn });
  if (platform.inviteLink()) acc.push({ id: "prof-invite", text: t("account.invite"), act: copyInvite });
  if (acc.length) flow("prof-account-row", acc, w);
  if (!platform.signedIn()) para(t("profile.guest"), w, "dim");
  check("chk-hidden", t("profile.hidden"), settings.privacy.hiddenProfile, w, (v) => setSetting(() => { settings.privacy.hiddenProfile = v; }));
  ui.style("h3").label(t("profile.career"));
  ui.column("career", () => {
    dlRow("c-matches", t("profile.matches"), fmtInt(progress.totals.matches), w);
    dlRow("c-wins", t("profile.wins"), fmtInt(progress.totals.wins), w);
    dlRow("c-streak", t("profile.bestStreak"), fmtInt(progress.streak.best), w);
    dlRow("c-angled", t("profile.angled"), fmtInt(progress.totals.angledHits), w);
    dlRow("c-rating", t("profile.rating"), String(Math.round(progress.rating.mu * 40)), w);
  }, { spacing: 6, width: w });
  backButton(w);
}
function resumeScreen(w: number): void {
  heading("h2", t("resume.title"), w, "resume-h");
  para(t("resume.blurb", { ago: `${fmtTime(app.resumeAgo)} (${app.resumeAgo}s)` }), w, "dim");
  flow("resume-actions", [
    { id: "btn-resume-snapshot", text: t("resume.resume"), style: "btn-primary", act: resumeFromSnapshot },
    { id: "btn-discard-snapshot", text: t("resume.discard"), act: discardSnapshot },
  ], w, 10);
}

