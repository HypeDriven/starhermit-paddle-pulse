// Semantic HTML screens (spec §3). Menus, text, forms, settings, and
// assistive descriptions live in the DOM — the Three.js canvas is never the
// only UI. Every builder returns HTML; user data is escaped.

import { escapeHtml, fmtTime, fmtInt } from './app.js';
import { JOURNEY_LEVELS, CHALLENGES, AI_LEVELS, PRACTICE_DIFFICULTIES } from '../content/levels.js';
import { LESSONS } from '../content/tutorials.js';
import { ACHIEVEMENTS } from '../content/achievements.js';
import { THEMES } from '../content/themes.js';

const stars = (n) =>
  `<span class="stars" aria-label="${n} of 3 stars">${[1, 2, 3].map((i) => `<span class="star ${i <= n ? 'on' : ''}" aria-hidden="true">★</span>`).join('')}</span>`;

export const screenBuilders = {
  // -------------------------------------------------------------------------
  title: ({ progress, daily, name }) => {
    const cleared = Object.values(progress.journey).filter((j) => j.stars > 0).length;
    const totalStars = Object.values(progress.journey).reduce((a, j) => a + (j.stars || 0), 0);
    const dailyDone = progress.dailies[daily.date];
    return `
    <div class="title-wrap">
      <h1 class="logo"><span class="logo-paddle" aria-hidden="true"></span>Paddle&nbsp;Pulse</h1>
      <p class="tagline">A neon kinetic arena. Return the ball. Own the angle.</p>
      <div class="title-main">
        <button class="btn btn-primary btn-huge" data-action="quick-play" data-autofocus>Play</button>
      </div>
      <div class="title-secondary">
        <button class="card ${dailyDone ? 'done' : ''}" data-action="open-daily">
          <span class="card-title">Daily Pulse</span>
          <span class="card-sub">${escapeHtml(daily.name)} · ${dailyDone ? 'completed ✓' : 'new today'}</span>
        </button>
        <button class="card" data-action="open-journey">
          <span class="card-title">Journey</span>
          <span class="card-sub">${cleared}/40 stages · ${totalStars}★</span>
        </button>
        <button class="card" data-action="open-profile">
          <span class="card-title">${escapeHtml(name)}</span>
          <span class="card-sub">${progress.totals.wins} wins · streak ${progress.streak.current}</span>
        </button>
      </div>
      <nav class="title-nav" aria-label="More">
        <button class="btn" data-action="open-modes">All modes</button>
        <button class="btn" data-action="open-achievements">Achievements</button>
        <button class="btn" data-action="open-boards">Leaderboards</button>
        <button class="btn" data-action="open-settings">Settings</button>
        <button class="btn" data-action="open-help">Help</button>
      </nav>
    </div>`;
  },

  // -------------------------------------------------------------------------
  modes: () => `
    <div class="panel">
      <h2>Choose a mode</h2>
      <div class="card-grid">
        ${modeCard('learn', 'Learn', 'Interactive lessons — one rule at a time.', 'Unranked', '~1 min each')}
        ${modeCard('journey', 'Journey', '40 authored stages, periodic mastery trials.', 'Unranked', '~2 min each')}
        ${modeCard('daily', 'Daily Pulse', 'One shared seed per UTC day. Everyone plays the same match.', 'Ranked', '~2 min')}
        ${modeCard('practice', 'Practice', 'Selectable difficulty, restart and undo. No rating impact.', 'Unranked', '~2 min')}
        ${modeCard('challenge', 'Challenge', 'Constrained goals: move limits, speed floors, altered layouts.', 'Unranked', '~2 min')}
        ${modeCard('hosted', 'Hosted Play', 'Private rooms with friends, or shared-screen 2P.', 'Ranked when hosted', '~3 min')}
      </div>
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  journey: ({ progress }) => {
    const clearedCount = Object.values(progress.journey).filter((j) => j.stars > 0).length;
    const chapters = [];
    let cur = null;
    for (const l of JOURNEY_LEVELS) {
      if (l.chapter !== cur) {
        cur = l.chapter;
        chapters.push({ name: cur, levels: [] });
      }
      chapters[chapters.length - 1].levels.push(l);
    }
    return `
    <div class="panel panel-wide">
      <h2>Journey <span class="dim">— ${clearedCount}/40 cleared</span></h2>
      <p class="dim">One new concept at a time, then combined, then tested. Mastery stages gate each chapter.</p>
      ${chapters
        .map(
          (ch) => `
        <h3 class="chapter">${escapeHtml(ch.name)}</h3>
        <div class="level-grid" role="list">
          ${ch.levels
            .map((l) => {
              const rec = progress.journey[l.id];
              const cleared = (rec?.stars || 0) > 0;
              const prevCleared = l.index === 1 || (progress.journey['j' + String(l.index - 1).padStart(2, '0')]?.stars || 0) > 0;
              const locked = !cleared && !prevCleared;
              return `
              <button class="level-node ${l.mastery ? 'mastery' : ''} ${locked ? 'locked' : ''}" role="listitem"
                ${locked ? 'disabled aria-disabled="true"' : ''}
                data-action="journey-level" data-id="${l.id}"
                aria-label="Stage ${l.index}: ${escapeHtml(l.title)}${l.mastery ? ' (mastery)' : ''}${locked ? ' — locked' : ''}">
                <span class="level-num">${l.index}</span>
                ${stars(rec?.stars || 0)}
              </button>`;
            })
            .join('')}
        </div>`
        )
        .join('')}
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`;
  },

  // -------------------------------------------------------------------------
  challenges: ({ progress }) => `
    <div class="panel">
      <h2>Challenges</h2>
      <p class="dim">Constrained goals. The rules change; your skill doesn't.</p>
      <div class="card-grid">
        ${CHALLENGES.map(
          (c) => `
        <button class="card ${progress.challenges[c.id]?.cleared ? 'done' : ''}" data-action="challenge" data-id="${c.id}">
          <span class="card-title">${escapeHtml(c.title)} ${progress.challenges[c.id]?.cleared ? '✓' : ''}</span>
          <span class="card-sub">${escapeHtml(c.brief)}</span>
          <span class="chip">${escapeHtml(c.goals.constraint)}</span>
        </button>`
        ).join('')}
      </div>
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  learn: ({ settings }) => `
    <div class="panel">
      <h2>Learn</h2>
      <p class="dim">Short interactive lessons. Each asks you to perform the action — no lectures.</p>
      <div class="card-grid">
        ${LESSONS.map(
          (l, i) => `
        <button class="card ${settings.tutorialDone[l.id] ? 'done' : ''}" data-action="lesson" data-id="${l.id}">
          <span class="card-title">${i + 1}. ${escapeHtml(l.objective)} ${settings.tutorialDone[l.id] ? '✓' : ''}</span>
          <span class="card-sub">${l.steps.length} step${l.steps.length > 1 ? 's' : ''}</span>
        </button>`
        ).join('')}
      </div>
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  setup: ({ mode, title, brief, rules, players, ranked, duration, seed, assists, startLabel }) => `
    <div class="panel">
      <h2>${escapeHtml(title)}</h2>
      ${brief ? `<p class="dim">${escapeHtml(brief)}</p>` : ''}
      <dl class="rules-summary">
        ${rules.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
      </dl>
      <p><span class="chip ${ranked ? 'chip-ranked' : ''}">${ranked ? 'Ranked' : 'Unranked'}</span>
         <span class="chip">${escapeHtml(players)}</span>
         <span class="chip">~${escapeHtml(duration)}</span></p>
      <p class="seed-chip" title="Seeded and inspectable">seed <code>${escapeHtml(String(seed))}</code></p>
      ${assists ? `<label class="check"><input type="checkbox" data-setting="accessibility.timingAssist" ${assists.timingAssist ? 'checked' : ''}> Timing assist (wider paddle, declared on submission)</label>` : ''}
      <div class="row-gap">
        <button class="btn btn-primary btn-big" data-action="start-match" data-autofocus>${escapeHtml(startLabel || 'Start')}</button>
        <button class="btn" data-action="back">Back</button>
      </div>
    </div>`,

  // -------------------------------------------------------------------------
  daily: ({ daily, progress, countdownText }) => {
    const done = progress.dailies[daily.date];
    return `
    <div class="panel">
      <h2>Daily Pulse — ${escapeHtml(daily.name)}</h2>
      <p class="dim">One shared seed and ruleset per UTC day. Same match for everyone, synchronized to platform time.</p>
      <dl class="rules-summary">
        <div><dt>Date (UTC)</dt><dd>${escapeHtml(daily.date)}</dd></div>
        <div><dt>Seed</dt><dd><code>${daily.seed}</code></dd></div>
        <div><dt>Target</dt><dd>${daily.ruleset.targetScore} points, win by ${daily.ruleset.winMargin}</dd></div>
        <div><dt>Next daily in</dt><dd id="daily-countdown">${escapeHtml(countdownText)}</dd></div>
      </dl>
      ${done ? `<p class="chip">Completed: ${done.score[0]}–${done.score[1]} ${done.won ? '· won' : ''}</p>` : '<p class="chip chip-ranked">Ranked · one result per day counts</p>'}
      <div class="row-gap">
        <button class="btn btn-primary btn-big" data-action="play-daily" data-autofocus>${done ? 'Play again (unranked)' : 'Play the daily'}</button>
        <button class="btn" data-action="back">Back</button>
      </div>
    </div>`;
  },

  // -------------------------------------------------------------------------
  lobby: ({ rooms, state, code, error, roster, isHost, ready }) => `
    <div class="panel">
      <h2>Hosted Play</h2>
      ${error ? `<p class="error-text" role="alert">${escapeHtml(error)}</p>` : ''}
      ${
        state === 'idle'
          ? `
        <p class="dim">Create a private room and share its code, join with a code, or play shared-screen.</p>
        <div class="row-gap">
          <button class="btn btn-primary" data-action="host-create" data-autofocus>Create private room</button>
          <form data-form="join" class="row-gap inline-form">
            <input name="code" inputmode="text" maxlength="6" placeholder="ROOM CODE" aria-label="Room code" autocomplete="off">
            <button class="btn" type="submit">Join</button>
          </form>
          <button class="btn" data-action="host-local">Shared-screen 2P</button>
        </div>
        <p class="dim" id="lobby-net-status">${escapeHtml(rooms || '')}</p>`
          : `
        <p>Room <code class="room-code">${escapeHtml(code || '')}</code> — share this code.</p>
        <ul class="roster">
          ${(roster || [])
            .map(
              (r) => `
            <li class="${r.ready ? 'ready' : ''}">
              <span class="dot" aria-hidden="true"></span>${escapeHtml(r.name)} ${r.you ? '(you)' : ''} — ${r.ready ? 'ready' : 'not ready'}
            </li>`
            )
            .join('')}
        </ul>
        <div class="row-gap">
          <button class="btn btn-primary" data-action="host-ready">${ready ? 'Unready' : 'Ready'}</button>
          ${isHost ? '<button class="btn" data-action="host-start">Start match</button>' : ''}
          <button class="btn" data-action="host-leave">Leave</button>
        </div>
        <p class="dim">Reconnects restore the live snapshot and a “while you were away” summary.</p>`
      }
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  pause: ({ objective, canUndo }) => `
    <div class="panel">
      <h2>Paused</h2>
      <p class="dim">${escapeHtml(objective)}</p>
      <div class="col-gap">
        <button class="btn btn-primary btn-big" data-action="resume" data-autofocus>Resume</button>
        ${canUndo ? '<button class="btn" data-action="undo">Undo last point</button>' : ''}
        <button class="btn" data-action="restart-match">Restart match</button>
        <button class="btn" data-action="open-settings">Settings</button>
        <button class="btn" data-action="open-help">Help</button>
        <button class="btn btn-danger" data-action="leave-match">Leave match</button>
      </div>
    </div>`,

  // -------------------------------------------------------------------------
  results: ({ headline, sub, breakdown, starsEarned, unlocked, comparison, nextLabel, canVerify, won }) => `
    <div class="panel">
      <h2 class="result-headline ${won ? 'won' : 'lost'}">${escapeHtml(headline)}</h2>
      ${sub ? `<p class="dim">${escapeHtml(sub)}</p>` : ''}
      ${starsEarned != null ? `<div class="stars-big">${stars(starsEarned)}</div>` : ''}
      <h3>Score breakdown</h3>
      <table class="breakdown">
        <tbody>
          ${breakdown.map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join('')}
        </tbody>
      </table>
      ${
        unlocked?.length
          ? `<h3>Achievements unlocked</h3><ul class="unlock-list">${unlocked
              .map((a) => `<li><span aria-hidden="true">${a.icon}</span> <strong>${escapeHtml(a.name)}</strong> — ${escapeHtml(a.desc)}</li>`)
              .join('')}</ul>`
          : ''
      }
      ${comparison ? `<p class="dim">${escapeHtml(comparison)}</p>` : ''}
      <div class="row-gap">
        <button class="btn btn-primary" data-action="results-next" data-autofocus>${escapeHtml(nextLabel || 'Continue')}</button>
        <button class="btn" data-action="results-retry">Retry</button>
        ${canVerify ? '<button class="btn" data-action="results-verify">Verify replay</button>' : ''}
        <button class="btn" data-action="leave-match">Modes</button>
      </div>
    </div>`,

  // -------------------------------------------------------------------------
  settings: ({ settings, tiers }) => {
    const a = settings.accessibility;
    return `
    <div class="panel panel-wide settings-panel">
      <h2>Settings</h2>
      <div class="settings-cols">
        <section aria-labelledby="set-audio">
          <h3 id="set-audio">Audio</h3>
          ${['music', 'effects', 'ambience', 'voice']
            .map(
              (b) => `
          <label class="slider-row">${b[0].toUpperCase() + b.slice(1)}
            <input type="range" min="0" max="1" step="0.05" value="${settings.audio[b]}" data-audio="${b}">
            <span class="slider-val">${Math.round(settings.audio[b] * 100)}%</span>
          </label>`
            )
            .join('')}
          <label class="check"><input type="checkbox" data-setting="audio.muted" ${settings.audio.muted ? 'checked' : ''}> Mute all</label>
          <label class="check"><input type="checkbox" data-setting="accessibility.captions" ${a.captions ? 'checked' : ''}> Captions for meaningful audio</label>
        </section>
        <section aria-labelledby="set-graphics">
          <h3 id="set-graphics">Graphics</h3>
          <label class="select-row">Quality tier
            <select data-setting="graphics.tier">
              ${tiers.map((t) => `<option value="${t}" ${settings.graphics.tier === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </label>
          <label class="check"><input type="checkbox" data-setting="graphics.trails" ${settings.graphics.trails ? 'checked' : ''}> Ball trails</label>
          <label class="select-row">Camera
            <select data-setting="camera.view">
              <option value="broadcast" ${settings.camera.view === 'broadcast' ? 'selected' : ''}>Broadcast</option>
              <option value="behind" ${settings.camera.view === 'behind' ? 'selected' : ''}>Behind paddle</option>
            </select>
          </label>
        </section>
        <section aria-labelledby="set-a11y">
          <h3 id="set-a11y">Accessibility</h3>
          <label class="check"><input type="checkbox" data-setting="accessibility.reducedMotion" ${a.reducedMotion ? 'checked' : ''}> Reduced motion</label>
          <label class="check"><input type="checkbox" data-setting="accessibility.highContrast" ${a.highContrast ? 'checked' : ''}> High contrast</label>
          <label class="select-row">Color palette
            <select data-setting="accessibility.palette">
              ${['none', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast'].map((p) => `<option value="${p}" ${a.palette === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </label>
          <label class="slider-row">Text size
            <input type="range" min="0.85" max="1.4" step="0.05" value="${a.textScale}" data-setting-range="accessibility.textScale">
            <span class="slider-val">${Math.round(a.textScale * 100)}%</span>
          </label>
          <label class="check"><input type="checkbox" data-setting="accessibility.leftHanded" ${a.leftHanded ? 'checked' : ''}> Left-handed controls</label>
          <label class="check"><input type="checkbox" data-setting="accessibility.timingAssist" ${a.timingAssist ? 'checked' : ''}> Timing assist (declared on submissions)</label>
          <label class="check"><input type="checkbox" data-setting="accessibility.haptics" ${a.haptics ? 'checked' : ''}> Haptics</label>
          <label class="check"><input type="checkbox" data-action="replay-tutorials" ${Object.keys(settings.tutorialDone).length === 0 ? 'checked' : ''} disabled> Tutorial replay available from Learn</label>
        </section>
        <section aria-labelledby="set-controls">
          <h3 id="set-controls">Controls</h3>
          <ul class="bindings">
            ${Object.entries(settings.controls.keys)
              .map(([k, v]) => `<li><span>${k}</span><button class="btn btn-small" data-action="remap" data-key="${k}">${escapeHtml(v)}</button></li>`)
              .join('')}
          </ul>
          <p class="dim">Gamepad: left stick moves, A serves, Start pauses. Pointer/touch: drag to move, tap to serve.</p>
          <h3>Data</h3>
          <label class="check"><input type="checkbox" data-setting="consent.telemetry" ${settings.consent.telemetry ? 'checked' : ''}> Share anonymous usage events</label>
          <button class="btn btn-small" data-action="sync-cloud">Sync cloud save</button>
          <button class="btn btn-small btn-danger" data-action="reset-progress">Reset all progress</button>
        </section>
      </div>
      <div class="row-end"><button class="btn" data-action="back" data-autofocus>Done</button></div>
    </div>`;
  },

  // -------------------------------------------------------------------------
  achievements: ({ progress }) => `
    <div class="panel">
      <h2>Achievements</h2>
      <div class="card-grid">
        ${ACHIEVEMENTS.map((a) => {
          const rec = progress.achievements[a.key];
          const cur = rec?.progress || 0;
          const done = !!rec?.at;
          return `
          <div class="card achievement ${done ? 'done' : ''}">
            <span class="card-title"><span aria-hidden="true">${a.icon}</span> ${escapeHtml(a.name)}</span>
            <span class="card-sub">${escapeHtml(a.desc)}</span>
            ${a.progress ? `<span class="progress-bar"><span style="width:${Math.min(100, (cur / a.progress) * 100)}%"></span></span><span class="dim">${done ? 'unlocked' : `${fmtInt(cur)}/${fmtInt(a.progress)}`}</span>` : done ? '<span class="dim">unlocked</span>' : '<span class="dim">locked</span>'}
          </div>`;
        }).join('')}
      </div>
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  boards: ({ local, daily, date }) => `
    <div class="panel">
      <h2>Leaderboards</h2>
      <h3>Daily — ${escapeHtml(date)}</h3>
      ${boardTable(daily, ['name', 'score', 'duration'], ['Player', 'Goals', 'Time'])}
      <h3>Local — primary metric (wins)</h3>
      ${boardTable(local, ['name', 'score', 'duration'], ['Player', 'Wins', 'Best time'])}
      <h3>Friends</h3>
      <p class="dim">Friends boards appear when signed in through the host shell. Presence and privacy settings are always honored.</p>
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  help: ({ settings }) => {
    const k = settings.controls.keys;
    return `
    <div class="panel panel-wide">
      <h2>How to play</h2>
      <div class="card-grid">
        <div class="card"><span class="card-title">Goal</span><span class="card-sub">Return the speeding ball past your opponent's paddle and through the far goal line. First to the target score wins — you must lead by the margin.</span></div>
        <div class="card"><span class="card-title">Move</span><span class="card-sub">Drag on the arena, tap either side, or press ${escapeHtml(k.left)} / ${escapeHtml(k.right)}. Gamepad: left stick. Your paddle rides your goal line.</span></div>
        <div class="card"><span class="card-title">Serve</span><span class="card-sub">When the ball docks on your paddle, press ${escapeHtml(k.serve)}, tap the ball, or use the Serve button. The glowing paddle holds the serve.</span></div>
        <div class="card"><span class="card-title">Angles</span><span class="card-sub">The ball leaves your paddle at the angle you strike it: center goes straight, edges bend wide. Every return also gains pace.</span></div>
        <div class="card"><span class="card-title">Obstacles</span><span class="card-sub">Amber deflectors and moving blockers rebound the ball. Watch the sweep rhythm — it never changes mid-match.</span></div>
        <div class="card"><span class="card-title">Fair play</span><span class="card-sub">Every match is seeded and replayable. Identical seed + inputs always produce the identical result — check any result with “Verify replay”.</span></div>
      </div>
      <h3>Keys</h3>
      <ul class="bindings">
        <li><span>Pause</span><kbd>${escapeHtml(k.pause)}</kbd></li>
        <li><span>Undo (practice)</span><kbd>${escapeHtml(k.undo)}</kbd></li>
        <li><span>Camera view</span><kbd>${escapeHtml(k.camera)}</kbd></li>
        <li><span>Hint</span><kbd>${escapeHtml(k.hint)}</kbd></li>
      </ul>
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`;
  },

  // -------------------------------------------------------------------------
  profile: ({ settings, progress, hosted }) => `
    <div class="panel">
      <h2>Profile</h2>
      <form data-form="profile" class="col-gap">
        <label>Display name
          <input name="displayName" maxlength="24" value="${escapeHtml(settings.displayName)}" autocomplete="off">
        </label>
        <button class="btn btn-primary" type="submit" data-autofocus>Save</button>
      </form>
      ${hosted ? '<button class="btn" data-action="sign-in">Sign in for durable progress</button>' : '<p class="dim">Guest mode — progress lives on this device. Sign-in is offered by the host shell when available.</p>'}
      <label class="check"><input type="checkbox" data-setting="privacy.hiddenProfile" ${settings.privacy.hiddenProfile ? 'checked' : ''}> Hide my profile from friends' boards</label>
      <h3>Career</h3>
      <dl class="rules-summary">
        <div><dt>Matches</dt><dd>${fmtInt(progress.totals.matches)}</dd></div>
        <div><dt>Wins</dt><dd>${fmtInt(progress.totals.wins)}</dd></div>
        <div><dt>Best streak</dt><dd>${fmtInt(progress.streak.best)}</dd></div>
        <div><dt>Angled returns</dt><dd>${fmtInt(progress.totals.angledHits)}</dd></div>
        <div><dt>Rating (display)</dt><dd>${Math.round(progress.rating.mu * 40)}</dd></div>
      </dl>
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  resume: ({ tickSeconds }) => `
    <div class="panel">
      <h2>Match in progress</h2>
      <p class="dim">A safe snapshot was saved ${escapeHtml(tickSeconds)} ago. Backgrounding always pauses solo play.</p>
      <div class="row-gap">
        <button class="btn btn-primary" data-action="resume-snapshot" data-autofocus>Resume match</button>
        <button class="btn" data-action="discard-snapshot">Discard</button>
      </div>
    </div>`,

  compat: () => `
    <div class="panel">
      <h2>3D unavailable</h2>
      <p>Paddle Pulse needs WebGL for its arena. Your browser or device blocked it. Your account and progress are safe — try updating the browser, enabling hardware acceleration, or another device.</p>
      <div class="row-end"><button class="btn" data-action="back">Back</button></div>
    </div>`,

  boot: ({ pct, label }) => `
    <div class="boot-wrap">
      <h1 class="logo">Paddle&nbsp;Pulse</h1>
      <div class="boot-bar"><span style="width:${pct}%"></span></div>
      <p class="dim" role="status">${escapeHtml(label)}</p>
    </div>`,
};

function modeCard(id, title, sub, ranked, duration) {
  return `
    <button class="card" data-action="mode-${id}">
      <span class="card-title">${title}</span>
      <span class="card-sub">${sub}</span>
      <span class="chip ${ranked.startsWith('Ranked') ? 'chip-ranked' : ''}">${ranked}</span>
      <span class="chip">${duration}</span>
    </button>`;
}

function boardTable(rows, cols, heads) {
  if (!rows?.length) return '<p class="dim">No entries yet — be the first.</p>';
  return `<table class="board"><thead><tr>${heads.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .slice(0, 20)
      .map(
        (r) =>
          `<tr>${cols
            .map((c) => `<td>${c === 'duration' ? fmtTime(r[c]) : escapeHtml(String(r[c]))}${c === 'score' && r.assists ? ' <span class="chip" title="declared assists">A</span>' : ''}</td>`)
            .join('')}</tr>`
      )
      .join('')}</tbody></table>`;
}
