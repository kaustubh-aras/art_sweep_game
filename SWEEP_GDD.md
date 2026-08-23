# SWEEP — Game Design Document

**Draw in the wake. Guess before the hand comes back.**

Working title: SWEEP · Platform: Reddit (Devvit Web) · Event: ScoreSpace × Reddit · Theme: TIMERS · Focus: COMMUNITY EXPERIENCES · Version 0.1

---

## ☐ 1 · Overview

- A Pictionary chain that lives inside a subreddit
- The canvas is a clock face. A hand sweeps around it every 10 seconds and erases everything it passes, so a drawing only exists in the hand's wake
- Players watch the recorded sweep, guess the word before their points decay, take the baton, and draw the next word for the sub
- Every post is one link in a chain. Every solve leaves a name on the clock face
- Session length: 30–90 s to guess, 90 s to draw
- Team: up to 4 · Build window: ~48 h

### Every timer in the game

| Timer | Value | What it does |
|---|---|---|
| Sweep | 10 s per rotation | Erases strokes as the hand passes |
| Draw session | 6 sweeps (60 s) | Hard stop on drawing |
| Point decay | 100 → 10 over 60 s | Rewards fast guesses |
| Lockout | 1 sweep per wrong guess | Stops brute forcing |
| Crack bounty | +10 / hour unsolved | Makes old posts worth returning to |
| Baton | 60 sweeps (10 min) | Window to accept and draw the next word |
| Chain stall | 6 h | Baton falls open to anyone |
| Wall-clock replay | Loops on the real minute | Everyone on a post sees the same frame |
| Weekly board | Resets Monday | Fresh race every week |

### Jam fit

- Theme: the timer is the canvas, the currency, the hint, and the schedule
- Community: visible actions (live watchers, solves), persistent traces (solver wall, heat map, chain), shared state changes (bounty, baton, chain growth), asynchronous presence by design
- Reddit-y: posts are links in a chain, solves post comments, upvotes feed the bounty
- Mobile: thumb drawing and tap-to-guess, portrait-first

---

## ☐ 2 · Pillars

- **The clock is the canvas.** No timer UI sits on top of the game; the game is the timer
- **Someone was just here.** Every screen shows a trace of another redditor
- **Two thumbs, one minute.** Every action fits a phone and a short attention span

---

## ☐ 3 · The Sweep (core mechanic)

### Rules

- The canvas is a circle. 12 o'clock is 0°, the hand turns clockwise
- The hand completes one rotation every 10 s (one sweep)
- Every stroke point has an angle from the center. The point is erased the next time the hand reaches that angle
- A stroke drawn just behind the hand lives almost a full sweep. A stroke drawn just ahead of it is gone instantly
- Behind the hand, ink glows at full brightness and dims toward the hand's return (radar afterglow)

### Math

- Hand angle: `h(t) = 360 × (t mod P) / P`, with `P = 10 s`
- Point alpha: `a = 1 − ((h(t) − θ) mod 360) / 360`, where `θ` is the point's angle
- Render alpha: map `a` from `1.0 → 0.25`, then hard cut to 0 at the hand
- Points within `r < 0.05` of the center use `θ = 0`
- Stateless per point and frame-rate independent: replay is a pure function of the recorded strokes and the clock

### What it does to play

- Drawers chase the hand: draw in the wake, re-trace each element as the hand comes back
- The full picture is never on screen at once; guessers assemble it across sweeps
- A 60 s session is six sweeps, so each element is typically redrawn 3–6 times. Simple, bold shapes win
- Drawer-only aid: a faint 8% ghost of erased strokes stays visible while drawing so re-tracing lines up. The ghost is never in the replay

---

## ☐ 4 · Game loop

```
Feed card → Watch sweep → Tap hot spot → Guess
      ▲                                    │
      │                      wrong: 1-sweep lockout → Guess
      │                                    │
      │                                 Solve → stamp on wall, comment posts
      │                                    │
      │                       Baton offered (10 min) → Accept / Pass
      │                                    │
      │                            Draw (6 sweeps) → Post next link
      └────────── others watch your post ──┘
```

- **Guess loop (30–90 s):** open a post, watch the sweep, mark a hot spot, guess. Points slide from 100 to 10 over your first minute on the post
- **Draw loop (90 s):** pick one of three words, draw for six sweeps, preview, post. Your post is the next link
- **Community loop (hours to days):** bounties grow on unsolved links, the baton passes or falls open, the chain lengthens, the weekly board ranks solvers and drawers

---

## ☐ 5 · A session, as the player sees it

You're scrolling r/sweep on your phone. A dark circle glows with a green hand turning slowly. The card reads *Chain #48 · drawn by u/marbles · Bounty 230 · 0 solved*. You tap Guess.

The hand sweeps. Behind it, strokes bloom and dim — a tall tower, a cone of light, three waves — and the hand wipes them as it comes around. Nine letters. Your points are already sliding down from 100. You tap the spot where the beam was and type *lighthouse*.

Solved in 19 s. +72 points, and the 230 bounty is yours: you cracked it. Your name stamps onto the clock face as solver #1, and a comment lands in the thread.

Then: *You hold the baton · draw the next word · 9:58*. Three words: Sunrise, Snooze, Jet lag. You pick Snooze. Sixty seconds. You draw a bed behind the hand; the hand sweeps and the bed is gone; you draw it again, add three Zs, add a fist slamming an alarm clock. Done at 47 s. Preview. Post.

#49 is live in the sub with your name on it. You go back to scrolling. Three minutes later a comment appears: *u/tinyoak solved #49 in 31 s*.

---

## ☐ 6 · Systems

### Drawing

- One brush, three inks (green, amber, white), fixed width tuned for thumbs
- Strokes recorded as `[x, y, t]` points, coordinates quantized to 0–1000 inside the unit circle, `t` in ms from session start
- No undo: the hand is the eraser
- Done button available after 2 sweeps; hard stop at 6
- Cap: 5,000 points per drawing (server rejects more)

### Replay and wall-clock sync

- Replay re-simulates the hand and afterglow from the stroke data; it is deterministic and identical for everyone
- Replay length = session length, looping
- Loop phase is tied to server time: `loopStart = floor(serverNow / L) × L`. Everyone on the post sees the same frame at the same moment
- Client fetches a server-time offset once on open

### Guessing and validation

- Word never leaves the server. The client receives only letter count and category
- One hot-spot tap required before the first guess on a post
- Normalize: lowercase, trim, strip punctuation and spaces
- Accept: exact match, singular/plural, or edit distance ≤ 1 for words of 6+ letters
- Wrong guess: lockout for 1 sweep; from the third wrong guess, 2 sweeps. Hard cap 20 guesses per post per user
- Lockout is enforced server-side with a timestamp in Redis

### Scoring and bounty

- Solver score `S = max(10, 100 − 90 × elapsed / 60)`, elapsed measured from the player's first open of the post
- First solver also takes the crack bounty
- Drawer earns `floor(S / 2)` per solve, for the first 50 solves
- Word tier bonus for the drawer: easy +0%, medium +10%, hard +25%
- Crack bounty: +10 per hour unsolved, +10 per post upvote, cap 500. Resets to 0 on first solve and shows *Cracked by u/x · took 14h 02m*

### Hot spots and heat

- The one required tap is stored as a cell on a 24 × 24 grid
- Heat map overlay toggles on the replay: where everyone looked, with zero spoilers
- The solver's tap becomes their stamp position on the wall

### Baton and chain

- On solve, if the post has no next link and nobody holds the baton, the solver is offered it with a 10-minute countdown
- First accept wins; other offers close. Pass or timeout moves the offer to the next solver
- No solve for 6 h, or no next link 24 h after creation: the baton falls open. A *Draw next* button appears for everyone; tapping it locks the baton for 10 minutes
- Each post stores `prev`, `next`, chain number, and chain start time. The chain tab shows *Chain alive 4d 3h · 38 links*
- Mod menu action *Start a chain* creates a seed post with an open baton and no drawing. This solves cold start

### Words

- Curated bank of about 150 time-themed words in three tiers
- Easy: clock, alarm, sunrise, candle, calendar
- Medium: deadline, hourglass, snooze, stopwatch, eclipse
- Hard: jet lag, procrastination, leap year, time capsule, rush hour
- Drawer picks one of three (one per tier). Guessers see letter pattern and category

### Reddit integration

- Comments, throttled to avoid spam: first solve, crack, every 10th solve, and when the next link is drawn
- Upvotes polled hourly into the bounty
- Post title set at creation: *SWEEP #48 · drawn by u/marbles · solve it*
- Feed card: Devvit splash with heading, link number, and drawer; live bounty appears on open. Dynamic splash text is a stretch goal
- Stretch: user flair such as *#48 drawer* or *12 solves*

---

## ☐ 7 · Screens

- **0 · First open:** three swipe cards — hand erases, points decay, solve to draw next. Skippable
- **1 · Feed card:** glowing clock, chain number, drawer, bounty, solve count
- **2 · Replay:** sweep playing, letter pattern, points bar, watchers count, heat toggle, guess input
- **3 · Solved:** time, points, bounty, solver number, stamp animation, baton offer with countdown
- **4 · Draw:** word, sweep ring, three inks, Done
- **5 · Post:** 5-second preview, post button, chain tag
- **6 · Post tabs:** Wall (solvers in order), Heat, Chain (prev / next)
- **7 · Weekly board:** top solvers, top drawers, biggest bounty broken, longest chain

---

## ☐ 8 · Art and audio

### Visual

- Radar phosphor: near-black navy field, thin ring grid, 12 tick marks, green hand with a soft trailing wedge
- Inks: phosphor green, amber, white — all readable on the field and distinguishable for colorblind players
- Portrait: square canvas on top, input below. Landscape: canvas left, wall right
- Tap targets 44 px minimum; no hover states

### Audio

- Soft tick each second; whoosh as the hand erases ink
- Decay tick accelerates in the last 20% of the points bar
- Solve chime, lockout clunk, baton bell
- One music loop whose length equals one sweep, so the music and the hand stay locked
- All SFX synthesized during the jam; any font or library listed in the submission

---

## ☐ 9 · Technical design

### Stack

- Devvit Web starter template (TypeScript)
- Client: vanilla TS + Canvas 2D. A circle, strokes, and a hand do not need a framework
- Server: `@devvit/web/server` endpoints, Redis, scheduler, Reddit API
- Realtime: one channel per post for watcher count and solve events; 10 s polling fallback

### Data model (Redis)

- `post:{id}` hash — word, tier, category, drawerId, drawerName, chainNo, prev, next, createdAt, status (open / live / cracked / flagged), solveCount, bounty, batonHolder, batonExpiresAt, replayLength
- `post:{id}:strokes` string — quantized JSON, ~30 KB typical
- `post:{id}:solvers` sorted set — score = solve time, gives wall order
- `post:{id}:heat` hash — grid cell → count
- `post:{id}:user:{uid}` hash — opened at, guesses, lockoutUntil, hotSpot, solved
- `user:{uid}` hash — points, solves, draws, streak
- `board:{week}:solvers`, `board:{week}:drawers` sorted sets
- `chain:{n}` list — post ids in order

### Endpoints

- `GET /api/time` — server ms for clock sync
- `GET /api/post` — meta, strokes, letter pattern, bounty, watchers (never the word)
- `POST /api/hot` — `{cell}`
- `POST /api/guess` — `{guess}` → `{correct, points, bounty, lockoutUntil, solverNo}`
- `POST /api/baton/accept`, `POST /api/baton/pass`, `POST /api/baton/open`
- `GET /api/words` — three choices for the baton holder
- `POST /api/draw/submit` — `{strokes, length, wordChoice}` → creates next post, links chain
- `GET /api/board`
- `POST /api/report` — flags post, hides drawing until a mod clears it

### Scheduler

- Hourly: bounty tick and upvote poll for uncracked posts
- Per baton: expiry job at accept + 10 min
- Every 6 h: chain stall check → open batons
- Weekly: board rollover

### Security and integrity

- Word stored server-side only; all validation server-side
- Stroke payload validated: point count, coordinates inside the circle, monotonic timestamps within 60 s
- Guess rate limited by Redis lockout timestamps, not client timers
- One hot spot per user per post

---

## ☐ 10 · Production plan (48 h, 4 people)

### Roles

- **A · Client:** sweep renderer, draw capture, replay, guess UI
- **B · Server:** Redis model, endpoints, baton and chain, scheduler, Reddit API
- **C · UX and art:** all screens, radar style, feed splash, wall and heat tabs
- **D · Audio, words, QA, submission:** SFX and loop, word bank, test subreddit, playtests, description text

### Timeline

- **Sat night:** repo from template, playtest running on a test sub, tuning numbers agreed, word bank drafted. Publish a hello-world build to de-risk the pipeline early
- **Sun AM:** A sweep + draw + recording · B post model, create post, guess endpoint · C screens 2–4 in code · D SFX
- **Sun PM:** A replay + decay + guess UI · B baton, chain, hot spot, scoring · C solved screen, wall, chain tab · D playtest round 1, three internal chains
- **Sun night:** integration; first end-to-end chain on the test sub
- **Mon AM:** bounty + scheduler + realtime watchers · polish · mobile test in the Reddit iOS and Android apps · audio in
- **Mon PM:** freeze at T−4 h · publish · write description (how to play, timers, community features, assets, AI disclosure) · submit on Jamzo at T−2 h · buffer until 7 PM

### MVP

- Draw with the sweep → post → replay → guess → solve → baton → next post. Everything else is a layer

### Cut list, in order

- User flair
- Weekly board
- Wall-clock sync (replay starts on open instead)
- Realtime (polling only)
- Bounty (static display)
- Heat map (show tap count only)
- Word choice (random word)

---

## ☐ 11 · Risks

- **Chain deadlock** → open baton after 6 h, seed action for mods
- **Sweep too harsh for legibility** → `P` exposed as config; playtest at 8, 10, 12 s
- **Brute-force guessing** → server lockouts and the 20-guess cap
- **NSFW drawings** → report button hides instantly; mod clear; thick brush limits detail
- **Publishing friction on Devvit** → publish a build Saturday night, not Monday
- **Clock drift across devices** → server-time offset on open
- **Mobile webview performance** → point cap, requestAnimationFrame, devicePixelRatio capped at 2

---

## ☐ 12 · Submission checklist

- App published; test subreddit live with at least 5 links seeded by the team so judges see traces on arrival
- Description: three-line how-to-play, the timer table, the community features, asset list, AI disclosure
- Short GIF of the sweep on the Jamzo page
- Tagged for Best Mobile
- One team member on the Devvit Discord for last-hour issues

---

## ☐ 13 · Tuning table

| Parameter | Default | Range |
|---|---|---|
| Sweep period P | 10 s | 8–15 s |
| Draw session | 6 sweeps | 4–8 |
| Minimum session | 2 sweeps | — |
| Afterglow floor | 0.25 alpha | 0.15–0.4 |
| Drawer ghost | 0.08 alpha | 0–0.15 |
| Points | 100 → 10 over 60 s | 45–90 s |
| Lockout | 1 sweep, 2 after 3 wrong | — |
| Guess cap | 20 per post | 10–30 |
| Bounty | +10/h, +10/upvote, cap 500 | — |
| Baton window | 10 min | 5–15 min |
| Chain stall | 6 h | 3–12 h |
| Heat grid | 24 × 24 | 16–32 |
| Max points per drawing | 5,000 | — |
