# Paddle Pulse — Product and Game Specification

**Document status:** running specification; the game runs on the StarHermit engine 1.29.0 (host API 1.31, `engine.minor=31`).  
**Game index:** 90  
**Genre:** Realtime paddle sport  
**Players:** 2–32 players as specified by playlist  
**Targets:** the StarHermit client (native) and desktop / mobile browsers (the engine's web runtime), landscape and portrait  
**Rendering:** `starhermit:scene` (the three.js-style scene) with the HUD and screens on `starhermit:ui` (an accessible immediate-mode UI)

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

The 3D arena fills the window but is never the only UI. Menus, text, forms, settings, the HUD and assistive descriptions are `starhermit:ui` widgets over it (screen readers read their accessibility tree; live announcements cover objective, score, errors and results).

### Responsive layouts

The runtime's UI is laid out each frame from the window's logical size (`native/screens.ts`), replacing the old media queries:

- **Wide desktop (≥ 1024 logical px):** the score pill top centre; the objective rail (objective + sub-line) vertically centred at the left, the Serve / Pause rail at the right; screens are centred panels (680 px, 920 px for Journey, Settings and Help).
- **Compact (< 1024 px):** both rails sit 76 px above the bottom edge (objective left, buttons right).
- **Portrait phone (≤ 700 px wide, taller than 500 px):** the objective rail above a full-width thumb tray (Serve and Pause, 52 px tall, on a dark gradient); screens are bottom sheets; captions sit under the score pill and toasts move to the top while a sheet is open so they never cover its buttons.
- **Short landscape (≤ 500 px tall):** a slimmer score pill and narrow side rails; the title uses the smaller logo and wraps its cards and buttons so it fits without scrolling to Play.
- Screens taller than the window scroll inside their panel and open at the top. A screen opened over another (setup over the Journey map, settings over pause) uses a darker wash.
- Left-handed controls swap the two rails (and the tray's buttons).
- Interface size, text size, high contrast and reduced motion are the runtime's Options (F1); every layout follows them (`ui.preferences().scale`, `ui.measureText`).

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

- Full keyboard operation and visible focus; UI widgets for every arena control (Serve, Pause, the lesson and match texts); headings and live regions for objective, turn, score, errors, and results.
- Color is reinforced by shape, texture, icon, or label. Include contrast-safe and common color-vision palettes.
- Reduced-motion mode removes camera swoops, shake, parallax, rapid particles, and large scaling while preserving event timing.
- Independent sliders for music, effects, ambience, and voice; captions/text cues for meaningful audio; no audio-only gameplay.
- Options for larger text, high contrast, left-handed controls, hold-versus-toggle, timing assistance, haptics off, and tutorial replay.
- Announce Three.js board state through a concise navigable model rather than describing every decorative object.

### Controls (engine runtime)

Actions are declared in `starhermit.txt` (`control.*`, `engine.gamepad.*`) and rebound by the player in the runtime's Options (Settings › Controls lists each action's key and its Change button opens the rebind prompt):

| Action | Keys | Gamepad |
|---|---|---|
| `left` / `right` — move the paddle | ← / → | left stick, D-pad |
| `serve` | Space | A (South) |
| `pause` — pause / back on screens | Escape | Start |
| `undo` (practice, lessons) | U | Y (North) |
| `camera` — broadcast ↔ behind paddle | C | RB |
| `hint` | H | X (West) |
| `p2left` / `p2right` / `p2serve` (shared-screen 2P) | A / D / W | — |

- Held keys run the paddle's target at the paddle speed and send a move when it is a quarter unit off (the browser build's `pollInputs`); a stick's value scales that speed (the browser build mapped the stick's x to an absolute position; actions make it rebindable). Left-handed controls flip the direction.
- Pointer and touch: a press on the arena (not on the HUD) steers the paddle to the pointer's x on the paddle plane while held; releasing serves when the player holds the serve (in lessons only where serving is part of the lesson). The HUD's Serve and Pause buttons work with pointer, touch, keys and pads.
- Arrow presses during play clear UI focus so they never walk the HUD buttons.
- The browser build's action names `p2Left` / `p2Right` / `p2Serve` are lowercase now (`p2left` …): account rebinds of those three do not carry over.

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

The arena is drawn on `starhermit:scene` (`native/render.ts`, a port of the browser build's three.js r160 `js/render/scene.js` and `vfx.js`): a hemisphere fill, a soft accent ambient and one key directional light (intensities ÷ π, the engine's convention) whose shadow reaches over the play area; ACES filmic tone mapping (exposure 1.12); the fog range follows the camera's framing distance. The detailed look gives the PBR materials the room environment (`PMREMGenerator.fromScene(new RoomEnvironment(renderer))`, each material its own `envMap` with the old intensity, since at minor 20 `scene.environment` ignores per-material intensity), clear-coated physical paddles, rails, blockers and ball with rounded bevels, the seeded brushed-panel floor running out into the fog (baked once into `assets/textures/floor-<theme>-<256|512>.png` by `tools/bake-floor.mjs`, the old per-pixel canvas code run in node), HDR neon tubes along the rails and paddle edges, light strips on the surround pillars, and soft contact blobs under ball and paddles when shadow maps are off. Floor reflections are a planar mirror: the scene drawn each frame from the camera mirrored in the floor into a render target (half or full window resolution, at most 1600 px), shown under the semi-transparent floor by a small WGSL material (three's Reflector overlay blend). Post effects are the runtime's: `renderer.ao` (GTAO), `renderer.bloom` (threshold 0.88, strength 0.62 × the theme's), `renderer.grade` (linear: S-curve 0.22, saturation 1.12, cool shadows, 0.28 vignette) and `renderer.antialias`. The animated background shimmers the pillar strips, breathes the grid and drifts dust motes; it and the menu backdrop (the arena behind the title screens with a cosmetic rally and a slow camera orbit) freeze under reduced motion.

The **graphics level** is the runtime's (Options › Graphics: Auto from the device, or one of ten levels; render scale, pixel-ratio cap, adaptive resolution, the frame-rate limit and readout are the runtime's too). `native/quality.ts` maps the level's quality tier to the browser build's presets and budgets (`js/render/gfx.js` TABLE / BUDGETS, removed):

| Tier | Shadows | AO | Bloom / grade | AA | Reflections | Particles | Background | Look |
|---|---|---|---|---|---|---|---|---|
| Low | off | off | off | off | off | low | static | plain (Lambert) |
| Balanced | 512 | off | on | FXAA | off | medium | animated | detailed (Standard) |
| High | 1024 | on | on | SMAA | on (½ res) | high | animated | detailed (clear-coated Physical) |
| Ultra | 2048 | high | on | MSAA | on (full res) | high | animated | detailed (Physical) |

Per-tier budgets as before: ball segments 16×12 / 24×18 / 32×24 / 48×32, bevel segments 1 / 2 / 2 / 3, floor texture 256 / 256 / 512 px, surround pillars 10 / 14 / 18 / 28 (plain ×0.35), particle pool 600 / 1200 / 2400 / 3600 at Particles high (medium ½, low ⅙), dust motes 40 / 90 / 160 / 240, bloom and AO at half resolution below Ultra. Pool and motes grow with the level above the tier's first (≤ 2×). Arena, paddles, ball, physics and hit areas are identical on every level. The browser build's per-effect overrides (Settings › Graphics) are not offered: the runtime's Options choose a level. Ball trails and the camera view stay in the game's Settings.

### Audio (engine runtime)

`native/audio.ts`: the authored one-shots (`sfx/*.opus`) per logical event (paddle hit, wall, bumper, serve, serve ready, goal, match end, rejected action, countdown tick and go, UI click / back / open / error / unlock / star, undo) on the runtime's effects and interface buses, loaded one at a time once the mixer runs (in a browser after the first press). The theme's ambience (a sine an octave below the root and a slightly sharp triangle, swelling at 0.07 Hz) and the adaptive music (96 bpm: sine bass on the root each bar, triangle fifth pad every second bar, a square arpeggio on the theme's seeded pentatonic walk; the bass level and the arpeggio follow the ball's speed) are rendered per theme into 16-bar clips and looped on the music bus (the runtime has no ambience bus). Captions show `[serve]`, `[goal for you]`, `[goal conceded]`, `[victory]`, `[defeat]`, `[action not allowed]`, the countdown numbers and `[go]` in the game language (Settings › Captions). Volumes, mute-all of the runtime and the voice limit are the runtime's Options; Settings › Mute all silences the game's own sounds.

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

The game is a StarHermit engine script game (`engine.entry=native/main.ts`, engine 1.29.0, `engine.minor=31`), played natively by the StarHermit client and in browsers by the engine's web runtime from the loader `index.html` (written by `npm run package`).

- `js/rules/*.js` (pure, unchanged in what they decide): the deterministic 120 Hz rules (`engine.js`: commands, physics, scoring, terminal reasons, state hash, replay envelope and verifier), seeded streams (`rng.js`), canonical hashing (`hash.js`).
- `js/session/*.js`: the session (`match.js`: command intake with dedupe, AI seats, undo snapshots, interpolation data, resume snapshots), the AI (`ai.js`), the versioned, checksummed documents with settings/progress migration and merge (`storage.js`, on a pluggable backend).
- `js/content/*.js`: Journey, Challenges, practice difficulties, lessons and their step checks, the Daily, themes and colour-vision palettes, achievements, offline validators.
- `js/ui/i18n.js`, `i18n-content.js`, `i18n-native.js`: the string tables (keyed UI strings, content keyed by its US-English text, the engine client's own strings) in the nine locales.
- `js/migrate.js`: reading the browser build's cloud save and account settings.
- `native/main.ts`: the flow, input into commands, lessons, results, progress, the resume snapshot, the lifecycle, the fixed-step clock. `native/screens.ts`: the HUD, screens, toasts and captions on `starhermit:ui`. `native/render.ts`: the arena on `starhermit:scene`. `native/audio.ts`: sounds and music on `starhermit:audio`. `native/platform.ts`: saves, settings, the player, the clock, leaderboards. `native/quality.ts`, `native/style.ts`, `native/i18n.ts`, `native/game.ts` (typed facade over the js modules).
- Localization: the runtime's interface language (Options › Language: the player's choice, else the account's preferred language, else the device's) picks the nearest shipped locale (es-MX → es-419, en-AU → en-GB, fr → fr-FR, pt-PT → pt-BR); everything is drawn through `t()` / `tc()` each frame, so a change shows on the next frame without touching the match. The browser build's Language section (`sh-language.js`) and `?lang=` are gone. AI opponent names (Drift … Zenith) stay as authored.

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
- `starhermit.txt`: name, description, owner, `server=score-script.js`, version, cover, `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.29.0`, `engine.minor=31`, `engine.capabilities=platform,storage,clipboard`, the controls and gamepad defaults. `npm run package` (`starhermit package --web .`) writes the loader `index.html` and `starhermit-files.json`; run it after every change. `.starhermitignore` leaves out tests/, tools/, spec, licence, cover art and the sfx manifests.
- No game code reads tokens or calls the game's own routes; the runtime owns sign-in, token renewal and the platform's endpoints.

### Identity, preferences, and progress
- **Player:** `player()` signed in or a guest; the title card and profile show the account's display name (else the local display name, editable in Profile as before) and the avatar. Guests see **Sign in for durable progress** (the runtime's sign-in); signed in, **Invite a friend** copies the invite link (fetched ahead) to the clipboard with a toast. Signing out mid-session shows "Signed out — playing locally."
- **Save:** progress (`js/session/storage.js` documents, `native/platform.ts` backend) is the engine save (`starhermit:storage saves`): on the device at once, in the account's cloud slot debounced by the runtime. A conflict merges with `storage.mergeProgress` (the browser build's saveconflict merge: Journey stars and wins, challenge clears, streak bests and totals take the larger value, dailies keep the first result per date, achievements the earliest unlock and larger progress, boards unioned); the account's copy replacing the device's (another device saved later) is merged in too, with a "Cloud save synced." toast. Settings › Data shows the sync state and **Sync cloud save** flushes it.
- **The browser build's cloud save** (`game:<slug>`, `{ settings, progress }` as JSON from the JS SDK) shows as foreign: its progress is merged into this device's, its tutorial completions unioned, its display name taken when this device still says Guest and its game options adopted when this device has none, then it is replaced once (`replaceForeign`).
- **Game options** (mute, captions, ball trails, camera view, colour palette, left-handed, timing assist, haptics, practice difficulty, hidden profile, the guest's display name, lessons done) are one synced game setting (`prefs`). The browser build's account settings KV (audio, graphics, camera, accessibility, solo, privacy, `ui.language`, `audio.options`) is adopted once when this device has no options yet and then removed. Volumes, graphics, language, reduced motion, high contrast and text size are the runtime's Options.
- **Report a problem** (Settings › Data, signed in): a description sent with `reportBug` and a small non-personal context (window size, language, graphics level, phase, mode).
- **Resume snapshot:** pausing (and a hidden window, which pauses solo play) keeps a snapshot of the match on the device (storage KV); the next start offers **Resume match** / **Discard** over the title.
- **Clock:** the Daily's UTC date and the next-daily countdown use the platform's clock (`serverNow`), else the device's.

### Leaderboard and results
- `score-script.js` (unchanged, `server=`) is the platform script: a practice session that accepts `{ type: 'result', scores }`, range-checks each score against its board and posts it. Signed in, every finished Journey, Daily or Challenge match (won, lost or conceded) posts its longest rally to `longest-rally` ("Longest rally": integer hits, higher is better, 0–10,000) and the results show "Leaderboard rank: #N" (or posted / not posted). Practice, lessons and shared-screen 2P post nothing; guests post nothing. The Leaderboards screen reads the board's top 10 (guests too).
- Achievements, the local wins board and the local daily board stay local, as before (no platform achievements).
- **Hosted play** is shared-screen 2P only (the lobby says online rooms are not part of this build); it is not recorded anywhere, so no server referee is needed.

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
- For hosted sessions, test disconnect/rejoin, abandonment, timeout, invitation expiry, result reconciliation, replay access, moderation controls, and authoritative cheat attempts.

### Engine checks

`npm test` runs the unit tests (`node --test`: rules, replay, fuzz, content, i18n coverage of `native/*.ts` and every locale, saves and migration) and `tests/native.mjs`: the web index matches the files, `tsc` (no skipLibCheck), `starhermit check .` with no warnings, then every `tests/native/*.play` script as a signed-out render check through the real UI:
- `journey-1.play` (generated by `tools/gen-plays.mjs` from the rules and session: a bot whose key holds are timed in fixed steps wins Journey stage 1, the results show Victory, the score, three stars and the longest rally, Verify replay confirms it, Next opens stage 2 and the map shows the stage cleared);
- `lessons.play` (Move with ← then →, Serve with Space, both marked done);
- `menus.play` (every screen; settings changed and back; a display name typed and saved);
- `practice-actions.play` (hint, camera, undo, serve, pause, resume, restart, leave; the Daily started and left);
- `practice-phone.play` (390×844 at DPR 3: taps, a drag on the arena, the tray, pause, restart, leave);
- `landscape-2p.play` (844×390 at DPR 3: shared-screen 2P with player 2's keys, settings over pause).

`npm run test:browser` (`tools/browser-play.mjs`) serves the package on loopback and plays it in Chrome on the GPU (`~/games/tools/gpu-chrome.mjs`) at desktop, phone and landscape (DPR 3): practice with keys or a drag and taps, pause, leave, then the Move lesson to its results; it fails on console errors or warnings.

## 10. Definition of done and non-goals

This specification is ready for implementation when rules examples, content schema, wireframes for all responsive breakpoints, visual target frames, accessibility annotations, authoritative message schema, achievement definitions, leaderboard definitions, and performance test devices are approved.

This document does **not** authorize implementation, asset production, monetization work, native wrappers, real-money systems, or copying any existing product. The initial build should favor one excellent core loop and a coherent original visual identity over feature breadth.

## Port differences and known limitations

- The browser build's Settings › Graphics panel (preset, render scale, per-effect overrides, adaptive resolution, FPS readout), Language section and sound sliders are the runtime's Options now; the game's Settings keep its own options and an **Options…** button. Uncaught errors show the runtime's error screen (the SDK's crash reports are gone).
- The Move lesson now counts a held key's whole move from where the paddle was when the key went down (the browser build compared each quarter-unit step against the half-unit requirement, so only a drag could pass it).
- Dead spark particles are hidden (the browser build left them standing where they died).
- The gamepad stick drives the paddle through the `left` / `right` actions (speed by the stick's value) instead of mapping its x to an absolute position.
- The shared-screen second player's keys move the paddle while held (the browser build stepped two units per key-repeat).
- The Hosted Play mode card says Unranked (the browser build's "Ranked when hosted" chip promised a recording that never existed).
- The resume snapshot and progress are not shared with the browser build's localStorage: guests' old browser progress cannot migrate (signed-in players' cloud saves do).
- Pre-existing rules behaviour kept as is (replays and the validators depend on it): the time-limit tiebreak's last step uses the session id, and practice / shared-screen seeds come from the device clock.
