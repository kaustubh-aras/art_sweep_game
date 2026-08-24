/**
 * The shape of a player-made arena.
 *
 * The three shipped arenas in `arena.ts` are hand-written data: rectangles at
 * arbitrary pixel positions, trails laid by eye, patrols tuned one at a time.
 * None of that is something a person can do with a thumb, so a built level is
 * a different thing entirely — a coarse grid of cells, one piece to a cell,
 * with everything else derived.
 *
 * The grid is the only format the editor ever touches. `toArena` turns it into
 * the same `Arena` the shipped levels are, which is what lets a custom level be
 * played by exactly the code that plays the real ones — no second renderer, no
 * second physics path, no way for a built level to behave differently from a
 * designed one.
 */

import type { Anchor, Arena, Patrol, Rect } from './arena';
import { C } from './theme';
import {
  BUDGET_TOTAL,
  CELL,
  COLS,
  PIECE_RULES,
  ROWS,
  WORLD,
  budgetOf,
  countKind,
  inBounds,
  levelProblem,
  type BuildLevel,
  type BuildPiece,
  type Cell,
  type PieceKind,
} from '@/shared/level';

// Re-exported so the editor and the scenes keep importing the level model from
// one place. The rules live in `shared` because the server enforces them too.
export {
  BUDGET_TOTAL,
  CELL,
  COLS,
  ROWS,
  WORLD,
  budgetOf,
  countKind,
  inBounds,
  levelProblem,
  type BuildLevel,
  type BuildPiece,
  type Cell,
  type PieceKind,
};




/** The two singletons. They are placed, never counted, and never deleted. */
export type Tool = PieceKind | 'spawn' | 'goal';




export interface PieceMeta {
  label: string;
  /** The one line the palette shows under the name. */
  hint: string;
  cost: number;
  /** Hard limit on how many of these one level may hold, or null for none. */
  cap: number | null;
  color: number;
}

/**
 * What each piece looks like in the palette.
 *
 * Cost and cap are folded in from `PIECE_RULES` rather than written twice —
 * they are rules the server enforces, and a palette that disagreed with the
 * publish endpoint would let a builder spend a budget they do not have.
 */
const PIECE_ART: Record<PieceKind, { label: string; hint: string; color: number }> = {
  block: { label: 'BLOCK', hint: 'solid', color: C.platformTop },
  anchor: { label: 'ANCHOR', hint: 'swing', color: C.cyan },
  clock: { label: 'CLOCK', hint: '+2s', color: C.gold },
  golden: { label: 'GOLDEN', hint: '+5s', color: C.gold },
  checkpoint: { label: 'CHECK', hint: 'restart', color: C.goal },
  spike: { label: 'SPIKE', hint: '-2s', color: C.danger },
  enemy: { label: 'ENEMY', hint: '-2s', color: C.danger },
};

export const PIECES: Record<PieceKind, PieceMeta> = Object.fromEntries(
  Object.entries(PIECE_ART).map(([kind, art]) => [
    kind,
    { ...art, ...PIECE_RULES[kind as PieceKind] },
  ]),
) as Record<PieceKind, PieceMeta>;

/** Palette order: build the ground first, then the route, then the danger. */
export const PALETTE_ORDER: readonly PieceKind[] = [
  'block',
  'anchor',
  'clock',
  'golden',
  'checkpoint',
  'spike',
  'enemy',
] as const;

/* -------------------------------------------------------------------------- */
/* Reading a level                                                            */
/* -------------------------------------------------------------------------- */

export function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

export function pieceAt(level: BuildLevel, x: number, y: number): BuildPiece | undefined {
  return level.pieces.find((p) => p.x === x && p.y === y);
}

/** True when a cell already holds something — a piece, the spawn, or the goal. */
export function occupied(level: BuildLevel, c: Cell): boolean {
  return !!pieceAt(level, c.x, c.y) || sameCell(level.spawn, c) || sameCell(level.goal, c);
}

export function cloneLevel(level: BuildLevel): BuildLevel {
  return {
    ...level,
    spawn: { ...level.spawn },
    goal: { ...level.goal },
    pieces: level.pieces.map((p) => ({ ...p })),
  };
}

/**
 * Why this level cannot be played yet, or null when it can.
 *
 * Deliberately short. The editor cannot tell whether a route exists — that is
 * what the test run is for — so it only refuses the things that would break the
 * game rather than merely make it hard.
 */
export function validate(level: BuildLevel): string | null {
  if (sameCell(level.spawn, level.goal)) return 'Spawn and goal are in the same place';
  // Everything else is the server's rule set, asked here so a builder is told
  // the same sentence the publish endpoint would have told them.
  return levelProblem(level);
}

/* -------------------------------------------------------------------------- */
/* Making a level                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Ids are made from the clock and a random tail rather than a counter, because
 * nothing here is a database: two levels only need to not collide inside one
 * browser's storage.
 */
export function newId(): string {
  return `lvl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * The level a builder starts from.
 *
 * Not an empty grid. A floor, a spawn on it, a goal at the far end and a rank
 * of anchors in between is the smallest thing that is already a game — so the
 * first thing a new builder can do is press TEST and watch it work, then start
 * changing it.
 */
export function starterLevel(name = 'MY ARENA'): BuildLevel {
  const floorRow = ROWS - 3;
  const pieces: BuildPiece[] = [];

  for (let x = 0; x < 8; x++) pieces.push({ x, y: floorRow, kind: 'block' });
  for (let x = COLS - 8; x < COLS; x++) pieces.push({ x, y: floorRow, kind: 'block' });

  // A rank of anchors across the gap, low enough to be taken from the ground.
  for (const x of [9, 14, 19, 24]) pieces.push({ x, y: floorRow - 6, kind: 'anchor' });

  // Something to collect on the way over, so the crossing pays.
  for (const x of [11, 16, 21]) pieces.push({ x, y: floorRow - 3, kind: 'clock' });

  return {
    v: 1,
    id: newId(),
    name,
    spawn: { x: 2, y: floorRow - 1 },
    goal: { x: COLS - 3, y: floorRow - 1 },
    pieces,
    updatedAt: Date.now(),
    verifiedMs: null,
  };
}

/** Accepts anything off storage and returns a level, or null if it is not one. */
export function reviveLevel(raw: unknown): BuildLevel | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Partial<BuildLevel>;
  if (o.v !== 1 || typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  if (!isCell(o.spawn) || !isCell(o.goal) || !Array.isArray(o.pieces)) return null;

  const pieces: BuildPiece[] = [];
  for (const p of o.pieces) {
    if (!isCell(p)) continue;
    const kind = (p as BuildPiece).kind;
    if (typeof kind !== 'string' || !(kind in PIECES)) continue;
    const c = clampCell(p);
    pieces.push({ x: c.x, y: c.y, kind: kind as PieceKind });
  }

  return {
    v: 1,
    id: o.id,
    name: o.name.slice(0, 24),
    spawn: clampCell(o.spawn),
    goal: clampCell(o.goal),
    pieces,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
    verifiedMs: typeof o.verifiedMs === 'number' ? o.verifiedMs : null,
  };
}

function isCell(v: unknown): v is Cell {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Cell;
  return Number.isFinite(c.x) && Number.isFinite(c.y);
}

function clampCell(c: Cell): Cell {
  return {
    x: Math.min(COLS - 1, Math.max(0, Math.floor(c.x))),
    y: Math.min(ROWS - 1, Math.max(0, Math.floor(c.y))),
  };
}

/* -------------------------------------------------------------------------- */
/* Grid -> Arena                                                              */
/* -------------------------------------------------------------------------- */

/** The middle of a cell, in world units. Everything point-like sits here. */
export function centreOfCell(c: Cell): Anchor {
  return { x: (c.x + 0.5) * CELL, y: (c.y + 0.5) * CELL };
}

/**
 * Turns a built grid into a playable arena.
 *
 * The only interesting part is the merging: a row of eight block cells becomes
 * one 480-wide rectangle rather than eight 60-wide ones. That matters for more
 * than tidiness — abutting arcade bodies catch a moving player on their shared
 * seams, so a floor built cell by cell would trip anyone running along it.
 */
export function toArena(level: BuildLevel): Arena {
  const blocks = runsOf(level, 'block').map(
    (r): Rect => ({ x: r.x0 * CELL, y: r.y * CELL, w: (r.x1 - r.x0 + 1) * CELL, h: CELL }),
  );

  // Spikes are a strip on the floor of their cell, not a solid block: they are
  // something you land on and regret, never something you stand on.
  const hazards = runsOf(level, 'spike').map(
    (r): Rect => ({
      x: r.x0 * CELL + 4,
      y: (r.y + 1) * CELL - CELL * 0.45,
      w: (r.x1 - r.x0 + 1) * CELL - 8,
      h: CELL * 0.45,
    }),
  );

  const anchors = cellsOf(level, 'anchor').map(centreOfCell);
  const checkpoints = cellsOf(level, 'checkpoint').map(centreOfCell);
  const clocks = cellsOf(level, 'clock').map(centreOfCell);
  const golden = cellsOf(level, 'golden').map(centreOfCell);

  const spawn = centreOfCell(level.spawn);

  return {
    id: `build:${level.id}`,
    name: level.name.toUpperCase(),
    blurb: 'built by a player',
    difficulty: difficultyOf(level),
    world: { width: WORLD.width, height: WORLD.height },
    platforms: blocks,
    anchors,
    hazards,
    // Falling off the world puts a player back at the nearest safe point, and
    // the safe points are the two things the builder has said are safe.
    respawns: [spawn, ...checkpoints],
    spawn,
    goal: centreOfCell(level.goal),
    checkpoints,
    /**
     * Every clock in one trail.
     *
     * `buildLayout` places trail pickups unconditionally and rolls a die for
     * `offLine` ones. A built level uses only trails, so what the builder
     * placed is exactly what the player meets — a level small enough to be
     * built by hand is too small for half its clocks to be a surprise.
     */
    trails: clocks.length > 0 ? [clocks] : [],
    offLine: [],
    golden,
    patrols: patrolsOf(level),
  };
}

/** A level's own seed, so its layout is identical on every run. */
export function seedOf(level: BuildLevel): number {
  let h = 2166136261;
  for (let i = 0; i < level.id.length; i++) {
    h ^= level.id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Run {
  y: number;
  x0: number;
  x1: number;
}

/** Horizontal runs of one kind, row by row. */
function runsOf(level: BuildLevel, kind: PieceKind): Run[] {
  const rows = new Map<number, number[]>();
  for (const p of level.pieces) {
    if (p.kind !== kind) continue;
    const row = rows.get(p.y);
    if (row) row.push(p.x);
    else rows.set(p.y, [p.x]);
  }

  const runs: Run[] = [];
  for (const [y, xs] of rows) {
    xs.sort((a, b) => a - b);
    let x0 = xs[0]!;
    let prev = x0;
    for (let i = 1; i < xs.length; i++) {
      const x = xs[i]!;
      if (x !== prev + 1) {
        runs.push({ y, x0, x1: prev });
        x0 = x;
      }
      prev = x;
    }
    runs.push({ y, x0, x1: prev });
  }
  return runs;
}

function cellsOf(level: BuildLevel, kind: PieceKind): Cell[] {
  return level.pieces.filter((p) => p.kind === kind).map((p) => ({ x: p.x, y: p.y }));
}

/**
 * Each enemy patrols the ledge it was put on.
 *
 * The builder places one cell and gets a patrol whose ends are wherever the
 * ground beneath it stops — which is what they would have drawn anyway, and it
 * means an enemy can never march off into the air. With nothing underneath it
 * paces a short beat on the spot, so a floating enemy is still a hazard rather
 * than a bug.
 */
function patrolsOf(level: BuildLevel): Patrol[] {
  const solid = new Set<string>();
  for (const p of level.pieces) if (p.kind === 'block') solid.add(`${p.x},${p.y}`);

  return level.pieces
    .filter((p) => p.kind === 'enemy')
    .map((p): Patrol => {
      const below = p.y + 1;
      let x0 = p.x;
      let x1 = p.x;
      if (solid.has(`${p.x},${below}`)) {
        while (x0 > 0 && solid.has(`${x0 - 1},${below}`)) x0--;
        while (x1 < COLS - 1 && solid.has(`${x1 + 1},${below}`)) x1++;
      } else {
        x0 = Math.max(0, p.x - 2);
        x1 = Math.min(COLS - 1, p.x + 2);
      }
      const c = centreOfCell(p);
      return {
        x: c.x,
        y: c.y,
        from: (x0 + 0.5) * CELL,
        to: (x1 + 0.5) * CELL,
        speed: 62,
      };
    });
}

/**
 * A rough difficulty, shown wherever a level is listed.
 *
 * Danger raises it, time lowers it. Nobody plays a number, so this only has to
 * be roughly honest — it is a label on a shelf, not a rating.
 */
function difficultyOf(level: BuildLevel): 1 | 2 | 3 | 4 | 5 {
  const danger = countKind(level, 'spike') + countKind(level, 'enemy') * 2;
  const mercy = countKind(level, 'clock') + countKind(level, 'checkpoint') * 2;
  const score = 2 + danger / 6 - mercy / 10;
  return Math.min(5, Math.max(1, Math.round(score))) as 1 | 2 | 3 | 4 | 5;
}
