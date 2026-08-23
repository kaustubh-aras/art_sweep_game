/**
 * The Clockshot arena.
 *
 * One arena, described as data, so the layout can be read and retuned in one
 * place rather than being buried in scene code. The static geometry never
 * changes — players learn it — while pickups and patrols shift with the run
 * seed so repeated runs still ask a slightly different question.
 */

export const WORLD = { width: 1800, height: 1500 } as const;

/** Below this the player has left the arena and respawns. */
export const KILL_Y = WORLD.height + 120;

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

export type PickupKind = 'fragment' | 'large' | 'golden' | 'enemy';

export interface Pickup {
  x: number;
  y: number;
  kind: PickupKind;
}

/** Solid ground. Gaps between these are pits the player can fall through. */
export const PLATFORMS: readonly Rect[] = [
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
];

/**
 * Grapple points. The upper rows are what make the open middle crossable —
 * there is no floor route between the ground islands.
 */
export const ANCHORS: readonly Anchor[] = [
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
];

/** Spike strips. Visible, on top of solid ground, never in a blind landing. */
export const HAZARDS: readonly Rect[] = [
  { x: 300, y: 1348, w: 130, h: 32 },
  { x: 900, y: 1348, w: 110, h: 32 },
  { x: 1520, y: 1348, w: 150, h: 32 },
  { x: 560, y: 972, w: 120, h: 28 },
  { x: 1240, y: 892, w: 110, h: 28 },
];

/** Somewhere safe to come back to after a fall. */
export const RESPAWNS: readonly Anchor[] = [
  { x: 200, y: 1320 },
  { x: 880, y: 1320 },
  { x: 1400, y: 1320 },
];

export const SPAWN: Anchor = { x: 160, y: 1300 };

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

/** Fragment trails, laid along the routes worth taking. */
const TRAILS: readonly Anchor[][] = [
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
    { x: 600, y: 950 },
    { x: 950, y: 1030 },
    { x: 1260, y: 870 },
    { x: 1560, y: 1070 },
  ],
];

export interface ArenaLayout {
  pickups: Pickup[];
  patrols: Patrol[];
}

/**
 * Builds the run's pickups and patrols.
 *
 * The trails are fixed so the arena stays learnable; the seed decides which of
 * the risky slots are live this time, so there is always a reason to look
 * around rather than run the same line every time.
 */
export function buildLayout(seed: number): ArenaLayout {
  const rand = rng(seed);
  const pickups: Pickup[] = [];

  for (const trail of TRAILS) {
    for (const p of trail) pickups.push({ x: p.x, y: p.y, kind: 'fragment' });
  }

  // Large fragments sit slightly off the safe line.
  const largeSlots: Anchor[] = [
    { x: 660, y: 900 },
    { x: 1350, y: 700 },
    { x: 145, y: 300 },
    { x: 1620, y: 500 },
    { x: 860, y: 560 },
    { x: 400, y: 620 },
  ];
  for (const slot of largeSlots) {
    if (rand() < 0.75) pickups.push({ ...slot, kind: 'large' });
  }

  // One golden clock per run, high and central, always worth the detour.
  const goldenSlots: Anchor[] = [
    { x: 900, y: 210 },
    { x: 1210, y: 300 },
    { x: 620, y: 330 },
  ];
  const golden = goldenSlots[Math.floor(rand() * goldenSlots.length)] ?? goldenSlots[0]!;
  pickups.push({ ...golden, kind: 'golden' });

  // Enemy fragments — the ones that steal — are placed where they cost
  // something to reach, so stealing is a decision rather than a freebie.
  const enemySlots: Anchor[] = [
    { x: 430, y: 1330 },
    { x: 960, y: 1330 },
    { x: 1590, y: 1330 },
    { x: 1230, y: 340 },
    { x: 1600, y: 520 },
    { x: 145, y: 400 },
  ];
  for (const slot of enemySlots) {
    if (rand() < 0.7) pickups.push({ ...slot, kind: 'enemy' });
  }

  // Patrols run along platform tops, never over a pit, so an enemy is always
  // somewhere the player can actually fight it.
  const patrols: Patrol[] = [
    { x: 290, y: 1120, from: 190, to: 390, speed: 55 },
    { x: 980, y: 1050, from: 890, to: 1070, speed: 65 },
    { x: 1290, y: 890, from: 1190, to: 1390, speed: 70 },
    { x: 1570, y: 1090, from: 1460, to: 1680, speed: 60 },
    { x: 1220, y: 350, from: 1130, to: 1310, speed: 80 },
    { x: 145, y: 590, from: 70, to: 220, speed: 50 },
  ].filter(() => rand() < 0.88);

  return { pickups, patrols };
}

/** Centre point of a rect, which is what Phaser bodies want. */
export function centreOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
