# Clockshot — Swing Against the Clock

A Reddit Devvit Web game built with Phaser 3.

You start with **ten seconds**. The clock drains the moment you move, and the
only way to keep going is to swing through the clock pickups scattered across
the arena. **Reach the goal before it hits zero.**

There is no team, no side to pick, and nothing to lose to another player. Just
you, a rope, and a clock you are always running down.

---

## How you score

| | |
|---|---|
| Reaching the goal | **500** |
| Each distinct anchor you swung from | **25** |
| Each whole second still on your clock | **100** |

Not reaching the goal scores nothing at all — the run is one question, and a
near miss is still a miss.

Two things follow from that table, and they pull against each other: swinging
through *more* of the arena pays, but so does arriving *early*. The best runs
take the long way round and still get there with time in hand.

Anchors are counted **distinct**, so swinging back and forth on one hook earns
nothing after the first grab.

## Time

| | |
|---|---|
| Starting clock | 10 s |
| Clock pickup | **+2 s** |
| Golden clock | **+5 s** |
| Spikes or an enemy | **−2 s** |

The clock is frozen until your first input, and it stops while paused — it is
your fuel, not a countdown you are racing.

## Checkpoints, and dying

Run out of time and you go **straight back in** — no results screen, no button
to press. A failed run scores nothing, so there is nothing to read and nothing
to post; the only thing standing between you and the retry would be a screen.

Green flags along the route are **checkpoints**. Touch one and that is where you
restart, with the clock it recorded at that moment (never less than 5s, so you
can never land in an unwinnable loop). Your anchors and everything you collected
carry across, because a restart resumes the same run rather than starting a new
one.

A checkpoint arms **once**. Re-touching it does nothing — otherwise the best
play would be to build a fat clock, walk back, re-arm, and die on purpose.

## Theme interpretation — "Timers"

Time is not the pressure in Clockshot; time is the **currency**, and there are
three clocks running at once:

| Clock | Length | Who owns it |
|---|---|---|
| Your run | 30 seconds | you |
| The community round | 10 minutes (`ROUND_MS`) | the subreddit |
| Each team's bank | grows and shrinks | the team |

You spend the first to fill the third before the second runs out. Collecting a
clock fragment does not score points — it moves seconds out of the arena and
into a bank that other people can see. Enemy fragments take seconds *off* the
other team rather than adding them to yours, so time is conserved and contested
rather than merely accumulated.

## The community experience

This is not a leaderboard bolted onto a single-player game. Every completed run
mutates shared state that every other player sees:

- Two **persistent team time banks**, held in Redis and updated atomically.
- A **community round** derived from the wall clock, so it needs no scheduler
  and cannot get stuck: the round a request belongs to is a pure function of
  when it arrived (`roundIndexAt`).
- A **live activity feed** — "u/name added 18 seconds to Red Team",
  "Blue Team has taken the lead" — shown on the menu, dashboard and results.
- **Team and individual leaderboards** for the current round.
- The **previous round's winner**, shown as soon as a new round begins.

Players never need to be online at the same time. A run you take now changes
what the next person sees when they open the post.

## Controls

**Mobile** — three large touch pads (all comfortably above the 44 px minimum):

| Pad | Action |
|---|---|
| `<` `>` | steer: walk on the ground, pump the swing in the air |
| `GRAPPLE` | hold to hook the nearest anchor above you; release to launch |

**Desktop**

| Key | Action |
|---|---|
| `A` / `D` or `←` / `→` | steer |
| `E`, `Space`, `W` or either mouse button | grapple |
| `Esc` or `P` | pause |

There is no jump and no weapon. The rope is the only verb, so it gets the
screen to itself — and holding GRAPPLE keeps trying, so an anchor is caught the
moment it comes into range.

The grapple auto-targets: the anchor it would take is always highlighted, so
aiming is never a guess. The rope shortens while held, so a swing gains height
instead of decaying.

## Technology

- **Phaser 3.90** — Arcade Physics for platforming; the grapple is a
  position-based pendulum constraint applied after integration (stable and
  repeatable rather than a simulated rope).
- **Devvit Web 0.14.1** — custom post, tall height, Redis enabled.
- **TypeScript 5.6** (strict), **Vite 6**, **Vitest 3**.
- **No asset files.** Every sprite is drawn procedurally at boot and every sound
  is synthesised with WebAudio. Nothing is fetched, so nothing can fail to load
  inside a Reddit web view.

## Local setup

```bash
npm install
npm run typecheck     # client + server projects
npm test              # 93 tests
npm run build         # typecheck + client bundle + server bundle
```

### Playing locally without Reddit

A dev server runs the **real** `src/server/index.ts` against an in-memory Redis,
so local play exercises the same routing, validation and scoring that ships:

```bash
npm run build
npm run dev:server            # http://127.0.0.1:39700
```

Identity comes from an `x-dev-user` header (a browser with no header plays as
`devplayer`); `x-dev-time-offset` shifts that request's clock, which is how the
tests exercise run expiry and round rollover without waiting.

### Devvit playtest

```bash
npx devvit login                    # interactive: opens reddit.com in a browser
npx devvit playtest r/<your-test-sub>
```

The subreddit must be one you moderate with fewer than 200 subscribers.
`devvit.json` sets `scripts.dev`, so saving a file rebuilds both bundles and
reinstalls automatically.

### Publishing

Not done yet — deliberately. See "Remaining steps" below.

```bash
npx devvit upload                   # private, owner-only
npx devvit publish                  # submits for review
```

## Redis architecture

Devvit scopes Redis per app installation, so keys only need to be unique within
one subreddit's copy of the game.

| Key | Type | Purpose |
|---|---|---|
| `r:{round}:banks` | hash | `red`/`blue` → **delta** from `STARTING_BANK` |
| `r:{round}:players` | zset | member = username, score = seconds contributed |
| `r:{round}:pteams` | hash | username → team, for colouring board rows |
| `r:{round}:activity` | zset | member = JSON item, score = timestamp |
| `r:{round}:meta` | hash | last known leader, so a takeover announces once |
| `p:{userId}:team` | string | team choice, deliberately outside any round |
| `p:{userId}:run` | hash | the in-flight run (TTL) |
| `run:{runId}:done` | string | spent run id (TTL) — the duplicate gate |
| `p:{userId}:last` | string | last banked run, for rate limiting |

Three decisions worth calling out:

1. **Banks store a delta, not a total.** `hIncrBy` on a missing field starts at
   zero, so a round needs no initialization step and there is no race between
   the first two players to arrive.
2. **All bank writes are atomic increments.** Two runs landing at the same
   millisecond each get their own increment; neither can overwrite the other.
   A bank that would go below zero is pinned, and only the seconds that really
   came off are reported.
3. **Round keys carry the round index and a TTL**, so a new round starts clean
   without anything having to delete the old one, and old rounds expire on their
   own (`ROUND_RETENTION_MS`).

## Anti-cheat

The client reports **what it did**, never **what it earned**.

- Identity comes from the Devvit `context`, never from the request body — a
  username in the payload is ignored.
- The run id, its start time and the arena seed are all issued by the server.
- Seconds are recomputed server-side from `SCORE`; every count is capped by
  `RUN_CAPS`; non-numeric values (a JSON array coerces to a number in JS) are
  rejected rather than coerced.
- Run timing is validated against the server clock only, with a window for
  latency. Submitting early, late, or after the round ended is refused.
- A run id can be claimed exactly once (`SET NX`), so a retry, a double tap or a
  replay can never bank twice.
- Repeat submissions are rate limited per player.

## Timer reliability

Run time is measured against the server's start stamp via a client clock offset
(`store.serverNow()`), not the device clock and not `setInterval`. Consequences,
all intentional:

- Backgrounding the tab neither pauses a run nor extends it.
- Pausing does not stop the run clock — the pause screen says so.
- Refreshing mid-run returns the *same* run with its original start time.
- A device whose clock is wrong by hours still sees correct round countdowns.

## Testing

93 automated tests, all passing. The API tests import `src/server/index.ts`
itself and drive it over real HTTP against an in-memory Redis.

| Suite | Tests | Covers |
|---|---|---|
| `tests/community.test.ts` | 26 | round derivation, atomic banks, negative clamping, leaderboards, activity trimming, round transitions, TTLs |
| `tests/runs.test.ts` | 33 | run lifecycle, duplicate claiming under concurrency, timing windows, rate limits, tally sanitizing, scoring caps |
| `tests/api.test.ts` | 34 | logged-out viewers, team locking, full runs, concurrent submissions, expiry, round rollover, malformed bodies, Redis failure |

Manually verified in a real browser (Playwright driving Chrome, including
multi-touch via CDP): boot, team selection, a complete 30-second run with
grappling, run banking, results, and the community state updating
as a result. Viewport matrix — 360×640, 390×844, 412×915, 820×1180 tablet,
1280×800 desktop and 844×390 landscape — all boot with no page scrolling, no
clipped controls, and no console errors.

### Bugs found and fixed by that testing

- **Canvas CSS box never updated at DPR 1.** Phaser's `resize()` only writes the
  canvas style when the zoomed size differs from the game size, so on any
  DPR-1 display the canvas kept its boot-time CSS width and the game was
  squashed into a corner. Now pinned explicitly in `src/ui/viewport.ts`.
- **Interface scaled with the world camera.** Zooming the main camera scaled the
  HUD and thumb pads too. The interface now has its own unzoomed camera.
- **Touch targets were half size.** One game unit is a *device* pixel, so a "44"
  target was 22 CSS px on a 2× phone. The device ratio is now folded into the
  layout scale.
- **The grapple was unreachable from the ground.** The nearest anchor above the
  spawn was 608 units away against a 520 range, and neither pit had a crossing.
  A low anchor row was added; every ground position can now grapple.
- **Loose numeric coercion.** `Number([3])` is `3`, and an array can arrive via
  JSON. Only genuine numbers are accepted now.

## Known limitations

- **Not published.** Nothing has been uploaded to Reddit — awaiting approval.
- **Not yet run under `devvit playtest`**, which needs an interactive Reddit
  login. Everything testable without Reddit credentials has been tested; the
  Redis and identity layers have been exercised only against the in-memory
  stand-in, not Reddit's real Redis.
- The app name `clockshot` in `devvit.json` is unverified — Devvit app names are
  globally unique and the name is fixed after the first upload.
- One arena. Deliberate — a single polished arena over several unfinished ones.
- One weapon and one enemy type (Priority 2 items, not started).
- The client bundle is ~1.6 MB (Phaser); not code-split.
- Landscape phone works but the arena view is short; portrait is the intended
  orientation.

## Asset credits

All original. No third-party art, audio, fonts or code beyond the npm
dependencies listed in `package.json`. Every sprite is generated at runtime by
`src/clockshot/textures.ts`; every sound is synthesised by
`src/clockshot/sfx.ts`; the app icon is generated by `scripts/make-icon.mjs`.
The typeface is the system monospace stack.

## AI usage disclosure

AI tools (Claude) assisted with programming, debugging, planning, test authoring
and the procedurally generated visual assets. All generated output was reviewed,
executed and tested — the automated suite and the browser testing described
above were actually run, and the bugs listed under "Bugs found and fixed" were
found by running the game rather than by reading it.

## Screenshots

Add before submitting:

- [ ] Main menu with both team clocks and the live feed
- [ ] Gameplay mid-swing, rope attached
- [ ] Run results showing the contribution
- [ ] Community dashboard
- [ ] Leaderboard

## Submission checklist

- [x] Devvit Web custom post, tall height, no inline scrolling
- [x] Redis enabled, minimal permissions (`reddit`, `redis`; HTTP disabled)
- [x] Client and server entry points configured and building
- [x] Mobile controls with 44 px+ targets
- [x] 30-second run, grappling, collectibles, combat
- [x] Red/Blue teams with persistent shared banks
- [x] Community round timer, leaderboards, activity feed, previous winner
- [x] Server-side validation and atomic score updates
- [x] Results screen
- [x] Mobile viewport testing
- [x] Custom launch screen and app icon
- [x] README with AI disclosure
- [ ] `devvit playtest` in a development subreddit
- [ ] Screenshots captured
- [ ] `devvit upload`
- [ ] `devvit publish` (awaiting approval)
