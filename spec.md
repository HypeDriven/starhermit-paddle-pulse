# Paddle Pulse — Product and Game Specification

**Document status:** design specification only; no implementation is included.  
**Game index:** 90  
**Genre:** Realtime paddle sport  
**Players:** 2–32 players as specified by playlist  
**Targets:** desktop browsers, mobile browsers, landscape and portrait where practical  
**Rendering direction:** Three.js-first presentation with a fully usable semantic HTML interface layer

## 1. Product vision

Paddle Pulse is a game in which players move a paddle to return a speeding ball and score through the opponent's goal line. Its signature setting is a neon kinetic arena with restrained trails. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Move a paddle to return a speeding ball and score through the opponent's goal line.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **track the ball, position the paddle, return with an angle, recover, and defend**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

First to the target score wins by the configured margin; authoritative simulation resolves contacts. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, synchronized to platform time.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Hosted play:** private invitations and appropriate public matching, with reconnect and authoritative results.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Interaction and user-interface design

### Information hierarchy

1. **Primary:** playfield, current objective, legal interaction target, and immediate danger or turn state.
2. **Secondary:** score/progress, remaining moves or time, opponent/party status where applicable.
3. **Tertiary:** settings, social controls, cosmetics, help, and history.

The Three.js canvas fills the game region but is never the only UI. Menus, text, forms, chat, settings, and assistive descriptions use semantic HTML over or beside the canvas. Maintain a single shared layout model so DOM labels align with projected Three.js targets.

### Responsive layouts

- **Wide desktop (≥1024 CSS px):** centered playfield, objective/progression rail on the left, contextual actions and social/status rail on the right. Maximum line length is 70 characters.
- **Compact desktop/tablet:** playfield remains central; secondary rails collapse into drawers. Pointer hover may preview but never be required.
- **Portrait mobile:** top safe-area status bar, square or perspective-fit playfield, bottom thumb-zone action tray, and sheet-based secondary panels. Never place critical controls under browser chrome or display cutouts. Audio captions sit just under the score pill so they never cover the objective rail.
- **Landscape mobile:** reserve a narrow status rail; preserve at least 44×44 CSS-pixel targets and 8-pixel separation. The title screen fits without scrolling; every screen opens at its top with its heading visible (focus moves in without scrolling).
- **Large screens (above 1600×1000):** `ui-scale.js` sets `--ui-scale` (`min(w/1600, h/1000)`, capped at 2.5); the HUD, every screen, toasts, captions and the frame-rate meter are CSS-`zoom`ed by it (their vw lengths divided by it), while the full-viewport 3D canvas stays unzoomed.
- A screen opened over another (stage setup over the journey grid, settings over pause) uses a darker scrim so the screen below does not show through.
- React to resize, orientation, device-pixel-ratio, safe-area insets, virtual keyboard, and visibility changes without losing input or restarting the round.

### Screens and overlays

- **Title/home:** Play is dominant; daily challenge, journey progress, and profile are one level below.
- **Mode setup:** show rules, expected duration, player count, assists, and whether the result is ranked before commitment.
- **Play HUD:** objective, progress, current actor/state, pause, and only context-relevant actions.
- **Pause/settings:** resume first; audio, graphics, controls, accessibility, help, and leave are clearly separated.
- **Results:** outcome headline, score breakdown, progress, achievements, comparison, replay/retry, and next recommended action.
- **Help:** visual rule cards generated from current control mappings and representative legal states.
- Lobby, roster, readiness, invitation, reconnect, result, and report states are first-class screens.

### Input

- Pointer/touch: raycast only against explicit interaction layers; use pointer capture for drags; cancel safely on lost capture.
- Touch: distinguish tap, drag, and camera gesture by distance/time thresholds; never require multi-touch for core play.
- Keyboard: directional navigation among legal targets, confirm, cancel, pause, undo/hint where valid, and camera reset.
- Gamepad: focus navigation, primary/secondary actions, pause, and remappable axes/buttons.
- Prevent accidental double commits with action identifiers, not arbitrary long debounce timers. Provide visible drag origin, target preview, and invalid-action explanation.

### Accessibility

- Full keyboard operation and visible focus; DOM equivalents for canvas controls; headings and live regions for objective, turn, score, errors, and results.
- Color is reinforced by shape, texture, icon, or label. Include contrast-safe and common color-vision palettes.
- Reduced-motion mode removes camera swoops, shake, parallax, rapid particles, and large scaling while preserving event timing.
- Independent sliders for music, effects, ambience, and voice; captions/text cues for meaningful audio; no audio-only gameplay.
- Options for larger text, high contrast, left-handed controls, hold-versus-toggle, timing assistance, haptics off, and tutorial replay.
- Announce Three.js board state through a concise navigable model rather than describing every decorative object.

## 4. Visual and audio design

### Visual contract

The subject is the active playfield at near-tabletop to room scale, framed so state changes occupy most of the screen. The scene is a neon kinetic arena with restrained trails. Use an authored camera, original procedural geometry, restrained environmental storytelling, and a deterministic visual seed. The no-post-processing baseline must still communicate hierarchy, depth, selection, and state.

### Three.js scene design

- Use physically based lighting and color management with one dominant key, soft environment fill, and contact grounding. Gameplay colors are tested after tone mapping.
- Build reusable semantic meshes for active pieces, board cells, obstacles, targets, and environment modules. Geometry detail follows silhouette importance and camera distance.
- Use instancing for repeated pieces and props, pooled effects, texture atlases where appropriate, and explicit disposal on scene changes.
- Separate render layers for environment, gameplay, selection/ghosts, effects, and UI anchors. Cosmetic particles never intercept raycasts.
- Selection uses a combination of lift/pose, outline or rim, and grounded marker—not bloom alone. Legal targets preview before commit; invalid targets explain why.
- Event hierarchy: input acknowledgment < legal move < combo/goal < round completion. Reserve camera motion, strong emission, and dense particles for the highest tier.
- Audio uses original short transients tied to logical events, layered material impacts, quiet ambience, and adaptive music stems. Randomized pitch/variant is seeded for replay consistency where recording matters.

### Graphics

The arena is lit by a hemisphere fill, a soft accent ambient and one key directional light whose PCF shadow frustum is fitted tightly around the play area; output uses ACES filmic tone mapping in sRGB, and the fog range follows the camera's framing distance so a far portrait camera keeps the neon crisp. The detailed look adds image-based lighting (a PMREM-filtered room environment as `scene.environment`), clearcoated PBR paddles, rails, blockers and ball with rounded bevels, a seeded brushed-panel floor texture that runs out into the fog, HDR neon tubes along the rails and paddle edges, light strips on the surround pillars, and soft contact blobs under ball and paddles when shadow maps are off. Optional effects: a planar mirror under a semi-transparent floor (floor reflections), GTAO ambient occlusion, bloom limited to HDR accents (threshold 0.88, strength per theme), a colour grade with S-curve, saturation and vignette, and FXAA/SMAA/MSAA anti-aliasing. The animated background shimmers the pillar strips, breathes the grid and drifts dust motes; it and the menu backdrop (the arena behind the title screens with a cosmetic rally and a slow camera orbit) freeze under reduced motion, and a still backdrop is drawn once rather than every frame.

Settings → **Graphics** offers a quality preset (Auto, chosen from the StarHermit hardware level below; Low; Balanced; High; Ultra), a render scale (50–200% of the preset's scale; the device pixel ratio is capped at 1 / 1.5 / 2 / 2 per preset), one override per effect — shadows (off/low/medium/high), ambient occlusion (off/on/high), bloom, colour grade, anti-aliasing (off/FXAA/SMAA/MSAA), floor reflections, particles (low/medium/high), background (static/animated) and material detail (plain/detailed) — each defaulting to "From preset (…)", plus adaptive resolution (averages 90 frames; above 26 ms it steps the resolution down by 0.1 to 60%, below 14 ms back up by 0.05), a frame-rate readout, ball trails and camera. Choosing a preset clears the overrides. Changes apply live and are saved with the other settings (`settings.graphics`, migrated from the older single quality tier); a summary line "GPU · Level N · cost · W×H px" ("Level" localized) shows the GPU, its hardware level, the cost of the current choice and the drawing-buffer size, and if the post-processing chain cannot be built the arena renders without it and the panel says so. A change redraws the panel's controls once; the follow-up a moment later (pixel size, post-chain state) updates only the summary and note, so a click on the next control is never lost to a redraw. The post chain (EffectComposer: render → GTAO → bloom → grade → output → SMAA/FXAA, on a multisampled half-float target for MSAA) is only built when a setting needs it, so Low draws directly. The quality model is `js/render/gfx.js` (pure); post-processing, environment, mirror and bevel addons are vendored from the same three.js release as the core (r160) under `vendor/addons/`.

**Hardware-level detection.** `js/render/gpu-level.js` (shared StarHermit copy, `window.StarHermitGpu`, a classic script loaded before `js/main.js`, never edited here) rates the WebGL unmasked renderer plus device facts (`detectSystem()`: phone/tablet, cores, memory, screen) on the StarHermit hardware level 0–20 (0 = Galaxy S20 / Intel UHD or weaker, every software renderer and no WebGL; 20 = RTX 5090; each level ≈ 1.23×; laptop parts two levels below desktop; phones, tablets and ≤ 4 GB machines capped at 9). `js/render/gfx.js` maps it with `presetForLevel(level, { low: 0, balanced: 4, high: 10, ultra: 17 })`, so Auto picks Ultra on strong GPUs; adaptive resolution still steps down when slow. Headless SwiftShader is level 0 → Low. Phones and tablets pace Auto FPS at half the display refresh rate ("Auto (half refresh rate)") and start at 16 simultaneous sounds (shared `game-options.js`).

**Per-preset budgets** (`BUDGETS` / `budgetFor` / `sparkCap` / `moteCount` in `js/render/gfx.js`). Each preset holds 60 FPS on the weakest GPU Auto gives it — Low at level 0, Balanced 4, High 10, Ultra 17. Arena, paddles, ball, physics and hit areas are identical on every preset; only visuals change. Particle and mote counts are tuned at the floor level and scale up within the preset on faster GPUs (`StarHermitGpu.scaleBudget`, ≤ 2×, at most 7200 / 480).

| Budget | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Lit-surface shading | Lambert | Standard | clearcoated Physical (Detailed) | as High |
| Ball sphere segments | 16×12 | 24×18 | 32×24 | 48×32 |
| Rounded-bevel segments (rails, blockers; paddles +1; Detailed) | 1 | 2 | 2 | 3 |
| Floor-panel texture (Detailed) | 128 px | 256 px | 256 px | 512 px |
| Floor-mirror resolution (Floor reflections on) | ½ | ½ | ½ | full |
| Surround pillars (Detailed; Plain ×0.35) | 10 | 14 | 18 | 28 |
| Particle pool at Particles high (medium ½, low ⅙) | 600 | 1200 | 2400 | 3600 |
| Dust motes at Particles high (medium 70 %, low 40 %; Background animated) | 40 | 90 | 160 | 240 |
| Bloom / GTAO resolution | ½ | ½ | ½ | full |
| Frosted HUD pill and menu screens (backdrop blur) | no | no | yes | yes |

**Benchmark** (`node tools/gfx-bench.mjs paddle-pulse`; hook `tests/gfx-bench.mjs` picks the preset in Settings → Graphics, starts Journey stage 1 and keeps playing with the Serve button and the arrow keys, retrying from the results). Measured 2026-10-17 (GPU ms above the draws-skipped floor, projected to the preset's floor level; CPU p90 on the RTX 5090 run):

- Desktop 1920×1080: PASS low (typical 2.78 / slow 0.00 ms GPU, CPU 1.00 ms); PASS balanced (1.63 / 2.76, CPU 1.40); PASS high (2.01 / 1.23, CPU 1.90); PASS ultra (3.50 / 3.67, CPU 1.90).
- Mobile 390×844 @3×: PASS low (0.00 / 1.00, CPU 0.80); PASS balanced (0.28 / 0.24, CPU 1.10).

Tests: `tests/gfx.test.js` covers hardware level → preset (SwiftShader/llvmpipe/no WebGL, AMD Radeon Graphics and Intel UHD → Low, Iris Xe → Balanced, GTX 1070 → High, RTX 4080/5090 → Ultra, phones such as Adreno 740 capped at Balanced) and the per-preset budget table; the e2e checks "Level 0" in the Graphics summary; `tests/gfx-bench.mjs` is the dev-only benchmark hook.

### Camera and motion

- Choose orthographic or low-distortion perspective according to depth requirements; expose framing constants rather than magic offsets.
- Camera transitions use authored duration/easing or critically damped springs and remain interruptible. Never animate by cumulative per-frame lerp.
- Decorative motion is paused or reduced when hidden. Gameplay animation derives from simulation state and interpolation alpha, not frame count.
- Camera shake is low-amplitude, event-tiered, disabled by reduced motion, and never changes raycast truth.

### Graphics-skill routing

During implementation, begin with `threejs-skill-router` and load only the following retained skills because they materially affect this visual target:

- `threejs-camera-direction` for deliberate framing and input-safe camera transitions
- `threejs-procedural-geometry` for authored, inspectable meshes instead of primitive-only placeholders
- `threejs-procedural-materials` for coherent PBR surfaces, perceptual parameters, and readable state masks
- `threejs-procedural-animation` for deterministic motion phases, springs, and interruption-safe transitions
- `threejs-procedural-vfx` for bounded particles, trails, impact accents, and event hierarchy
- `threejs-exposure-color-grading` for tone mapping, adaptation limits, and accessible color separation
- `threejs-image-pipeline` for explicit depth/color ownership and pass ordering
- `threejs-visual-validation` for fixed-view captures, seed sweeps, and performance evidence
- `threejs-bloom` for selective HDR accents only; gameplay whites and UI do not feed bloom

Follow the skill pack's acceptance gate: deterministic seeds, debug views for controlling fields, perceptually grouped parameters, mechanism-backed quality tiers, and a readable no-post baseline. Do not add an effect merely because a skill exists.

### Performance budgets

- Target 60 fps at the default tier and a stable 30 fps fallback on constrained mobile hardware.
- Default active gameplay: ≤150 draw calls desktop, ≤90 mobile; ≤350k visible triangles desktop, ≤140k mobile; transient particles ≤20k desktop and ≤5k mobile.
- Cap device pixel ratio by quality tier; dynamically lower render scale before dropping simulation rate. UI text remains native resolution.
- Avoid runtime shader compilation during active play by prewarming required variants. Avoid per-frame allocations in simulation/render loops.
- Quality tiers independently control shadows, environment detail, particles, post effects, antialiasing, and render scale; they never alter rules or visibility of hazards.

## 5. Technical architecture

### Client modules

- `bootstrap`: host handshake, capability detection, asset manifest, lifecycle.
- `rules`: pure deterministic state transitions, legality, scoring, seeded random stream.
- `session`: local or hosted commands, snapshots, prediction policy, reconnect, replay.
- `render`: Three.js scene graph, semantic entity views, camera, lighting, VFX, post-processing (`render/scene.js`, `render/vfx.js`) and the graphics quality model (`render/gfx.js`).
- `ui`: responsive DOM shell, focus, localization, settings, overlays, accessibility mirror. Localization ships the nine platform locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT): UI strings in a keyed dictionary (`js/ui/i18n.js`, `t()`), authored content — lessons and their steps and hints, Journey stage titles, briefs and chapter names, Challenges, practice difficulties, daily cards, achievements — keyed by its US-English text (`js/ui/i18n-content.js`, `tc()`), plus results reasons, challenge constraint chips, palette names, control actions and audio captions. AI opponent names (Drift … Zenith) are proper names and stay as authored.
- Language: Settings → **Language → Game language** (the shared `game-options.js` section inside the Graphics group; reachable from the title and the pause menu) offers **Automatic — <resolved language>** plus the nine locales by native name, with a sync status line; it replaces the former in-game language select (an old explicit choice migrates once). Resolution (`sh-language.js`): explicit choice → for Automatic the StarHermit account's `preferredLanguage` (`GET /api/v1/me/language`, signed in only) → `navigator.languages` → en-US, mapping tags to the nearest shipped locale (`es-MX → es-419`, `en-AU → en-GB`, `fr → fr-FR`, `pt-PT → pt-BR`). The choice is stored per player in `localStorage['paddle-pulse.language.<user|guest>']` and, signed in, in the per-player settings key `ui.language` as `{ choice }`; a failed read never overwrites it and the game never writes the platform preference. `?lang=` forces a locale for the page load (QA) and hides the selector. A change re-renders every open screen in place (screen params are recomputed; the Graphics host keeps the shared sections and only its own `#gfx-box` is redrawn), the HUD, captions and the current match's title/brief, without restarting the match.
- `audio`: buses, event mapping, focus/background behavior, decode and memory policy.
- `content`: versioned levels, themes, tutorials, validation metadata.
- `platform` (`js/platform/host.js`): adapter over the shared StarHermit SDK (`starhermit-sdk.js`) — token, profile, cloud save, settings KV, controls, sign-in/invite, leaderboard posting (`submitScore`). It never calls the game's own server routes (`/api`, `/ws`); the device clock is authoritative.

No module may mutate rules state except through a validated command. Rendering consumes immutable snapshots plus interpolation data. UI state and simulation state are separate so closing a drawer cannot affect a match.

### Determinism, replay, and security

- Fixed simulation step where physics exists; quantize authoritative inputs and define stable collision/order rules.
- Use separate seeded random streams for rules, content decoration, and audiovisual variants. Cosmetic randomness never changes rules.
- Replay envelope: schema version, build/content version, seed, initial hash, timestamp offset, ordered commands, periodic state hashes, terminal result.
- Validate all network input for identity, session membership, turn/tick, bounds, rate, payload size, and legal action. Reject duplicates idempotently by command ID.
- Treat client clocks, scores, inventories, roles, physics outcomes, and completion claims as untrusted in competitive contexts.

### Loading and resilience

- Show useful progress by asset group; load core rules/UI first and scenic assets lazily. Provide procedural low-detail substitutes if optional assets fail.
- Cache immutable hashed assets and the last safe local snapshot. Updates activate between rounds, never during one.
- Recover WebGL context by rebuilding GPU resources from retained CPU descriptors. If 3D is unavailable, present a clear compatibility message and preserve account/session state.
- Background tabs reduce rendering to zero or a low heartbeat while preserving required network lifecycle.

## 6. StarHermit integration

### Packaging and launch
- The distribution ships `starhermit.txt` at its root (`name`, `description`, `launch=index.html`, `owner`, `server=score-script.js`, `version`, `cover`, and one `control.<action>=<codes> | <label>` line per keyboard action) and `starhermit-sdk.js`, an unmodified copy of the canonical StarHermit client loaded by `index.html` before `js/main.js`.
- All platform traffic goes through the SDK; `js/platform/host.js` adapts it. `StarHermit.init()` reads `#game_token=` (library launch) or `#access_token=` (direct sign-in return) once and strips it; the slug is the `game_scope` claim. Without a token no platform request is made.
- The SDK renews the launch token before expiry. If renewal is refused the player becomes a guest again (toast "signed out — playing locally"), sign-in is re-offered and play continues on localStorage.
- The client makes no own-server requests (no time sync, presence, activity or telemetry); the device clock sets the daily boundary. Without a launch token the game makes no network request beyond its static files.

### Identity, preferences, and progress
- **Sign-in:** on `*.starhermit.com` without a token the title and the profile screen show **Sign in for durable progress** (`StarHermit.signIn()`); hidden when signed in and when running locally.
- **Identity:** the profile nickname (fallback `Player ` + id prefix) replaces the local display name on the title card, and the profile screen shows it with the avatar.
- **Cloud save:** the `{settings, progress}` documents mirror to the `game:<slug>` slot through `StarHermit.loadJSON` / `writeSave` (~2 s debounce, pagehide flush, "Sync now" in Settings with a visible sync status); every write after the load is conditional on the version it saw. On load the cloud copy is merged, never adopted wholesale: progress through `storage.mergeProgress` (journey stars and wins, challenge clears, streak bests and totals take the larger value; dailies keep the first result per date; achievements keep the earliest unlock and larger progress; local and daily boards are unioned), tutorial completions are unioned, and the account's preferences apply. When another device saved first the SDK refuses the write and emits `saveconflict`: the game re-reads the slot, applies the same merge and saves again. localStorage remains the offline cache.
- **Report a problem:** Settings → **Report a problem** (signed in only, from the shared `game-options.js`) files a bug report through `StarHermit.reportBug` with a small non-personal `context.json` (viewport, language, FPS cap, audio limit); uncaught errors are filed as crash reports through `StarHermit.captureCrashes` (SDK-capped).
- **Settings KV:** audio, graphics, camera, accessibility, practice difficulty and profile privacy are patched to the per-player settings store on change and applied at boot (the account value wins).
- **Controls:** keyboard input routes by `KeyboardEvent.code` through `StarHermit.loadBindings()` (platform rebinds over the `control.*` defaults). Settings → Controls lists the effective keys; remapping a key there also stores it on the platform (`setControl`). Help shows the effective keys. Shared-screen player 2 uses `p2Left`/`p2Right`/`p2Serve`.
- **Invite:** signed in, the title and profile show **Invite a friend**, which copies `StarHermit.inviteLink()` to the clipboard and confirms with a toast.
- All new strings are in `js/ui/i18n.js` / `js/ui/i18n-content.js` for the nine locales; `tests/i18n.test.js` checks that every key used in code and every authored content string exists in all of them.

### Not used
- **Platform script:** `score-script.js` (canonical copy in the games repo's `tools/score-script.js`) is the deployed `server=` script: a practice session that accepts `{type:'result', scores}`, range-checks each score against its board and posts it. `server.js` is the local dev server only.
- **Leaderboard:** one board, `longest-rally` ("Longest rally": integer hits, higher is better, 0–10,000). Signed in, every finished Journey, Daily or Challenge match (won, lost or conceded) posts its longest rally through `platform.submitScore` → `StarHermit.submitScores`, and the results screen shows "Leaderboard rank: #N" (or "Score posted / not posted to the leaderboard."), localized in the nine locales (`results.lb*`). Practice, lessons, shared-screen 2P and standalone play post nothing.
- Achievements stay local. Multiplayer sessions, matchmaking, friends picker, session chat, replays, realtime rooms and voice are not used: the hosted-play lobby ships shared-screen 2P only and labels online rooms as unavailable.

## 7. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 8. Analytics and privacy

Measure tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage only in aggregate. Use random session identifiers, short retention, and explicit consent where required. Never collect message content, drawings, voice, private board notes, or exact pointer trails as analytics.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 9. Testing and acceptance criteria

### Rules and content

- Unit-test every legal action, invalid-action reason, scoring component, terminal state, and serialization migration.
- Property-test deterministic replay: the same version, seed, and commands produce identical state hashes.
- Fuzz malformed commands and generated content; prove no hangs, NaN physics, impossible mandatory states, or unbounded loops.
- Golden-test representative easy, medium, hard, interrupted, resumed, and terminal sessions.

### Interface and accessibility

- Test pointer, coarse touch, keyboard-only, gamepad, screen reader, zoom to 200%, reduced motion, high contrast, safe areas, and both mobile orientations.
- Verify focus restoration after every modal, meaningful live announcements, no keyboard traps, and no hover-only instructions.
- Confirm all critical labels fit translated strings at 30% expansion and support right-to-left layout where localized.

### Graphics and performance

- Produce fixed-camera captures for every quality tier, deterministic seed sweeps, no-post baselines, debug-view mosaics, and 10-minute temporal stability runs.
- Profile CPU, GPU, memory, shader compilation, draw calls, triangles, texture memory, and garbage collection on representative desktop and mobile classes.
- Verify effects cannot obscure legal targets, alter picking, leak resources, or continue expensive updates while hidden.

### Platform and network

- Test expired/rotated tokens, privacy settings, rate limits, offline start, reconnect at each game state, duplicate commands, out-of-order events, server restart, and version mismatch.
- Verify achievement idempotency, leaderboard validation, friends-only filtering, cloud-save conflict handling, activity start/end pairing, and server-time countdown accuracy.
- `tests/platform.test.js` covers the ETag-conditional cloud-save round trip, a 412 conflict reported for a merge, `mergeProgress` and sign-in on a UUID host. The browser e2e ends with a language step against a stubbed StarHermit API: the account's preferred `fr-CA` makes Automatic resolve to French (Canada) (title, Journey chapter and stage in French); switching to Deutsch mid-match re-renders settings, pause and HUD in place with the shared sections intact, PUTs `ui.language`, keeps the HUD buttons clear at 390 px, and Report a problem posts to `/reports`.
- For hosted sessions, test disconnect/rejoin, abandonment, timeout, invitation expiry, result reconciliation, replay access, moderation controls, and authoritative cheat attempts.

## 10. Definition of done and non-goals

This specification is ready for implementation when rules examples, content schema, wireframes for all responsive breakpoints, visual target frames, accessibility annotations, authoritative message schema, achievement definitions, leaderboard definitions, and performance test devices are approved.

This document does **not** authorize implementation, asset production, monetization work, native wrappers, real-money systems, or copying any existing product. The initial build should favor one excellent core loop and a coherent original visual identity over feature breadth.

## Browser interference

`browser-guard.js` (loaded from `index.html`) suppresses browser UI that gets in the way of play: the right-click context menu, the iOS long-press callout, copy / cut / paste, and page text selection. Text fields (inputs, textareas, selects, contenteditable) keep normal selection, context menu and clipboard behaviour.


## Sound and frame-rate options

The options panel includes Sound controls for master, music, effects and UI volume, a mute that preserves volume levels, and an Auto or manual concurrent-sound limit (1–64). Changes apply immediately with perceptual volume curves. A shared allocator bounds Web Audio and media playback, including loops and scheduled sources. Graphics includes Auto display refresh or a custom maximum frame rate from 1–1000 FPS; rendering is paced independently of simulation and input. Preferences persist locally, with FPS stored per detected GPU, and reconcile with Starhermit settings when signed in. The controls support keyboard and touch input and the supported English, Spanish, German, French, Portuguese and Italian locales.
