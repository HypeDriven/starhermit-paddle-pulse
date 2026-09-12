// Semantic HTML screens (spec §3). Menus, text, forms, settings, and
// assistive descriptions live in the DOM — the Three.js canvas is never the
// only UI. Every builder returns HTML; user data is escaped. All user-facing
// strings go through t() so screens re-render in the player's locale.

import { escapeHtml, fmtTime, fmtInt } from './app.js';
import { t, LOCALES, LOCALE_NAMES } from './i18n.js';
import { JOURNEY_LEVELS, CHALLENGES, AI_LEVELS, PRACTICE_DIFFICULTIES } from '../content/levels.js';
import { LESSONS } from '../content/tutorials.js';
import { ACHIEVEMENTS } from '../content/achievements.js';
import { THEMES } from '../content/themes.js';

const stars = (n) =>
  `<span class="stars" aria-label="${n} of 3 stars">${[1, 2, 3].map((i) => `<span class="star ${i <= n ? 'on' : ''}" aria-hidden="true">★</span>`).join('')}</span>`;

const SYNC_LABEL_KEY = {
  offline: 'sync.stateOffline',
  saving: 'sync.stateSaving',
  synced: 'sync.stateSynced',
  error: 'sync.stateError',
};

export const screenBuilders = {
  // -------------------------------------------------------------------------
  title: ({ progress, daily, name }) => {
    const cleared = Object.values(progress.journey).filter((j) => j.stars > 0).length;
    const totalStars = Object.values(progress.journey).reduce((a, j) => a + (j.stars || 0), 0);
    const dailyDone = progress.dailies[daily.date];
    return `
    <div class="title-wrap">
      <h1 class="logo"><span class="logo-paddle" aria-hidden="true"></span>Paddle&nbsp;Pulse</h1>
      <p class="tagline">${t('title.tagline')}</p>
      <div class="title-main">
        <button class="btn btn-primary btn-huge" data-action="quick-play" data-autofocus>${t('title.play')}</button>
      </div>
      <div class="title-secondary">
        <button class="card ${dailyDone ? 'done' : ''}" data-action="open-daily">
          <span class="card-title">${t('title.daily')}</span>
          <span class="card-sub">${t('title.dailySub', { name: escapeHtml(daily.name), state: dailyDone ? t('title.dailyDone') : t('title.dailyNew') })}</span>
        </button>
        <button class="card" data-action="open-journey">
          <span class="card-title">${t('title.journey')}</span>
          <span class="card-sub">${t('title.journeySub', { cleared, stars: totalStars })}</span>
        </button>
        <button class="card" data-action="open-profile">
          <span class="card-title">${escapeHtml(name)}</span>
          <span class="card-sub">${t('title.profileSub', { wins: progress.totals.wins, streak: progress.streak.current })}</span>
        </button>
      </div>
      <nav class="title-nav" aria-label="${t('title.navMore')}">
        <button class="btn" data-action="open-modes">${t('nav.modes')}</button>
        <button class="btn" data-action="open-achievements">${t('nav.achievements')}</button>
        <button class="btn" data-action="open-boards">${t('nav.boards')}</button>
        <button class="btn" data-action="open-settings">${t('nav.settings')}</button>
        <button class="btn" data-action="open-help">${t('nav.help')}</button>
      </nav>
    </div>`;
  },

  // -------------------------------------------------------------------------
  modes: () => `
    <div class="panel">
      <h2>${t('modes.title')}</h2>
      <div class="card-grid">
        ${modeCard('learn', 'chip.unranked', 'dur.lesson')}
        ${modeCard('journey', 'chip.unranked', 'dur.stage')}
        ${modeCard('daily', 'chip.ranked', 'dur.match')}
        ${modeCard('practice', 'chip.unranked', 'dur.match')}
        ${modeCard('challenge', 'chip.unranked', 'dur.match')}
        ${modeCard('hosted', 'chip.rankedHosted', 'dur.hosted')}
      </div>
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
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
      <h2>${t('title.journey')} <span class="dim">${t('journey.cleared', { n: clearedCount })}</span></h2>
      <p class="dim">${t('journey.blurb')}</p>
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
                aria-label="${escapeHtml(t('journey.ariaStage', { n: l.index, title: l.title }) + (l.mastery ? t('journey.ariaMastery') : '') + (locked ? t('journey.ariaLocked') : ''))}">
                <span class="level-num">${l.index}</span>
                ${stars(rec?.stars || 0)}
              </button>`;
            })
            .join('')}
        </div>`
        )
        .join('')}
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
    </div>`;
  },

  // -------------------------------------------------------------------------
  challenges: ({ progress }) => `
    <div class="panel">
      <h2>${t('challenges.title')}</h2>
      <p class="dim">${t('challenges.blurb')}</p>
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
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  learn: ({ settings }) => `
    <div class="panel">
      <h2>${t('learn.title')}</h2>
      <p class="dim">${t('learn.blurb')}</p>
      <div class="card-grid">
        ${LESSONS.map(
          (l, i) => `
        <button class="card ${settings.tutorialDone[l.id] ? 'done' : ''}" data-action="lesson" data-id="${l.id}">
          <span class="card-title">${i + 1}. ${escapeHtml(l.objective)} ${settings.tutorialDone[l.id] ? '✓' : ''}</span>
          <span class="card-sub">${t(l.steps.length > 1 ? 'learn.stepMany' : 'learn.stepOne', { n: l.steps.length })}</span>
        </button>`
        ).join('')}
      </div>
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  setup: ({ mode, title, brief, rules, players, ranked, duration, seed, assists, startLabel }) => `
    <div class="panel">
      <h2>${escapeHtml(title)}</h2>
      ${brief ? `<p class="dim">${escapeHtml(brief)}</p>` : ''}
      <dl class="rules-summary">
        ${rules.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
      </dl>
      <p><span class="chip ${ranked ? 'chip-ranked' : ''}">${ranked ? t('chip.ranked') : t('chip.unranked')}</span>
         <span class="chip">${escapeHtml(players)}</span>
         <span class="chip">${escapeHtml(duration)}</span></p>
      <p class="seed-chip" title="${escapeHtml(t('setup.seedTitle'))}">${t('setup.seed')} <code>${escapeHtml(String(seed))}</code></p>
      ${assists ? `<label class="check"><input type="checkbox" data-setting="accessibility.timingAssist" ${assists.timingAssist ? 'checked' : ''}> ${t('setup.timingAssist')}</label>` : ''}
      <div class="row-gap">
        <button class="btn btn-primary btn-big" data-action="start-match" data-autofocus>${escapeHtml(startLabel || t('common.start'))}</button>
        <button class="btn" data-action="back">${t('common.back')}</button>
      </div>
    </div>`,

  // -------------------------------------------------------------------------
  daily: ({ daily, progress, countdownText }) => {
    const done = progress.dailies[daily.date];
    return `
    <div class="panel">
      <h2>${escapeHtml(t('daily.heading', { name: daily.name }))}</h2>
      <p class="dim">${t('daily.blurb')}</p>
      <dl class="rules-summary">
        <div><dt>${t('daily.date')}</dt><dd>${escapeHtml(daily.date)}</dd></div>
        <div><dt>${t('daily.seed')}</dt><dd><code>${daily.seed}</code></dd></div>
        <div><dt>${t('setup.ruleTarget')}</dt><dd>${t('setup.valTarget', { score: daily.ruleset.targetScore, margin: daily.ruleset.winMargin })}</dd></div>
        <div><dt>${t('daily.nextIn')}</dt><dd id="daily-countdown">${escapeHtml(countdownText)}</dd></div>
      </dl>
      ${done ? `<p class="chip">${t('daily.completed', { a: done.score[0], b: done.score[1], won: done.won ? t('daily.won') : '' })}</p>` : `<p class="chip chip-ranked">${t('daily.rankedChip')}</p>`}
      <div class="row-gap">
        <button class="btn btn-primary btn-big" data-action="play-daily" data-autofocus>${done ? t('daily.playAgain') : t('daily.play')}</button>
        <button class="btn" data-action="back">${t('common.back')}</button>
      </div>
    </div>`;
  },

  // -------------------------------------------------------------------------
  // Online rooms are not part of this build — the lobby offers shared-screen
  // 2P only, with an honest note about online play.
  lobby: ({ rooms, error }) => `
    <div class="panel">
      <h2>${t('lobby.title')}</h2>
      ${error ? `<p class="error-text" role="alert">${escapeHtml(error)}</p>` : ''}
      <p class="dim">${t('lobby.idleBlurb')}</p>
      <div class="row-gap">
        <button class="btn btn-primary" data-action="host-local" data-autofocus>${t('lobby.local')}</button>
      </div>
      <p class="dim" role="note">${t('lobby.onlineNote')}</p>
      <p class="dim" id="lobby-net-status">${escapeHtml(rooms || '')}</p>
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  pause: ({ objective, canUndo }) => `
    <div class="panel">
      <h2>${t('pause.title')}</h2>
      <p class="dim">${escapeHtml(objective)}</p>
      <div class="col-gap">
        <button class="btn btn-primary btn-big" data-action="resume" data-autofocus>${t('pause.resume')}</button>
        ${canUndo ? `<button class="btn" data-action="undo">${t('pause.undo')}</button>` : ''}
        <button class="btn" data-action="restart-match">${t('pause.restart')}</button>
        <button class="btn" data-action="open-settings">${t('nav.settings')}</button>
        <button class="btn" data-action="open-help">${t('nav.help')}</button>
        <button class="btn btn-danger" data-action="leave-match">${t('pause.leave')}</button>
      </div>
    </div>`,

  // -------------------------------------------------------------------------
  results: ({ headline, sub, breakdown, starsEarned, unlocked, comparison, nextLabel, canVerify, won }) => `
    <div class="panel">
      <h2 class="result-headline ${won ? 'won' : 'lost'}">${escapeHtml(headline)}</h2>
      ${sub ? `<p class="dim">${escapeHtml(sub)}</p>` : ''}
      ${starsEarned != null ? `<div class="stars-big">${stars(starsEarned)}</div>` : ''}
      <h3>${t('results.breakdown')}</h3>
      <table class="breakdown">
        <tbody>
          ${breakdown.map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join('')}
        </tbody>
      </table>
      ${
        unlocked?.length
          ? `<h3>${t('results.achievements')}</h3><ul class="unlock-list">${unlocked
              .map((a) => `<li><span aria-hidden="true">${a.icon}</span> <strong>${escapeHtml(a.name)}</strong> — ${escapeHtml(a.desc)}</li>`)
              .join('')}</ul>`
          : ''
      }
      ${comparison ? `<p class="dim">${escapeHtml(comparison)}</p>` : ''}
      <div class="row-gap">
        <button class="btn btn-primary" data-action="results-next" data-autofocus>${escapeHtml(nextLabel || t('common.cont'))}</button>
        <button class="btn" data-action="results-retry">${t('results.retry')}</button>
        ${canVerify ? `<button class="btn" data-action="results-verify">${t('results.verify')}</button>` : ''}
        <button class="btn" data-action="leave-match">${t('results.modes')}</button>
      </div>
    </div>`,

  // -------------------------------------------------------------------------
  settings: ({ settings, tiers, syncState }) => {
    const a = settings.accessibility;
    return `
    <div class="panel panel-wide settings-panel">
      <h2>${t('settings.title')}</h2>
      <div class="settings-cols">
        <section aria-labelledby="set-lang">
          <h3 id="set-lang">${t('settings.language')}</h3>
          <label class="select-row">${t('settings.language')}
            <select data-setting="language">
              <option value="auto" ${settings.language === 'auto' ? 'selected' : ''}>${t('settings.langAuto')}</option>
              ${LOCALES.map((l) => `<option value="${l}" ${settings.language === l ? 'selected' : ''}>${LOCALE_NAMES[l]}</option>`).join('')}
            </select>
          </label>
        </section>
        <section aria-labelledby="set-audio">
          <h3 id="set-audio">${t('settings.audio')}</h3>
          ${['music', 'effects', 'ambience', 'voice']
            .map(
              (b) => `
          <label class="slider-row">${t('settings.' + b)}
            <input type="range" min="0" max="1" step="0.05" value="${settings.audio[b]}" data-audio="${b}">
            <span class="slider-val">${Math.round(settings.audio[b] * 100)}%</span>
          </label>`
            )
            .join('')}
          <label class="check"><input type="checkbox" data-setting="audio.muted" ${settings.audio.muted ? 'checked' : ''}> ${t('settings.muteAll')}</label>
          <label class="check"><input type="checkbox" data-setting="accessibility.captions" ${a.captions ? 'checked' : ''}> ${t('settings.captions')}</label>
        </section>
        <section aria-labelledby="set-graphics">
          <h3 id="set-graphics">${t('settings.graphics')}</h3>
          <label class="select-row">${t('settings.quality')}
            <select data-setting="graphics.tier">
              ${tiers.map((tier) => `<option value="${tier}" ${settings.graphics.tier === tier ? 'selected' : ''}>${tier}</option>`).join('')}
            </select>
          </label>
          <label class="check"><input type="checkbox" data-setting="graphics.trails" ${settings.graphics.trails ? 'checked' : ''}> ${t('settings.trails')}</label>
          <label class="select-row">${t('settings.camera')}
            <select data-setting="camera.view">
              <option value="broadcast" ${settings.camera.view === 'broadcast' ? 'selected' : ''}>${t('settings.camBroadcast')}</option>
              <option value="behind" ${settings.camera.view === 'behind' ? 'selected' : ''}>${t('settings.camBehind')}</option>
            </select>
          </label>
        </section>
        <section aria-labelledby="set-a11y">
          <h3 id="set-a11y">${t('settings.a11y')}</h3>
          <label class="check"><input type="checkbox" data-setting="accessibility.reducedMotion" ${a.reducedMotion ? 'checked' : ''}> ${t('settings.reducedMotion')}</label>
          <label class="check"><input type="checkbox" data-setting="accessibility.highContrast" ${a.highContrast ? 'checked' : ''}> ${t('settings.highContrast')}</label>
          <label class="select-row">${t('settings.palette')}
            <select data-setting="accessibility.palette">
              ${['none', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast'].map((p) => `<option value="${p}" ${a.palette === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </label>
          <label class="slider-row">${t('settings.textSize')}
            <input type="range" min="0.85" max="1.4" step="0.05" value="${a.textScale}" data-setting-range="accessibility.textScale">
            <span class="slider-val">${Math.round(a.textScale * 100)}%</span>
          </label>
          <label class="check"><input type="checkbox" data-setting="accessibility.leftHanded" ${a.leftHanded ? 'checked' : ''}> ${t('settings.leftHanded')}</label>
          <label class="check"><input type="checkbox" data-setting="accessibility.timingAssist" ${a.timingAssist ? 'checked' : ''}> ${t('settings.timingAssist')}</label>
          <label class="check"><input type="checkbox" data-setting="accessibility.haptics" ${a.haptics ? 'checked' : ''}> ${t('settings.haptics')}</label>
          <label class="check"><input type="checkbox" data-action="replay-tutorials" ${Object.keys(settings.tutorialDone).length === 0 ? 'checked' : ''} disabled> ${t('settings.tutorialReplay')}</label>
        </section>
        <section aria-labelledby="set-controls">
          <h3 id="set-controls">${t('settings.controls')}</h3>
          <ul class="bindings">
            ${Object.entries(settings.controls.keys)
              .map(([k, v]) => `<li><span>${k}</span><button class="btn btn-small" data-action="remap" data-key="${k}">${escapeHtml(v)}</button></li>`)
              .join('')}
          </ul>
          <p class="dim">${t('settings.gamepadNote')}</p>
          <h3>${t('settings.data')}</h3>
          <label class="check"><input type="checkbox" data-setting="consent.telemetry" ${settings.consent.telemetry ? 'checked' : ''}> ${t('settings.telemetry')}</label>
          <button class="btn btn-small" data-action="sync-cloud">${t('settings.syncCloud')}</button>
          <p class="dim" id="cloud-sync-status" role="status">${escapeHtml(t('settings.syncStatus', { state: t(SYNC_LABEL_KEY[syncState] || 'sync.stateOffline') }))}</p>
          <button class="btn btn-small btn-danger" data-action="reset-progress">${t('settings.reset')}</button>
        </section>
      </div>
      <div class="row-end"><button class="btn" data-action="back" data-autofocus>${t('settings.done')}</button></div>
    </div>`;
  },

  // -------------------------------------------------------------------------
  achievements: ({ progress }) => `
    <div class="panel">
      <h2>${t('achievements.title')}</h2>
      <div class="card-grid">
        ${ACHIEVEMENTS.map((a) => {
          const rec = progress.achievements[a.key];
          const cur = rec?.progress || 0;
          const done = !!rec?.at;
          return `
          <div class="card achievement ${done ? 'done' : ''}">
            <span class="card-title"><span aria-hidden="true">${a.icon}</span> ${escapeHtml(a.name)}</span>
            <span class="card-sub">${escapeHtml(a.desc)}</span>
            ${a.progress ? `<span class="progress-bar"><span style="width:${Math.min(100, (cur / a.progress) * 100)}%"></span></span><span class="dim">${done ? t('achievements.unlocked') : t('achievements.progressFmt', { cur: fmtInt(cur), total: fmtInt(a.progress) })}</span>` : done ? `<span class="dim">${t('achievements.unlocked')}</span>` : `<span class="dim">${t('achievements.locked')}</span>`}
          </div>`;
        }).join('')}
      </div>
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  boards: ({ local, daily, date }) => `
    <div class="panel">
      <h2>${t('boards.title')}</h2>
      <h3>${escapeHtml(t('boards.dailyFmt', { date }))}</h3>
      ${boardTable(daily, ['name', 'score', 'duration'], [t('boards.colPlayer'), t('boards.colGoals'), t('boards.colTime')])}
      <h3>${t('boards.local')}</h3>
      ${boardTable(local, ['name', 'score', 'duration'], [t('boards.colPlayer'), t('boards.colWins'), t('boards.colBestTime')])}
      <h3>${t('boards.friends')}</h3>
      <p class="dim">${t('boards.friendsBlurb')}</p>
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  help: ({ settings }) => {
    const k = settings.controls.keys;
    return `
    <div class="panel panel-wide">
      <h2>${t('help.title')}</h2>
      <div class="card-grid">
        <div class="card"><span class="card-title">${t('help.goal')}</span><span class="card-sub">${t('help.goalBody')}</span></div>
        <div class="card"><span class="card-title">${t('help.move')}</span><span class="card-sub">${escapeHtml(t('help.moveBody', { left: k.left, right: k.right }))}</span></div>
        <div class="card"><span class="card-title">${t('help.serve')}</span><span class="card-sub">${escapeHtml(t('help.serveBody', { serve: k.serve }))}</span></div>
        <div class="card"><span class="card-title">${t('help.angles')}</span><span class="card-sub">${t('help.anglesBody')}</span></div>
        <div class="card"><span class="card-title">${t('help.obstacles')}</span><span class="card-sub">${t('help.obstaclesBody')}</span></div>
        <div class="card"><span class="card-title">${t('help.fair')}</span><span class="card-sub">${t('help.fairBody')}</span></div>
      </div>
      <h3>${t('help.keys')}</h3>
      <ul class="bindings">
        <li><span>${t('help.keyPause')}</span><kbd>${escapeHtml(k.pause)}</kbd></li>
        <li><span>${t('help.keyUndo')}</span><kbd>${escapeHtml(k.undo)}</kbd></li>
        <li><span>${t('help.keyCamera')}</span><kbd>${escapeHtml(k.camera)}</kbd></li>
        <li><span>${t('help.keyHint')}</span><kbd>${escapeHtml(k.hint)}</kbd></li>
      </ul>
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
    </div>`;
  },

  // -------------------------------------------------------------------------
  profile: ({ settings, progress, hosted, account }) => `
    <div class="panel">
      <h2>${t('profile.title')}</h2>
      ${hosted && account ? `<p class="dim">${escapeHtml(t('profile.account', { name: account }))}</p>` : ''}
      <form data-form="profile" class="col-gap">
        <label>${t('profile.displayName')}
          <input name="displayName" maxlength="24" value="${escapeHtml(settings.displayName)}" autocomplete="off">
        </label>
        <button class="btn btn-primary" type="submit" data-autofocus>${t('profile.save')}</button>
      </form>
      ${hosted ? `<button class="btn" data-action="sign-in">${t('profile.signIn')}</button>` : `<p class="dim">${t('profile.guest')}</p>`}
      <label class="check"><input type="checkbox" data-setting="privacy.hiddenProfile" ${settings.privacy.hiddenProfile ? 'checked' : ''}> ${t('profile.hidden')}</label>
      <h3>${t('profile.career')}</h3>
      <dl class="rules-summary">
        <div><dt>${t('profile.matches')}</dt><dd>${fmtInt(progress.totals.matches)}</dd></div>
        <div><dt>${t('profile.wins')}</dt><dd>${fmtInt(progress.totals.wins)}</dd></div>
        <div><dt>${t('profile.bestStreak')}</dt><dd>${fmtInt(progress.streak.best)}</dd></div>
        <div><dt>${t('profile.angled')}</dt><dd>${fmtInt(progress.totals.angledHits)}</dd></div>
        <div><dt>${t('profile.rating')}</dt><dd>${Math.round(progress.rating.mu * 40)}</dd></div>
      </dl>
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
    </div>`,

  // -------------------------------------------------------------------------
  resume: ({ tickSeconds }) => `
    <div class="panel">
      <h2>${t('resume.title')}</h2>
      <p class="dim">${escapeHtml(t('resume.blurb', { ago: tickSeconds }))}</p>
      <div class="row-gap">
        <button class="btn btn-primary" data-action="resume-snapshot" data-autofocus>${t('resume.resume')}</button>
        <button class="btn" data-action="discard-snapshot">${t('resume.discard')}</button>
      </div>
    </div>`,

  compat: () => `
    <div class="panel">
      <h2>${t('compat.title')}</h2>
      <p>${t('compat.body')}</p>
      <div class="row-end"><button class="btn" data-action="back">${t('common.back')}</button></div>
    </div>`,

  boot: ({ pct, label }) => `
    <div class="boot-wrap">
      <h1 class="logo">Paddle&nbsp;Pulse</h1>
      <div class="boot-bar"><span style="width:${pct}%"></span></div>
      <p class="dim" role="status">${escapeHtml(label)}</p>
    </div>`,
};

const MODE_TITLES = {
  learn: 'modes.learn',
  journey: 'title.journey',
  daily: 'title.daily',
  practice: 'modes.practice',
  challenge: 'modes.challenge',
  hosted: 'lobby.title',
};

function modeCard(id, rankedKey, durKey) {
  return `
    <button class="card" data-action="mode-${id}">
      <span class="card-title">${t(MODE_TITLES[id])}</span>
      <span class="card-sub">${t('modes.' + id + 'Sub')}</span>
      <span class="chip ${rankedKey === 'chip.ranked' || rankedKey === 'chip.rankedHosted' ? 'chip-ranked' : ''}">${t(rankedKey)}</span>
      <span class="chip">${t(durKey)}</span>
    </button>`;
}

function boardTable(rows, cols, heads) {
  if (!rows?.length) return `<p class="dim">${t('boards.empty')}</p>`;
  return `<table class="board"><thead><tr>${heads.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .slice(0, 20)
      .map(
        (r) =>
          `<tr>${cols
            .map((c) => `<td>${c === 'duration' ? fmtTime(r[c]) : escapeHtml(String(r[c]))}${c === 'score' && r.assists ? ` <span class="chip" title="${escapeHtml(t('setup.timingAssist'))}">A</span>` : ''}</td>`)
            .join('')}</tr>`
      )
      .join('')}</tbody></table>`;
}
