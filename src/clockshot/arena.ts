/**
 * The Clockshot arenas.
 *
 * Each arena is described as data, so a layout can be read and retuned in one
 * place rather than being buried in scene code. Static geometry never changes —
 * players learn it — while pickups and patrols shift with the run seed so
 * repeated runs still ask a slightly different question.
 *
 * There are three, and the whole community plays the same one for the length of
 * a round (see `arenaIndexAt` in `shared/config.ts`). That keeps every score in
 * a round comparable while stopping a single layout from being solved and then
 * run on rails forever.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Anchor {
  x: number;
  y: number;
}

export interface Patrol {
  x: number;
  y: number;
  from: number;
  to: number;
  speed: number;
}

/**
 * Two rewards, not three.
 *
 * Both put seconds back on the clock: `clock` is the bread of the arena and
 * `golden` is the one detour worth breaking your line for. There is nothing
 * else to pick up, because there is nothing else time can be spent on.
 */
export type PickupKind = 'clock' | 'golden';

export interface Pickup {
  x: number;
  y: number;
  kind: PickupKind;
}

/** Everything one arena is. Nothing here is behaviour; it is all layout. */
export interface Arena {
  id: string;
  /** Shown on the menu so a round has a name people can talk about. */
  name: string;
  /** One line telling a player what this place asks of them. */
  blurb: string;
  /**
   * How hard this place is to clear, one to five.
   *
   * A hand-set label rather than a measurement: it is what the splash card
   * shows a player who has never opened the game, before there is any clear
   * rate to read it from.
   */
  difficulty: 1 | 2 | 3 | 4 | 5;
  world: { width: number; height: number };
  /** Solid ground. Gaps between these are pits the player can fall through. */
  platforms: readonly Rect[];
  /** Grapple points. Only anchors *above* the player can be taken. */
  anchors: readonly Anchor[];
  /** Spike strips. Visible, on solid ground, never in a blind landing. */
  hazards: readonly Rect[];
  /** Somewhere safe to come back to after a fall. */
  respawns: readonly Anchor[];
  spawn: Anchor;
  /**
   * Safety net, laid along the route between spawn and goal.
   *
   * Each one arms the first time it is touched, and only the first time: it
   * records where you were and what your clock read at that instant, and an
   * out-of-time restart puts you back exactly there. Re-touching does nothing,
   * which is what stops a player topping a checkpoint up with a fatter clock
   * and then dying on purpose to keep it.
   */
  checkpoints: readonly Anchor[];
  /**
   * Where the run ends.
   *
   * Deliberately the far side of the arena from `spawn`: the whole run is the
   * journey between these two points, and everything else is what you pick up
   * on the way.
   */
  goal: Anchor;
  /** Fragment trails, laid along the routes worth taking. */
  trails: readonly (readonly Anchor[])[];
  /** Fragments slightly off the safe line: a small detour, never a new rule. */
  offLine: readonly Anchor[];
  /** Candidate spots for the one golden clock. */
  golden: readonly Anchor[];
  patrols: readonly Patrol[];
}

/** Below the world by this much and the player has left the arena. */
const KILL_MARGIN = 120;

export function killYOf(arena: Arena): number {
  return arena.world.height + KILL_MARGIN;
}

/* -------------------------------------------------------------------------- */
/* 1 · The Gantry — the original. Islands, pits, and a climb up the left wall. */
/* -------------------------------------------------------------------------- */

const GANTRY: Arena = {
  id: 'gantry',
  name: 'THE GANTRY',
  blurb: 'three islands, two pits, a long high crossing',
  difficulty: 2,
  world: { width: 1800, height: 1500 },

  platforms: [
    // Ground, deliberately broken into three islands.
    { x: 0, y: 1380, w: 520, h: 120 },
    { x: 700, y: 1380, w: 380, h: 120 },
    { x: 1280, y: 1380, w: 520, h: 120 },

    // Mid-height route across the arena.
    { x: 180, y: 1150, w: 220, h: 28 },
    { x: 520, y: 1000, w: 200, h: 28 },
    { x: 880, y: 1080, w: 200, h: 28 },
    { x: 1180, y: 920, w: 220, h: 28 },
    { x: 1450, y: 1120, w: 240, h: 28 },

    // The vertical section: a ladder of ledges up the left wall.
    { x: 60, y: 980, w: 170, h: 24 },
    { x: 60, y: 800, w: 170, h: 24 },
    { x: 60, y: 620, w: 170, h: 24 },
    { x: 60, y: 440, w: 170, h: 24 },

    // A high perch on the right, only reachable by swinging.
    { x: 1520, y: 560, w: 220, h: 24 },
    { x: 1120, y: 380, w: 200, h: 24 },
  ],

  anchors: [
    { x: 300, y: 150 },
    { x: 520, y: 150 },
    { x: 740, y: 150 },
    { x: 960, y: 150 },
    { x: 1180, y: 150 },
    { x: 1400, y: 150 },
    { x: 1620, y: 150 },

    { x: 420, y: 420 },
    { x: 860, y: 400 },
    { x: 1300, y: 430 },

    { x: 640, y: 680 },
    { x: 1080, y: 660 },
    { x: 1520, y: 820 },
    { x: 260, y: 700 },

    // The low row. Without these the grapple is unusable from the ground — the
    // next rank up is out of range from every spawn — and the two pits have no
    // crossing at all. These are what make the arena a swinging arena rather
    // than a platformer with a rope you can only reach after climbing.
    { x: 420, y: 1000 },
    { x: 610, y: 940 },
    { x: 830, y: 1010 },
    { x: 1180, y: 960 },
    { x: 1430, y: 1010 },
  ],

  hazards: [
    // Nothing on the spawn island. A new player used to meet their first spike
    // strip 140px from the spawn point — 0.44s of walking right — which taught
    // punishment before it had taught a single verb. The island is now a place
    // to run, collect, and find the rope.
    { x: 900, y: 1348, w: 110, h: 32 },
    { x: 1520, y: 1348, w: 150, h: 32 },
    { x: 560, y: 972, w: 120, h: 28 },
    { x: 1240, y: 892, w: 110, h: 28 },
  ],

  respawns: [
    { x: 200, y: 1320 },
    { x: 880, y: 1320 },
    { x: 1400, y: 1320 },
  ],

  spawn: { x: 160, y: 1300 },
  // The high right perch: no way there but a swing.
  goal: { x: 1630, y: 520 },
  checkpoints: [
    // All clear of the spike strips: you restart *standing* on these, so a
    // checkpoint beside a hazard would take the clock straight back off you.
    { x: 800, y: 1320 },
    { x: 980, y: 1050 },
    { x: 1560, y: 1090 },
  ],

  trails: [
    // The opening. Flat ground, no hazard, five clocks in a row: the first thing
    // a new player does is run right and score, and the trail walks them to the
    // edge of the first pit where the low anchor is already in grapple range.
    [
      { x: 240, y: 1330 },
      { x: 310, y: 1330 },
      { x: 380, y: 1330 },
      { x: 450, y: 1320 },
      { x: 505, y: 1290 },
    ],
    // Arc across the first pit — only reachable on a swing.
    [
      { x: 540, y: 1200 },
      { x: 600, y: 1120 },
      { x: 660, y: 1080 },
      { x: 720, y: 1120 },
    ],
    // Up the vertical section.
    [
      { x: 145, y: 930 },
      { x: 145, y: 750 },
      { x: 145, y: 570 },
      { x: 145, y: 390 },
    ],
    // The long high crossing.
    [
      { x: 500, y: 300 },
      { x: 640, y: 260 },
      { x: 780, y: 240 },
      { x: 920, y: 250 },
      { x: 1060, y: 280 },
    ],
    // Over the second pit.
    [
      { x: 1110, y: 1180 },
      { x: 1180, y: 1100 },
      { x: 1250, y: 1140 },
    ],
    // Along the mid route.
    [
      { x: 260, y: 1100 },
      { x: 340, y: 1090 },
      // Clear of the spike strip at x 560-680: this used to sit 22px above the
      // tips, so collecting it meant taking the hit.
      { x: 705, y: 950 },
      { x: 950, y: 1030 },
      { x: 1370, y: 870 },
      { x: 1560, y: 1070 },
    ],
  ],

  offLine: [
    { x: 660, y: 900 },
    { x: 1350, y: 700 },
    { x: 145, y: 300 },
    { x: 1620, y: 500 },
    { x: 860, y: 560 },
    { x: 400, y: 620 },
  ],

  golden: [
    { x: 900, y: 210 },
    { x: 1210, y: 300 },
    { x: 620, y: 330 },
  ],

  patrols: [
    { x: 290, y: 1120, from: 190, to: 390, speed: 55 },
    { x: 980, y: 1050, from: 890, to: 1070, speed: 65 },
    { x: 1290, y: 890, from: 1190, to: 1390, speed: 70 },
    { x: 1570, y: 1090, from: 1460, to: 1680, speed: 60 },
    { x: 1220, y: 350, from: 1130, to: 1310, speed: 80 },
    { x: 145, y: 590, from: 70, to: 220, speed: 50 },
  ],
};

/* -------------------------------------------------------------------------- */
/* 2 · The Well — a tall shaft. The whole run is one climb.                    */
/* -------------------------------------------------------------------------- */

/**
 * Narrow and tall, with an unbroken floor.
 *
 * There is no pit to fall into, which sounds forgiving and is not: everything
 * worth having is at the top, so falling costs the climb. Ledges alternate
 * walls so the natural route zig-zags, and the anchors run up the middle in a
 * ladder — each one is reachable from the last, and from nowhere else.
 */
const WELL: Arena = {
  id: 'well',
  name: 'THE WELL',
  blurb: 'one shaft, straight up — the prize is at the top',
  difficulty: 3,
  world: { width: 1100, height: 2200 },

  platforms: [
    // An unbroken floor. Falling costs height, not a life.
    { x: 0, y: 2080, w: 1100, h: 120 },

    { x: 120, y: 1860, w: 200, h: 26 },
    { x: 640, y: 1720, w: 220, h: 26 },
    { x: 180, y: 1560, w: 200, h: 26 },
    { x: 700, y: 1400, w: 200, h: 26 },
    { x: 140, y: 1240, w: 220, h: 26 },
    { x: 660, y: 1080, w: 220, h: 26 },
    { x: 200, y: 920, w: 200, h: 26 },
    { x: 680, y: 760, w: 200, h: 26 },
    { x: 260, y: 600, w: 220, h: 26 },
    { x: 700, y: 440, w: 200, h: 26 },

    // The crown. Everything expensive lives up here.
    { x: 380, y: 280, w: 300, h: 26 },
  ],

  anchors: [
    // Reachable from the floor, so the climb can start without a jump puzzle.
    { x: 300, y: 1780 },
    { x: 800, y: 1700 },

    { x: 250, y: 1600 },
    { x: 820, y: 1500 },
    { x: 300, y: 1320 },
    { x: 800, y: 1180 },
    { x: 280, y: 1000 },
    { x: 820, y: 860 },
    { x: 340, y: 680 },
    { x: 800, y: 520 },

    { x: 520, y: 340 },
    { x: 520, y: 170 },
  ],

  hazards: [
    { x: 660, y: 1694, w: 120, h: 26 },
    { x: 190, y: 1214, w: 110, h: 26 },
    { x: 690, y: 734, w: 110, h: 26 },
  ],

  respawns: [
    { x: 160, y: 2020 },
    { x: 550, y: 2020 },
    { x: 940, y: 2020 },
  ],

  spawn: { x: 120, y: 2020 },
  // The crown, at the very top of the shaft.
  goal: { x: 530, y: 240 },
  checkpoints: [
    { x: 820, y: 1690 },
    { x: 770, y: 1370 },
    { x: 850, y: 730 },
  ],

  trails: [
    // The opening, along the floor and up to the first ledge.
    [
      { x: 230, y: 2040 },
      { x: 310, y: 2040 },
      { x: 390, y: 2030 },
      { x: 460, y: 2000 },
      { x: 520, y: 1950 },
    ],
    // The zig-zag, one clock per landing.
    [
      { x: 210, y: 1820 },
      { x: 820, y: 1680 },
      { x: 270, y: 1520 },
      { x: 790, y: 1360 },
    ],
    [
      { x: 330, y: 1200 },
      { x: 760, y: 1040 },
      { x: 290, y: 880 },
      { x: 840, y: 720 },
    ],
    // The last stretch, out over the middle of the shaft.
    [
      { x: 430, y: 560 },
      { x: 520, y: 500 },
      { x: 610, y: 470 },
    ],
  ],

  offLine: [
    { x: 950, y: 1900 },
    { x: 90, y: 1420 },
    { x: 960, y: 1300 },
    { x: 90, y: 780 },
    { x: 950, y: 600 },
    { x: 520, y: 1240 },
  ],

  golden: [
    { x: 470, y: 230 },
    { x: 590, y: 230 },
    { x: 530, y: 130 },
  ],

  patrols: [
    { x: 220, y: 1830, from: 130, to: 310, speed: 55 },
    { x: 750, y: 1690, from: 650, to: 850, speed: 60 },
    { x: 250, y: 1210, from: 150, to: 350, speed: 65 },
    { x: 760, y: 1050, from: 670, to: 870, speed: 70 },
    { x: 300, y: 890, from: 210, to: 390, speed: 60 },
    { x: 520, y: 250, from: 390, to: 660, speed: 85 },
  ],
};

/* -------------------------------------------------------------------------- */
/* 3 · The Span — wide and low. One long chasm to get across.                  */
/* -------------------------------------------------------------------------- */

/**
 * Almost no ground and a great deal of air.
 *
 * The Gantry rewards learning a route; the Span rewards not stopping. There is
 * a chain of small islands across the middle, but the fast line never touches
 * them — it is one continuous sequence of swings along the low anchor row, and
 * the only real punishment is the chasm underneath.
 */
const SPAN: Arena = {
  id: 'span',
  name: 'THE SPAN',
  blurb: 'wide open, barely any floor — keep your speed',
  difficulty: 4,
  world: { width: 2600, height: 900 },

  platforms: [
    { x: 0, y: 780, w: 520, h: 120 },

    // Stepping stones. Optional, and slower than swinging past them.
    { x: 760, y: 700, w: 140, h: 24 },
    { x: 1080, y: 640, w: 140, h: 24 },
    { x: 1400, y: 700, w: 140, h: 24 },
    { x: 1720, y: 620, w: 150, h: 24 },

    { x: 2060, y: 780, w: 540, h: 120 },

    // Upper ledges, for anyone who gains real height.
    { x: 600, y: 420, w: 180, h: 24 },
    { x: 1200, y: 340, w: 200, h: 24 },
    { x: 1850, y: 400, w: 180, h: 24 },
  ],

  anchors: [
    // The high row: the fast, committed line.
    { x: 300, y: 140 },
    { x: 620, y: 140 },
    { x: 940, y: 140 },
    { x: 1260, y: 140 },
    { x: 1580, y: 140 },
    { x: 1900, y: 140 },
    { x: 2220, y: 140 },

    { x: 460, y: 470 },
    { x: 920, y: 440 },
    { x: 1380, y: 460 },
    { x: 1840, y: 430 },
    { x: 2260, y: 470 },

    // The low row, reachable standing on either ground.
    { x: 300, y: 520 },
    { x: 660, y: 540 },
    { x: 1000, y: 500 },
    { x: 1340, y: 540 },
    { x: 1680, y: 480 },
    { x: 2020, y: 520 },
    { x: 2340, y: 540 },
  ],

  hazards: [
    { x: 340, y: 756, w: 120, h: 24 },
    { x: 1080, y: 616, w: 70, h: 24 },
    { x: 2200, y: 756, w: 150, h: 24 },
  ],

  respawns: [
    { x: 150, y: 720 },
    { x: 1180, y: 590 },
    { x: 2300, y: 720 },
  ],

  spawn: { x: 90, y: 720 },
  // The far ground, all the way across the chasm.
  goal: { x: 2400, y: 720 },
  checkpoints: [
    { x: 830, y: 670 },
    { x: 1470, y: 670 },
  ],

  trails: [
    // The opening, on the safe half of the left ground.
    [
      { x: 160, y: 730 },
      { x: 230, y: 730 },
      { x: 300, y: 720 },
    ],
    // Out over the chasm — the whole point of the place.
    [
      { x: 560, y: 640 },
      { x: 660, y: 600 },
      { x: 760, y: 620 },
      { x: 870, y: 590 },
      { x: 980, y: 560 },
    ],
    [
      { x: 1180, y: 560 },
      { x: 1300, y: 600 },
      { x: 1430, y: 620 },
      { x: 1560, y: 580 },
      { x: 1690, y: 540 },
    ],
    // The high line, for anyone who kept their speed.
    [
      { x: 700, y: 260 },
      { x: 900, y: 230 },
      { x: 1100, y: 220 },
      { x: 1300, y: 230 },
      { x: 1500, y: 260 },
    ],
    // The run in to the far ground.
    [
      { x: 1880, y: 560 },
      { x: 2000, y: 620 },
      { x: 2120, y: 700 },
      { x: 2240, y: 730 },
    ],
  ],

  offLine: [
    { x: 690, y: 380 },
    { x: 1290, y: 300 },
    { x: 1930, y: 360 },
    { x: 2450, y: 620 },
    { x: 830, y: 660 },
    { x: 1470, y: 660 },
  ],

  golden: [
    { x: 1300, y: 90 },
    { x: 940, y: 90 },
    { x: 1620, y: 100 },
  ],

  patrols: [
    { x: 200, y: 720, from: 60, to: 300, speed: 60 },
    { x: 690, y: 660, from: 620, to: 780, speed: 65 },
    { x: 1270, y: 300, from: 1180, to: 1370, speed: 80 },
    { x: 1470, y: 660, from: 1400, to: 1560, speed: 70 },
    { x: 1930, y: 360, from: 1850, to: 2010, speed: 75 },
    { x: 2350, y: 720, from: 2200, to: 2520, speed: 60 },
  ],
};

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

export const ARENAS: readonly Arena[] = [GANTRY, WELL, SPAN] as const;

/** The arena for an index, clamped so a bad index can never break a run. */
export function arenaAt(index: number): Arena {
  const i = Number.isFinite(index) ? Math.abs(Math.floor(index)) % ARENAS.length : 0;
  return ARENAS[i] ?? GANTRY;
}

/* -------------------------------------------------------------------------- */
/* Seeded variation                                                           */
/* -------------------------------------------------------------------------- */

/** Small deterministic PRNG so a seed always rebuilds the same arena. */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ArenaLayout {
  pickups: Pickup[];
  patrols: Patrol[];
}

/**
 * Builds one run's pickups and patrols for an arena.
 *
 * The trails are fixed so a place stays learnable; the seed decides which of
 * the risky slots are live this time, so there is always a reason to look
 * around rather than run the same line every time.
 */
export function buildLayout(arena: Arena, seed: number): ArenaLayout {
  const rand = rng(seed);
  const pickups: Pickup[] = [];

  for (const trail of arena.trails) {
    for (const p of trail) pickups.push({ x: p.x, y: p.y, kind: 'clock' });
  }

  for (const slot of arena.offLine) {
    if (rand() < 0.75) pickups.push({ ...slot, kind: 'clock' });
  }

  // One golden clock per run, always worth the detour. A player-built arena
  // may have chosen not to have one at all, which is a level with no detour
  // rather than a level that fails to load.
  const golden = arena.golden[Math.floor(rand() * arena.golden.length)] ?? arena.golden[0];
  if (golden) pickups.push({ ...golden, kind: 'golden' });

  const patrols = arena.patrols.filter(() => rand() < 0.88).map((p) => ({ ...p }));

  return { pickups, patrols };
}

/** Centre point of a rect, which is what Phaser bodies want. */
export function centreOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
