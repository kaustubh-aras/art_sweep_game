# Clockshot — Architecture, Design Notes & Growth Plan

> **What this document is.** A complete description of the game as it exists in
> this repository today, followed by concrete, prioritised advice on improving
> and scaling it. Written from a full source read, a module-reachability trace
> from both entrypoints, a clean `npm run typecheck`, and a passing test suite
> (now 98 tests), then verified by playing the game locally.
>
> **A simplification pass has since been applied** — see
> [§16 The simplification pass](#16--the-simplification-pass) for what changed
> and why. Defects 1, 3, 8 and 9 below are **fixed**; the rest are open.
>
> Companion documents: [`README.md`](README.md) is the player/judge-facing pitch.
> [`SWEEP_GDD.md`](SWEEP_GDD.md) describes a **different, abandoned game** — see
> [§9 Repository Archaeology](#9--repository-archaeology).

---

## Table of contents

1. [The game in one page](#1--the-game-in-one-page)
2. [Design pillars](#2--design-pillars)
3. [System architecture](#3--system-architecture)
4. [The client](#4--the-client)
5. [The server](#5--the-server)
6. [The trust model](#6--the-trust-model)
7. [Data model (Redis)](#7--data-model-redis)
8. [Build, test & deploy](#8--build-test--deploy)
9. [Repository archaeology](#9--repository-archaeology)
10. [Known defects](#10--known-defects)
11. [Improvement plan](#11--improvement-plan)
12. [Scaling up](#12--scaling-up)
13. [Feature roadmap](#13--feature-roadmap)
14. [Appendix: file map](#14--appendix-file-map)
15. [Appendix: running it locally](#15--appendix-running-it-locally)
16. [The simplification pass](#16--the-simplification-pass)

---

## 1 · The game in one page

**Clockshot** is a Reddit [Devvit Web](https://developers.reddit.com/docs) game
built with Phaser 3. It runs inside a Reddit post's web view; every subreddit
that installs it gets its own persistent instance.

**The loop.**

1. A player opens the post and presses **PLAY**. No sign-up, no side to pick.
2. They take a **30-second run** through a single hand-authored arena, swinging
   on a grapple past patrolling enemies and collecting clock fragments.
3. At the end they are asked **"who gets these seconds?"** — Red or Blue. Their
   run is banked into that team's shared clock for the whole subreddit.
4. Whichever team is ahead when the **10-minute community round** ends wins it —
   for everyone, whether or not they were online.

The team choice comes *after* the first run on purpose: it turns a commitment
demanded of a stranger into a reward handed to someone who has just earned
something. From the second run onward the side is remembered.

**Three clocks run at once**, and that layering *is* the theme interpretation:

| Clock | Length | Owner | Constant |
|---|---|---|---|
| Your run | 30 s | you | `RUN_MS` |
| The community round | 10 min | the subreddit | `ROUND_MS` |
| Each team's bank | grows & shrinks | the team | `STARTING_BANK` = 60 |

Time is **currency, not pressure**. A clock fragment does not award points — it
moves seconds out of the arena and into a bank other people can see. **Enemy
fragments take seconds *off* the other team** rather than adding them to yours,
so time is conserved and contested rather than merely accumulated.

**Scoring** ([`src/shared/config.ts`](src/shared/config.ts), re-derived
server-side on every submit):

| Action | Value | Effect |
|---|---|---|
| Clock fragment | +1 s | your bank |
| Golden clock | +5 s | your bank |
| **Enemy fragment** | **−2 s** | **the other team's bank** |
| Hazard hit | — | knockback and lost time only |
| Fall | — | respawn and lost time only |

**Whatever you collect, you keep.** Hazards and falls cost the run's scarcest
resource — the clock — through knockback, i-frames and a ruined line; they do
not take banked seconds away. Charging both is what let a beginner finish a
whole run on zero, which is the worst thing a thirty-second game can say to
someone on their first try. A run is capped at 150 s; stolen seconds at 60 s.

---

## 2 · Design pillars

These are the decisions the code actually defends. They are worth preserving
through any refactor.

### 2.1 Asynchronous presence

Players never need to be online at the same time. A run you take now changes
what the next person sees when they open the post. The activity feed
(`"u/name added 18 seconds to Red Team"`, `"Blue Team has taken the lead"`)
turns a solitary 30 seconds into a visible contribution.

### 2.2 Rounds are derived, never scheduled

`roundIndexAt(now) = Math.floor(now / ROUND_MS)`. The round a request belongs to
is a **pure function of when it arrived**. There is no cron job, no round-start
record, and therefore nothing to get stuck, race, or need repair. Round-scoped
Redis keys carry the index, so a new round starts from clean state without
anything having to delete the old one — old keys simply expire.

### 2.3 Banks are stored as deltas

`K.banks(index)` holds the **delta from `STARTING_BANK`**, not the bank itself.
This means a round needs no initialisation step, so there is no race between the
first two players to arrive at a fresh round. `hIncrBy` on a missing field
starts from zero, which is exactly right.

### 2.4 Nothing loads over the network

Every sprite is drawn into an offscreen canvas at boot
([`textures.ts`](src/clockshot/textures.ts)); every sound is synthesised with the
Web Audio API ([`sfx.ts`](src/clockshot/sfx.ts)). There is **no image, audio,
font, or level file** to be slow, blocked, or 404 inside a Reddit web view.
`vite.config.ts` sets `publicDir: false` so nothing orphaned is uploaded.

### 2.5 The interface never zooms

`PlayScene` runs **two cameras**. The world camera zooms
(`clamp(min(w/520, h/900), 1, 2.2)`) so the arena reads at the same physical
size on every device; the UI camera does not, because a thumb is the same size
whatever the screen. Each camera is told to ignore the other's objects.

### 2.6 The canvas owns its own size

Phaser runs in `Scale.NONE`. [`src/ui/viewport.ts`](src/ui/viewport.ts) sizes the
backing store at the device pixel ratio (capped at 2) while pinning the canvas
CSS box to exactly its container, so the page can never produce a scrollbar
inside the Reddit post. Safe-area insets are read from a zero-size CSS probe
element (`#safe-probe`) — the only way to get `env(safe-area-inset-*)` into
JavaScript.

### 2.7 Time is never taken from the device

Every server response carries `now`. `Store.syncClock()` keeps the offset, and
`store.serverNow()` answers every "how long is left" question. A player whose
device clock is wrong by hours still sees the correct round timer, and
backgrounding a tab can neither pause nor extend a run.

---

## 3 · System architecture

```
┌──────────────────────── Reddit post (web view) ────────────────────────┐
│                                                                        │
│   index.html  ──splash──▶  src/main.ts                                 │
│                              │                                         │
│                              ├─ initViewport()   canvas sizing / DPR   │
│                              ├─ sfx.unlock()     gesture-gated audio   │
│                              └─ new Phaser.Game(gameConfig)            │
│                                                                        │
│   ┌─────────────────── Scenes (10) ────────────────────┐               │
│   │ cs-boot → cs-menu → cs-team → cs-play → cs-results │               │
│   │            ├─ cs-howto   ├─ cs-dash                │               │
│   │            └─ cs-leaderboard  cs-pause  cs-error   │               │
│   └────────────────────────────────────────────────────┘               │
│                              │                                         │
│                     store (client world view)                          │
│                              │                                         │
│                        net.ts  (fetch + NetError + withRetry)          │
└──────────────────────────────┼─────────────────────────────────────────┘
                               │  JSON over /api/*
┌──────────────────────────────▼─────────────────────────────────────────┐
│                     Devvit server (dist/server/index.cjs)              │
│                                                                        │
│   src/server/index.ts     router, identity from context, error shaping │
│   src/server/runs.ts      run lifecycle, validation, scoring, limits   │
│   src/server/community.ts banks, leaderboard, activity feed, rounds    │
│   src/server/keys.ts      every Redis key in one place                 │
│                              │                                         │
│                        Devvit Redis (per-installation)                 │
└────────────────────────────────────────────────────────────────────────┘

              src/shared/  ← the only code both halves import
              ├─ config.ts   tuning constants + round maths + Team
              └─ api.ts      the complete wire contract
```

**The `shared/` boundary is the most valuable structural property of this
codebase.** Both halves import the same `SCORE` table and the same round maths,
but the server treats the client's arithmetic as advisory and recomputes
everything. Keep this. Do not let gameplay logic leak into `shared/`, and do not
let the client import from `server/`.

---

## 4 · The client

### 4.1 Scene flow

| Key | File | Role |
|---|---|---|
| `cs-boot` | `BootScene.ts` | Bakes textures and fetches state behind a live clock animation. Falls through to `cs-error` on failure. |
| `cs-menu` | `MenuScene.ts` | The headline is *the shared battle*, not the game's name. Polls state every 12 s. Gates `PLAY` on having a team. |
| `cs-team` | `TeamScene.ts` | Side selection. States the lock-in rule up front. |
| `cs-howto` | `HowToScene.ts` | Three pages: swing, time-is-score, it-goes-somewhere-shared. Renders real game textures as examples. |
| `cs-play` | `PlayScene.ts` | The 30-second run. Two cameras, server-driven clock. |
| `cs-pause` | `PauseScene.ts` | Overlay. Says plainly that the run clock keeps going. |
| `cs-results` | `ResultsScene.ts` | **Where the run is actually banked.** Retries, explains failures, offers share text. |
| `cs-dash` | `DashboardScene.ts` | Community battle view. Polls every 8 s. |
| `cs-leaderboard` | `LeaderboardScene.ts` | Player + team boards for the round. |
| `cs-error` | `ErrorScene.ts` | Reconnect screen. Retries by refetching, not by restarting into the same failure. |

Every scene follows the same discipline: build objects once in `create()`,
reposition in `relayout()` on `Scale.RESIZE`, and unsubscribe everything in a
`SHUTDOWN` handler. **Follow this pattern for any new scene** — it is the reason
this codebase has no listener or timer leaks.

### 4.2 Movement & the grapple ([`player.ts`](src/clockshot/player.ts))

The grapple is a **position-based constraint, not a simulated rope**. Each frame,
after Phaser integrates gravity:

1. The rope shortens by `reelSpeed * dt` (so a swing climbs instead of decaying).
2. Tangential input pumps the pendulum, the way you drive a playground swing.
3. If the player is outside the rope circle, they are snapped back onto it and
   the **outward component of velocity is removed**.

What remains is tangential — a pendulum. It is cheap, unconditionally stable at
any frame rate, and above all **repeatable**, which matters more than realism in
a thirty-second run.

Supporting game-feel details already implemented: coyote time (110 ms), jump
buffering (130 ms), variable jump height, air/ground acceleration split, ground-
only speed cap (so swing momentum survives a landing), i-frames with a blink,
and release boost.

### 4.3 Input ([`controls.ts`](src/clockshot/controls.ts))

Touch pads are **hit-tested against every active pointer each frame** rather than
wired to per-object input events. This is what makes "hold left, hold grapple,
tap fire" work simultaneously — with object events, a second finger landing on a
second button is easy to lose. Hit boxes are the visible circle × 1.22.

`activePointers: 5` in the game config; pad radii are in design pixels and
multiplied by `L.ui` (which folds in the DPR) so a 44 px target is 44 **CSS**
pixels on a 3× phone.

### 4.4 Networking ([`net.ts`](src/clockshot/net.ts))

Every call resolves to a typed success or throws a `NetError` carrying a message
worth showing a player. Callers never see a raw fetch rejection, an HTML error
page, or an unparsed body. 10-second timeout via `AbortController`.
`withRetry()` (3 attempts, exponential backoff) is used for the one call whose
failure actually costs the player something: banking a run.

### 4.5 Arena ([`arena.ts`](src/clockshot/arena.ts))

The arena is **data, not scene code**. Static geometry (14 platforms, 19
anchors, 5 hazard strips, 3 respawns) never changes, so players learn it.
Pickups and patrols are chosen by a **seeded PRNG** whose seed comes from the
server, so repeated runs ask a slightly different question and a mid-run refresh
rebuilds the identical arena.

---

## 5 · The server

Four files, ~1,000 lines, and the design is genuinely good.

### 5.1 Run lifecycle

```
POST /api/run/start
  ├─ identity from context (not the body)
  ├─ team must exist          → 400 no_team
  ├─ cooldown must be clear   → 429 rate_limited
  ├─ existing in-flight run?  → return it (resumed), keeping its ORIGINAL start
  └─ else mint {runId, startedAt: server now, roundIndex, team, seed}, TTL'd

POST /api/run/finish
  ├─ run must be the player's current in-flight run  → 409 run_duplicate
  ├─ validateTiming() against the SERVER clock       → 409 run_expired / round_changed
  ├─ claimRun(): redis.set(nx) — the atomic gate     → 409 run_duplicate
  ├─ sanitizeTally(): type-check + cap every count
  ├─ scoreRun(): the ONLY place counts become seconds
  ├─ addToBank(own, +awarded) / addToBank(foe, −stolen)  — hIncrBy, atomic
  ├─ addContribution(), pushActivity(), noteLeadChange()
  └─ 200 with the fresh community state folded in
```

Returning an existing run rather than refusing it is deliberate: a player who
refreshes mid-run gets their run back instead of being locked out, and it still
holds the "one active run per player" line, because the returned run keeps its
original server start time and **cannot be extended by asking again**.

### 5.2 Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/state` | Menu + dashboard in one call. Works logged-out (watch, don't play). |
| `POST` | `/api/team` | Locks once the player has contributed this round. |
| `POST` | `/api/run/start` | |
| `POST` | `/api/run/finish` | |
| `GET` | `/api/leaderboard` | Players + team totals. |
| `GET` | `/api/activity` | **Currently has no client caller.** |
| `POST` | `/internal/menu/create-post` | Moderator menu item. |
| `POST` | `/internal/on-app-install` | Creates the first post automatically. |

Errors are a closed union of nine codes (`ErrorResponse['code']`) so the client
can *act* on a failure rather than just display it — `net.ts` uses this to decide
what is retryable, and `ResultsScene` uses it to decide whether a failure is
permanent.

---

## 6 · The trust model

This is worth stating explicitly because it is the part most likely to be
weakened by a careless change.

**Rule 1 — identity comes from `context`, never from the request body.** A client
cannot claim to be someone else because it is never asked who it is.
`currentPlayer()` reads `context.userId` / `context.username` and nothing else.

**Rule 2 — the client reports *what it did*, never *what it earned*.** The wire
carries a `RunTally` of raw counts. `scoreRun()` is the only place counts become
seconds.

**Rule 3 — the server owns the clock.** `validateTiming()` measures against the
server's `Date.now()`. A client timestamp is never read. Grace is
`RUN_GRACE_EARLY_MS` (1.2 s, for latency) and `RUN_GRACE_LATE_MS` (15 s, for a
backgrounded tab resuming).

**Rule 4 — every count is capped.** `RUN_CAPS` ceilings are generous by design:
they exist to make an impossible score impossible, not to police a good one.
`capped()` deliberately rejects `Number()` coercion, because `Number([3]) === 3`
and `Number(true) === 1` and both shapes can arrive through JSON.

**Rule 5 — a run can only be banked once.** `redis.set(key, v, {nx: true})` is
the atomic gate. Of two requests carrying the same run id, only one can create
the key, so a retry, a double-tap, or a replay can never be counted twice. The
`nx`-refused case resolves to the empty string (the protobuf default) — the
`FakeRedis` in `tests/` reproduces this exactly, which is what stops the tests
agreeing with a bug.

**Rule 6 — adjustments are disclosed.** When the server clamps a claim it sets
`adjusted: true`, and the results screen says *"banked (score adjusted by the
server)"*. Being open about a correction beats silently changing someone's score.

---

## 7 · Data model (Redis)

All keys live in [`src/server/keys.ts`](src/server/keys.ts). Devvit scopes Redis
per app installation, so names only need to be unique within one subreddit's copy.

| Key | Type | Contents | Lifetime |
|---|---|---|---|
| `r:{i}:banks` | hash | `red`/`blue` → **delta** from `STARTING_BANK` | `3 × ROUND_MS` |
| `r:{i}:players` | zset | username → seconds contributed | `3 × ROUND_MS` |
| `r:{i}:pteams` | hash | username → team (for row colour) | `3 × ROUND_MS` |
| `r:{i}:activity` | zset | JSON item → timestamp, trimmed to 30 | `3 × ROUND_MS` |
| `r:{i}:meta` | hash | last known leader | `3 × ROUND_MS` |
| `p:{uid}:team` | string | team choice — **deliberately not round-scoped** | forever |
| `p:{uid}:run` | hash | the in-flight run | ~46 s |
| `run:{id}:done` | string | replay guard | ~5.75 min |
| `p:{uid}:last` | string | last finish, for cooldown | 12 s |

The activity feed is a **sorted set scored by timestamp, not a list**, because
the Devvit Redis client offers no list operations. Members must stay unique, so
each item carries an id — two players scoring the same amount in the same
millisecond would otherwise collapse into one entry.

---

## 8 · Build, test & deploy

```bash
npm run dev            # vite dev server, LAN-exposed for phone testing
npm run typecheck      # both tsconfigs: client (strict) + server (node types)
npm run build          # typecheck → client bundle → server bundle
npm test               # vitest, 93 tests, in-memory Redis
npm run build:watch    # scripts/watch.mjs — used by `devvit playtest`
npm run playtest       # live on a test subreddit
npm run upload         # push a version
npm run publish        # submit for review
```

**Three Vite configs**, because three artefacts have three different shapes:

- `vite.config.ts` — the client web view. `publicDir: false`, `base: './'`,
  output to `dist/client` (this is `post.dir` in `devvit.json`).
- `vite.server.config.ts` — a single self-contained **CommonJS** file whose only
  bare imports are Node built-ins. `ssr.noExternal: true` inlines everything;
  `inlineDynamicImports` flattens to one chunk. **`minify: false` is deliberate
  — app review reads this bundle.**
- `vite.devserver.config.ts` — local server harness.

**Testing.** `vitest.config.ts` aliases `@devvit/web/server` to
`tests/devServerMock.ts`, which is what makes the server testable at all — the
real package refuses to work outside the Devvit runtime. `tests/fakeRedis.ts`
copies the real client's *semantics* (including the `nx` empty-string return) and
exposes `failNext` for failure-path coverage.

Current coverage: **server only** (93 tests across `api`, `runs`, `community`).
The client has none. See [§11.4](#114--test-what-is-currently-untested).

---

## 9 · Repository archaeology

**This repository contains three generations of a game. Only one runs.**

A reachability trace from `src/main.ts` and `src/server/index.ts` finds **30 of
64 source files reachable**. The other 34 — roughly **9,000 of 15,500 lines,
about 58% of the tree** — are unreachable:

| Generation | Location | Status |
|---|---|---|
| **Clockshot** | `src/clockshot/`, `src/scenes/clockshot/`, `src/server/`, `src/shared/`, `src/ui/{viewport,layout}.ts` | **live** |
| **SWEEP** (Pictionary on a clock face) | `src/sweep/`, `src/scenes/{Draw,Guess,Post,Tutorial,Menu,Results,Boot,Pause,Sweep}Scene.ts`, `src/ui/{Button,Keyboard,Toast,theme}.ts`, `src/audio/`, `SWEEP_GDD.md` | orphaned |
| **Trapmaker** (level-editor platformer) | `src/game/`, `src/scenes/{Raid,Editor}Scene.ts`, `public/levels/` | orphaned |

Vite tree-shakes all of it out of the client bundle, so **it costs nothing at
runtime**. It costs plenty everywhere else:

- `tsconfig.json` includes all of `src`, so ~9,000 dead lines are typechecked on
  every build.
- `src/game/config.ts` is a **complete second `gameConfig`** exporting the same
  symbol name and wiring an entirely different scene list. Anyone editing "the
  game config" has a coin-flip chance of editing the wrong file.
- `src/scenes/` contains `MenuScene`, `ResultsScene`, `PauseScene` and
  `BootScene` that are *not* the live ones — the live ones are in
  `src/scenes/clockshot/`. Every file search returns two answers.
- `SWEEP_GDD.md` sits in the root describing a completely different game, with no
  note saying so.

**Recommendation: delete all of it.** It is in git history (`1ed881a`), it is not
referenced, and it is the single largest obstacle to anyone — human or agent —
navigating this codebase.

```bash
git rm -r src/game src/sweep src/audio public \
          src/scenes/{Boot,Draw,Guess,Menu,Pause,Post,Results,Sweep,Tutorial,Raid,Editor}Scene.ts \
          src/ui/{Button,Keyboard,Toast,theme}.ts \
          SWEEP_GDD.md
# then: delete computeFrame() from src/ui/layout.ts and px() from src/ui/viewport.ts
```

---

## 10 · Known defects

Ordered by player impact. Items 1–3, 8 and 9 were verified by execution (8 and 9
were found by running the game locally — see §15).

**Status:** 1, 3, 8 and 9 are fixed, with regression tests where the defect was
testable. **2, 4, 5, 6 and 7 remain open.** Defect 2 (the `addToBank` race) is
the most important of those.

### ✅ 1. A failed bank can never be retried — **FIXED**

**[`ResultsScene.ts`](src/scenes/clockshot/ResultsScene.ts)** — `submit` /
`share` / `playAgain`

On failure, `submit()` sets `failed = true` and captions the button
`RETRY BANKING`. But `result` is only ever assigned on success, so:

```ts
private async share(): Promise<void> {
  if (this.failed && !this.result) {          // ← always true on ANY failure
    fadeTo(this, () => this.scene.start('cs-menu'));
    return;
  }
  if (this.failed) { void this.submit(); return; }   // ← unreachable
```

The first branch always wins. **"RETRY BANKING" navigates to the menu**, and
`playAgain()` bails the same way — so after a transient network failure the
player has no path to retry, and 30 seconds of play is silently discarded. This
is precisely the outcome the file's own docstring calls *"the worst thing this
game could do."*

**Fix.** Store `permanent` as a field in the `catch` block and branch on that:

```ts
private permanent = false;
// in catch:   this.permanent = e !== null && (e.code === 'run_duplicate' || …);
// in share(): if (this.permanent) { → menu } else if (this.failed) { void this.submit() }
```

### 🔴 2. `addToBank`'s floor clamp is not concurrency-safe

**[`community.ts:76-97`](src/server/community.ts#L76-L97)**

The `hIncrBy` is atomic, but the overshoot refund is a **second, separate write**.
Verified against the project's own `FakeRedis`:

```
bank = 10; two concurrent steals of 20 each
→ applied A = -10,  applied B = +10,  final bank = 10   (expected 0)
```

Two consequences:

- The bank settles **above** zero instead of empty.
- **`applied` comes back positive on a steal.** `src/server/index.ts:296` does
  `Math.abs(loss.applied)`, so that player is credited 10 seconds of contribution
  and gets a *"stole 10s"* feed line for a steal that handed the seconds **back**.

The existing test (`never lets a bank go negative`) loops sequentially and does
not reach the interleaving.

**Fix.** Clamp *before* the increment by reading what is actually available, with
a bounded retry:

```ts
for (let attempt = 0; attempt < 4; attempt++) {
  const before = parseDelta((await redis.hGetAll(K.banks(index)))?.[team]);
  const room = STARTING_BANK + before;            // seconds actually available
  const take = Math.max(seconds, -room);          // never more than exists
  const after = await redis.hIncrBy(K.banks(index), team, take);
  if (after >= -STARTING_BANK) return { applied: take, bank: bankFromDelta(after) };
  await redis.hIncrBy(K.banks(index), team, -take);  // undo and re-read
}
```

Add a regression test that runs two `addToBank` calls through `Promise.all`.

### ✅ 3. The jump-cut is applied every frame, not on release — **FIXED**

**[`player.ts:270-272`](src/clockshot/player.ts#L270-L272)**

```ts
if (!intent.jumpHeld && this.body.velocity.y < 0 && !this.attached) {
  this.body.velocity.y *= MOVE.cutMultiplier;   // 0.45 — EVERY FRAME
}
```

This lives in `update()`, so it compounds: `0.45⁵ ≈ 0.018`. **Any upward velocity
is annihilated in about 80 ms whenever JUMP is not held.** That destroys:

- the upward momentum from a grapple release — the game's *central mechanic*, and
  directly contrary to the `releaseBoost` in `release()`;
- the `−420` knockback in `onHazard`.

A variable-height jump cut should fire **once**, on the release edge.

**Fix.**

```ts
// track the previous frame's hold state
const releasedJump = !intent.jumpHeld && this.wasJumpHeld;
this.wasJumpHeld = intent.jumpHeld;
if (releasedJump && this.body.velocity.y < 0 && !this.attached) {
  this.body.velocity.y *= MOVE.cutMultiplier;
}
```

### 🟡 4. Trapmaker leftovers are uploaded to Reddit

`vite.config.ts` sets `publicDir: false` with a comment explaining exactly why —
but `vite.server.config.ts` does not. Vite's default `public/` copy therefore
lands in `dist/server/levels/classic-demo.json` (and `dist/devserver/`), and is
uploaded. Add `publicDir: false` to the server config, or delete `public/`
entirely per §9.

### 🟡 5. Pausing or backgrounding for >15 s loses the run

`PlayScene.update()` stops while the scene is paused, so `finish()` never fires
at zero; on resume the submit exceeds `RUN_GRACE_LATE_MS` and is rejected with
`run_expired`. The pause screen warns that the clock keeps running, but nothing
auto-banks at zero.

**Fix.** Either (a) have `PauseScene` watch `store.serverNow()` and force
`cs-results` when the run window closes, or (b) register a `visibilitychange` /
`Phaser.Core.Events.RESUME` handler that submits whatever tally exists. Option
(a) is simpler and matches the existing design.

### 🟢 6. Over-broad listener teardown

[`controls.ts:262`](src/clockshot/controls.ts#L262) — `destroy()` calls
`this.scene.input.removeAllListeners()` to clear the two handlers it owns.
Harmless today (it only runs at shutdown), fragile the moment anything else binds
scene-level input. Track and remove the two specific handlers.

### 🟢 7. Comment/code mismatches and dead exports

- [`textures.ts:11`](src/clockshot/textures.ts#L11) claims sprites are *"baked at
  the ratio the device actually reports"* — there is no `dpr()` anywhere in the
  file; all sizes are fixed literals. (The world-camera zoom compensates, so the
  behaviour is fine — the comment is not.)
- Unused exports that `noUnusedLocals` cannot see: `CSS`, `teamDeep`,
  `formatSeconds`, `api.activity`, `px()`, `computeFrame()`.
- `GET /api/activity` has no client caller.
- [`controls.ts:239`](src/clockshot/controls.ts#L239) — `fire: fire || fireHeld`
  reduces to `fireHeld`, making `prevFire` and the edge detection above it dead
  computation. Intentional per the comment, but say so in one line instead of
  computing it.
- An **empty `.env` is tracked in git** while `.gitignore` does not cover it. A
  committed placeholder is how secrets get committed later:
  `git rm --cached .env && echo '.env' >> .gitignore`.

### ✅ 8. An *early* submit destroys the run — **FIXED**

**[`index.ts`](src/server/index.ts) — `handleRunFinish`**

Observed live against the local server: submitting a run before the 30 s window
closes returns `run_expired` **and clears the active run**, so the legitimate
submit that follows gets `run_duplicate`. The run is gone.

```
POST /api/run/finish  (immediately)   → run_expired  "submitted before it could have finished"
POST /api/run/finish  (at +30s)       → run_duplicate "already been counted"
```

The cause is that the timing-failure branch treats *too early* and *too late*
identically:

```ts
const timing = validateTiming(run, now, roundIndex);
if (!timing.ok) {
  await clearActiveRun(player.userId);   // ← also fires for the EARLY case
  await markFinished(player.userId, now);
  return fail(res, 409, timing.code, timing.message);
}
```

A late run genuinely cannot be recovered, so clearing it is right. An **early**
one is almost always a clock-skew or latency artifact, and the correct answer is
"not yet — try again in a moment," not "your run is void." `RUN_GRACE_EARLY_MS`
is only 1.2 s, so a device whose clock correction is slightly off can trip this.
It compounds with defect 1: `run_expired` is not retryable, so `withRetry` gives
up and the results screen offers no way back.

**Fix.** Split the branch — leave the run intact on an early submit and return a
distinct, retryable code:

```ts
if (!timing.ok) {
  if (timing.code === 'run_expired' && nowMs - run.startedAt < RUN_MS) {
    return fail(res, 425, 'too_early', 'That run has not finished yet.');  // run left in place
  }
  await clearActiveRun(player.userId);
  await markFinished(player.userId, now);
  return fail(res, 409, timing.code, timing.message);
}
```

### ✅ 9. The results breakdown renders underneath the buttons — **FIXED**

**[`ResultsScene.ts`](src/scenes/clockshot/ResultsScene.ts) — `relayout()`**

Visible in the live results screenshot and confirmed by arithmetic at a 500×749
viewport: the 10-line breakdown column overflows **61.5 px** into the button
stack, and `statusText` ("banked") lands *inside* the breakdown column at y≈415.

```
columnTop      307.0
breakdown bot  497.0
buttonsTop     435.5   →  OVERLAP 61.5 px
```

The method's own comment states the rule it does not enforce:

> *"The button stack owns the bottom of the screen; everything above it has to
> fit in what is left, or be dropped. Text running under a button is worse than
> text that is not there."*

Only `feedText` is conditionally hidden. `breakdown` is placed at `columnTop`
with no clamp, and `statusText` is positioned relative to the button stack rather
than to the content above it.

**Fix.** Apply the same room test to the breakdown that already guards the feed —
drop lines (or shrink the font) until it fits `buttonsTop - columnTop`, and move
`statusText` above the breakdown rather than into it.

---

## 11 · Improvement plan

### 11.1 Do these first (hours, high payoff)

1. **Fix defects 1, 3 and 8** — the three that lose a player's run or their
   momentum. Each is a handful of lines. Fix 1 and 8 together: they compound.
2. **Fix defect 2** (`addToBank` race) and **defect 9** (results overlap).
3. **Delete the dead generations** (§9). Half the repo.
4. **Add `publicDir: false`** to `vite.server.config.ts`.
5. **Untrack `.env`.**

### 11.2 Tighten the toolchain

The project has strict TypeScript and a clean typecheck but **no linter and no
formatter**. For a codebase whose comment quality is this high, that is the one
missing guardrail.

```bash
npm i -D eslint typescript-eslint eslint-plugin-import prettier knip
```

- **ESLint** with `typescript-eslint` strict + `no-floating-promises` — there is a
  lot of `void somePromise()` here; the rule makes that intent *checked* rather
  than conventional.
- **`eslint-plugin-import`** with `no-restricted-paths` enforcing the boundary
  that matters: `src/clockshot/**` and `src/scenes/**` may not import
  `src/server/**`, and `src/shared/**` may import neither.
- **Knip** to catch unused exports — it would have found every item in §10.7.
- **Prettier** — the code is already consistently formatted; lock it in.
- A **GitHub Actions workflow** running `typecheck`, `lint`, `test`, `build` on
  push.

### 11.3 Make the fragile parts explicit

- **Extract magic numbers from `PlayScene.relayout()`.** The zoom formula
  `min(w/520, h/900)` and the HUD offsets are load-bearing and undocumented as
  values. Move them to `tuning.ts` beside `MOVE` and `GRAPPLE`.
- **Give `PlayScene` a smaller surface.** At 782 lines it is the only file in the
  live tree that is hard to hold in your head. Natural seams: a `Hud` class
  (ring, timer, score, pause zone, relayout), a `RunTally` accumulator (all the
  `tally.x++ / collected += / streak` bookkeeping), and an `Arena` builder (the
  five `buildX()` methods). Each is a pure extraction with no behaviour change.
- **Type the scene keys.** `this.scene.start('cs-results')` is a string literal in
  a dozen places. `export const S = { boot: 'cs-boot', … } as const` plus
  `type SceneKey = typeof S[keyof typeof S]` makes a typo a compile error.

### 11.4 Test what is currently untested

Server coverage is genuinely good. The gaps are all on the client, and two of
them are cheap because the logic is already pure:

- **`arena.buildLayout(seed)`** — pure. Assert determinism (same seed → identical
  layout), that a golden clock always exists, and that pickup counts stay under
  `RUN_CAPS`.
- **`store` clock correction** — pure. Assert `serverNow()` tracks a skewed device
  clock and that `msLeftInRound()` floors at zero.
- **`net.withRetry`** — assert it does *not* retry a non-retryable `NetError`.
- **Concurrency regression for `addToBank`** (defect 2).
- **A `ResultsScene` submit-failure test** (defect 1). This needs the submission
  logic extracted from Phaser to be testable — which is itself an argument for
  §11.3's split.

### 11.5 Accessibility & polish

- Honour `prefers-reduced-motion` in-game. `index.html` already does it for the
  splash; the camera shakes, flashes and particle bursts do not.
- The HUD signals urgency with colour alone (`gold → danger` at 10 s). The clock
  arc gives a second channel; a shape or pulse change would be a third.
- Add a colour-blind-safe alternative to red/blue team identity — a shape or
  pattern on the team bar, not just the two hues.
- Surface `NetError` states on the menu, not just the boot screen.
  `store.lastError` is already tracked and rendered nowhere.

---

## 12 · Scaling up

The question that matters is: **what breaks when this game is popular?**

### 12.1 Where the current design already scales well

- **Rounds need no scheduler.** A million players hitting a round boundary
  simultaneously produce no contention, because the round index is arithmetic.
- **Banks are `hIncrBy`.** Concurrent runs add rather than overwrite. (Modulo
  defect 2, which is a clamp bug, not a design flaw.)
- **Round-scoped keys with TTLs** mean storage is bounded by *active* rounds, not
  by lifetime traffic.
- **State is per-installation**, so subreddits are naturally sharded by Devvit.

### 12.2 Where it will bend first

**A. Read amplification on `/api/state`.** Every menu poll (12 s) and every
dashboard poll (8 s) issues **7+ Redis round trips**: `hGetAll(banks)`,
`zCard(players)`, the whole `previousRound()` block (another `hGetAll` + `zCard`),
`get(team)`, `zRange(activity)`, `get(lastFinish)`, `hGetAll(run)`, `zScore`, and
`zRange` again for `rankOf`. With 500 concurrent viewers on a popular post that
is ~4,000 Redis ops/minute *for people who are not playing*.

> **Fix.** Cache the community half of `/api/state` in a Redis key with a 2–3 s
> TTL — it is identical for every caller. Split the response so the client can
> poll `community` frequently and `you` rarely. And back off polling when
> `document.hidden`, which currently it does not.

**B. `rankOf()` and `leaderboard()` both `zRange(0, 24)`.** `handleState` calls
`rankOf`; `handleRunFinish` calls it again after the writes. Worse, `rankOf`
**silently returns `null` for anyone outside the top 25**, so a player in 30th
place is told "not yet ranked this round" even though they have scored.

> **Fix.** Use `zRank`/`zRevRank` for a true rank in O(log N) instead of scanning
> a window. If the Devvit client lacks it, at minimum widen the window and cache
> the board.

**C. The activity feed is a global sorted set with a trim on every write.**
`pushActivity` does a `zAdd` then a `zRemRangeByRank` — two ops per event, and
`handleRunFinish` can push **four** events (added, stole, golden, lead). That is
eight Redis ops per completed run just for the feed.

> **Fix.** Batch the round's feed writes into one `zAdd` with multiple members,
> and trim probabilistically (say 1-in-10 writes) rather than every time.

**D. The client bundle is 1.5 MB.** Almost all Phaser. Inside a Reddit web view
on mobile data that is a real cost to first play.

> **Fix.** Build a custom Phaser bundle. This game uses Arcade physics, Graphics,
> Text, Image/Sprite, Particles, Tweens and Input — it does not use Tilemaps,
> Matter, Spine, the Sound manager (audio is hand-rolled), or the Loader in any
> meaningful way. A custom build routinely halves this. Also enable
> `build.minify` for the *client* — it is only disabled for the server, and only
> because app review reads that file.

**E. There is no rate limit on read endpoints.** `RUN_COOLDOWN_MS` guards
finishes, but `/api/state`, `/api/leaderboard` and `/api/activity` are
unthrottled. A single misbehaving client can poll them as fast as it likes.

> **Fix.** A per-user token bucket in Redis, or at minimum a short-TTL cached
> response so repeated calls are cheap regardless.

### 12.3 Scaling the *game*, not the infrastructure

**Round length is a single constant and it is doing a lot of work.** Ten minutes
is right for a launch-day post with constant traffic; it is wrong for a quiet
subreddit where a round can end with two players and one run. Consider:

- **Adaptive rounds** — extend when player count is below a threshold. This
  breaks the "rounds are pure arithmetic" property, so weigh it carefully; a
  cheaper version keeps the maths and simply *displays* the previous round's
  result more prominently when a round was thin.
- **Seasons.** A round is 10 minutes; there is nothing above it. A weekly or
  monthly aggregate (`s:{week}:banks`) gives returning players something that
  persists past the ten minutes they happened to be online for, at the cost of
  one more key family and one more `hIncrBy` per run.

**One arena will exhaust itself.** `buildLayout(seed)` varies pickups and patrols
but the geometry never changes, and players *will* find the optimal line within a
few dozen runs. Since the arena is already pure data, the cheapest large win in
this whole document is:

> **Make `PLATFORMS` / `ANCHORS` / `HAZARDS` a per-arena record, ship three or
> four arenas, and have the server pick one per round**
> (`arenaIndex = hash(roundIndex)`). Everyone in a round plays the same arena, so
> scores stay comparable, and the arena becomes a thing the community talks
> about. This requires **no new systems** — only moving the four exported arrays
> into an array of objects and adding one field to `RunStartResponse`.

---

## 13 · Feature roadmap

Sequenced so each tier is independently shippable.

### Tier 1 — deepen what exists (no new systems)

- **Multiple arenas per round** (§12.3). Highest value per line of code.
- **Personal best & run history.** A `p:{uid}:best` string and a `p:{uid}:runs`
  capped zset. Gives a solo player a reason to run again when their team is
  comfortably ahead.
- **Streak bonus.** `PlayScene` already tracks `this.streak` and passes it to
  `sfx.collect()`, but it awards nothing. Make an uninterrupted collection chain
  worth a small multiplier — the plumbing is already there.
- **Round-end ceremony.** `ActivityKind` already includes `'roundEnd'` and
  `activityLine()` already renders it, but **nothing ever pushes one**. Have the
  first request of a new round write the previous round's result into the feed.
- **Show the round's arena variation on the menu** — "this round: 5 patrols,
  golden clock high-centre" — so a player knows what they are walking into.

### Tier 2 — deepen the community layer

- **Comment integration.** `reddit.submitCustomPost` is already imported. Post a
  comment when a round ends, or when a player takes the lead single-handedly.
  This is the most Reddit-native feature the game is not yet using.
- **Team chat via the feed.** A capped set of pre-written taunts pushed as
  activity items. No free text, so no moderation burden.
- **A "clutch" flag** — the run that flipped the lead in the last 60 seconds of a
  round gets a permanent line in the feed and a badge on the leaderboard.
- **Cross-subreddit board.** Devvit scopes Redis per installation, so this needs
  an external store; treat it as a genuinely separate project.

### Tier 3 — new mechanics

- **Asymmetric objectives.** The trailing team's enemy fragments are worth more.
  A single multiplier in `SCORE`, applied server-side from the current banks — it
  fits the existing architecture perfectly and directly addresses the "one team
  runs away with it" failure mode.
- **A shared boss clock** both teams shoot at, whose seconds go to whoever lands
  the final hit.
- **Ghost runs.** Record the position stream of the round's best run (the SWEEP
  generation's `replay.ts` did exactly this and is sitting in git history) and
  render it as a translucent ghost. Storage is the concern: quantise
  aggressively, store one ghost per round rather than per player.

### Tier 4 — the long game

- **Spectator mode.** `/api/state` already works logged-out; a live view of the
  arena with other players' positions would need a real-time channel Devvit may
  not offer cheaply. Scope carefully before starting.
- **Seasonal cosmetics** earned from cumulative contribution, drawn with the
  existing `bakeTextures` pipeline so nothing new has to load.

---

## 14 · Appendix: file map

### Live (30 files)

```
src/
├── main.ts                     entrypoint: Phaser boot, viewport, audio unlock,
│                               visibility handling, splash handover
├── shared/                     THE ONLY CODE BOTH HALVES IMPORT
│   ├── config.ts               ROUND_MS, RUN_MS, SCORE, RUN_CAPS, Team, round maths
│   └── api.ts                  the complete wire contract + ErrorResponse union
├── server/
│   ├── index.ts                router, identity, post creation, error shaping
│   ├── runs.ts                 lifecycle, sanitizeTally, scoreRun, validateTiming
│   ├── community.ts            banks, contributions, leaderboard, feed, rounds
│   └── keys.ts                 every Redis key
├── clockshot/
│   ├── game.ts                 Phaser config (THE live one)
│   ├── theme.ts                every colour + FONT + team helpers
│   ├── tuning.ts               MOVE, GRAPPLE, COMBAT, GRAVITY
│   ├── arena.ts                geometry as data + seeded layout generator
│   ├── player.ts               movement + the grapple constraint
│   ├── controls.ts             multi-pointer touch pads + keyboard + mouse
│   ├── textures.ts             every sprite, baked at boot
│   ├── sfx.ts                  every sound, synthesised
│   ├── net.ts                  api, NetError, withRetry
│   ├── store.ts                client world view + server-clock correction
│   └── ui.ts                   Layout, Button, panel, drawTeamBar, fade helpers
├── scenes/clockshot/           the 10 live scenes (see §4.1)
└── ui/
    ├── viewport.ts             canvas sizing, DPR cap
    └── layout.ts               readInsets() — safe-area probe
```

### Dead (34 files, ~9,000 lines — see §9)

```
src/game/         src/sweep/        src/audio/        public/
src/scenes/*.ts (the non-clockshot ones)
src/ui/{Button,Keyboard,Toast,theme}.ts
src/ui/layout.ts::computeFrame()    src/ui/viewport.ts::px()
SWEEP_GDD.md
```

---

## 15 · Appendix: running it locally

There is no `npm run` one-liner for this, but the repo already contains
everything needed. `tests/devServerMock.ts` builds a **real** local server — it
bundles the actual `src/server/index.ts` against an in-memory Redis and serves
`/api/*` *and* the built client from one origin, exactly like the real web view.
So a browser playing against it exercises the shipped server logic, not a second
implementation.

```bash
npm run build:client       # → dist/client
npm run build:devserver    # → dist/devserver/index.cjs
node dist/devserver/index.cjs
# open http://localhost:39700
```

Environment hooks the harness provides:

| Variable / header | Effect |
|---|---|
| `CLOCKSHOT_PORT` | server port (default `39700`) |
| `CLOCKSHOT_CLIENT` | webroot to serve (default `dist/client`) |
| `CLOCKSHOT_USER` | default identity for browser requests (default `devplayer`) |
| `x-dev-user: <name>` | act as that Reddit account; `anon` = logged out |
| `x-dev-time-offset: <ms>` | shift this request's view of the clock |

The time-offset header is what makes the 30-second run and the 10-minute round
testable without sleeping. A complete loop from the shell:

```bash
H=http://localhost:39700
curl -s -X POST $H/api/team -H 'content-type: application/json' \
     -H 'x-dev-user: alice' -d '{"team":"red"}'
RUN=$(curl -s -X POST $H/api/run/start -H 'x-dev-user: alice')
RID=$(echo "$RUN" | sed -E 's/.*"runId":"([^"]+)".*/\1/')
curl -s -X POST $H/api/run/finish -H 'content-type: application/json' \
     -H 'x-dev-user: alice' -H 'x-dev-time-offset: 30000' \
     -d "{\"runId\":\"$RID\",\"tally\":{\"fragments\":8,\"largeFragments\":2,
          \"goldenClocks\":1,\"enemyKills\":1,\"enemyFragments\":3,\"hazardHits\":1}}"
```

Two different `x-dev-user` values share one world, which is how you exercise the
community layer — the banks, the leaderboard, the feed and the lead-change
announcement — from a single machine.

**Note:** `npm run dev` (plain Vite on :5173) serves the client but **not**
`/api/*`, so the game stalls on the boot screen. Use the dev server above, or add
a proxy to `vite.config.ts`:

```ts
server: { proxy: { '/api': 'http://localhost:39700' } }
```

**Verified end to end** on this machine: boot → menu (live banks) → team select →
30-second run (movement, jump, grapple with rope + anchor highlight, fire, pickup
collection, hazard hits, camera follow, HUD countdown) → results → **banked**,
with a second identity's contribution visible in the first's leaderboard rank.
Phaser boots on WebGL with no console exceptions. Defects 8 and 9 were found
during this session.

---

*Generated from a full source read of commit `1ed881a`, then verified by running
the game locally. Defects 1–3, 8 and 9 in §10 were confirmed by execution; the
rest by inspection.*

---

## 16 · The simplification pass

### Why

A driven playtest of the original build scored **+0s**: three fragments (+3s),
three hazard hits and a fall (−9s), floored to zero — and the screen announced
it in 40px type. Measuring the arena explained the rest: a new player walking
right met their **first spike strip 140px from spawn — 0.44 seconds in** — and
180px later a pit they could not cross without already knowing the grapple.

The game asked a beginner to hold **19 concepts** for a 30-second experience.
The idea was never the problem; the surface area was.

### What changed

| Change | Effect |
|---|---|
| **Play first, choose a side after** | Two screens and a blind commitment removed from the path to first play. The team question becomes *"who gets these seconds?"* — a reward, not a toll gate. |
| **Hazards and falls cost time, not seconds** | The "+0s" failure state is gone. `SCORE.hazardPenalty` / `fallPenalty` deleted; `scoreRun` no longer subtracts. Whatever you collect, you keep. |
| **Shooting removed** | No FIRE pad, bullet pool, auto-aim cone, or kill scoring. Enemies are obstacles to swing past. ~120 lines and a whole second verb gone. |
| **Large fragments dropped** | Two reward tiers instead of three — a middle tier only ever read as "a slightly bigger clock". |
| **One number, not three** | The HUD and the results headline show `awarded + stolen` as a single total. The split still exists on the wire and the server; nobody has to hold it in their head. |
| **Results breakdown cut from 10 rows to ≤3** | Only lines describing something the player *chose* to do. This also fixed defect 9. |
| **The arena opening reworked** | The spawn-island spike strip is gone and a five-clock trail runs along flat ground to the lip of the first pit, where the low anchor is already in grapple range. Run → score → *then* learn the rope. |

**Concepts: 19 → 7.** Two teams · a 30-second run · swing · collect clocks ·
gold ones are worth more · red ones hurt them · your seconds go to your team.

### One deliberate deviation

The plan called for three inputs (← → GRAPPLE). **Jump was kept**, so the pad
count is four rather than three. Two reasons: nobody has to *learn* what a jump
button does, so it costs a beginner nothing — and the remaining spike strips are
32px tall and sit on flat ground, so removing jump would make them impassable on
foot and turn several ordinary traversals into forced swings. Removing FIRE is
what buys the simplification; removing JUMP mostly buys a broken arena. It is a
ten-line change if you want it anyway.

### What was deliberately *not* cut

- **Stealing.** It is the only thing making this a war rather than two people
  playing solitaire beside each other — and as a red pickup it needs no
  explanation. The complexity was in the *reporting*, which is what got fixed.
- **The grapple.** It is the identity. Cutting the weapon is what gives it the
  screen to itself.
- **The shared bank.** That is the idea worth keeping.

### Verification

`npm run typecheck` clean on both projects; **98/98 tests pass** (up from 93 —
five new, covering the early-submit hold, the teamless-run path, the round lock
against a forged team field, and the no-penalty scoring). The full new-player
path was then driven in a real browser against the local server: menu → PLAY →
30-second run (neutral cyan player, clean opening, grapple, collection) →
*"WHO GETS THESE SECONDS?"* → RED → **banked**, `+4s`, feed line, rank #1, with
no text running under a button.

### Server compatibility

`RunTally` keeps `largeFragments`, `enemyKills`, `hazardHits` and `falls` on the
wire; the client simply reports zero for them, and `RUN_CAPS` still validates
them. Nothing about the trust model moved: identity still comes from `context`,
scoring is still recomputed server-side, and the round lock still wins over any
`team` field a client sends.
