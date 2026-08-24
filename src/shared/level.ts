/**
 * The wire contract for a player-built level.
 *
 * This lives in `shared` rather than in `clockshot/build.ts` because the server
 * has to be able to *disbelieve* a level. Everything the client sends is a
 * claim: the grid it says it built, the budget it says it spent, the clear time
 * it says it managed. A published level is stored and then handed to strangers,
 * so it is the one payload in the game that gets read back by someone other
 * than the person who wrote it — and an editor is exactly the surface where a
 * hand-written request would be aimed.
 *
 * So the rules that decide whether a level is *legal* live here, in a module
 * with no client imports and no `window`, and both sides use the same ones.
 * `build.ts` keeps what is only ever a client concern: labels, hints, colours,
 * the palette order the rail draws.
 */

/** World units to a grid cell. Sized so one cell is a comfortable landing. */
export const CELL = 60;
export const COLS = 30;
export const ROWS = 25;

export const WORLD = { width: COLS * CELL, height: ROWS * CELL } as const;

/**
 * What a builder may spend on one level.
 *
 * Costs are weighted so that the interesting pieces are the scarce ones: ground
 * is nearly free, and the things that change how a run is *routed* each land
 * somewhere around a hundred.
 */
export const BUDGET_TOTAL = 160;

export type PieceKind =
  | 'block'
  | 'anchor'
  | 'spike'
  | 'clock'
  | 'golden'
  | 'checkpoint'
  | 'enemy';

export const PIECE_KINDS: readonly PieceKind[] = [
  'block',
  'anchor',
  'spike',
  'clock',
  'golden',
  'checkpoint',
  'enemy',
] as const;

/** What each piece costs, and how many of it a level may hold. */
export const PIECE_RULES: Record<PieceKind, { cost: number; cap: number | null }> = {
  block: { cost: 1, cap: null },
  anchor: { cost: 3, cap: 26 },
  clock: { cost: 2, cap: 40 },
  golden: { cost: 8, cap: 1 },
  checkpoint: { cost: 5, cap: 4 },
  spike: { cost: 1, cap: 40 },
  enemy: { cost: 4, cap: 10 },
};

export interface Cell {
  x: number;
  y: number;
}

export interface BuildPiece extends Cell {
  kind: PieceKind;
}

/** One player-made level. This is exactly what is written to storage. */
export interface BuildLevel {
  /** Bumped whenever the shape below changes, so old saves can be dropped. */
  v: 1;
  id: string;
  name: string;
  spawn: Cell;
  goal: Cell;
  pieces: BuildPiece[];
  /**
   * The clock left when the author last cleared it, or null if they never have.
   *
   * This is what makes a level publishable: an arena nobody has finished is not
   * yet a level, and the person who built it is the one who should prove it.
   */
  verifiedMs: number | null;
  /** Bumped on every edit, so the shelf can show the most recent work first. */
  updatedAt: number;
}

/** Hard ceilings, so one level can never be large enough to be a denial of service. */
export const LEVEL_LIMITS = {
  /** Every cell filled would be 750; the budget stops long before this. */
  pieces: 900,
  nameChars: 24,
  /** Nobody clears a level with more clock than the tank could ever hold. */
  verifiedMs: 5 * 60 * 1000,
} as const;

export function inBounds(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < COLS && y < ROWS;
}

export function budgetOf(level: BuildLevel): number {
  return level.pieces.reduce((sum, p) => sum + (PIECE_RULES[p.kind]?.cost ?? 0), 0);
}

export function countKind(level: BuildLevel, kind: PieceKind): number {
  return level.pieces.reduce((n, p) => n + (p.kind === kind ? 1 : 0), 0);
}

/**
 * Parses an untrusted level off the wire.
 *
 * Deliberately paranoid, and deliberately *not* a type assertion: every field is
 * checked, every cell is bounds-checked, and anything unrecognised is dropped
 * rather than carried through. The returned object is freshly built from what
 * was verified, so nothing a caller sneaked in survives the trip.
 */
export function parseLevel(input: unknown): { ok: true; level: BuildLevel } | { ok: false; reason: string } {
  const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

  if (typeof input !== 'object' || input === null) return bad('Not a level');
  const raw = input as Record<string, unknown>;

  if (raw.v !== 1) return bad('Unsupported level version');

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, LEVEL_LIMITS.nameChars) : '';
  if (!name) return bad('The level needs a name');

  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64 ? raw.id : null;
  if (!id) return bad('Bad level id');

  const cell = (value: unknown): Cell | null => {
    if (typeof value !== 'object' || value === null) return null;
    const c = value as Record<string, unknown>;
    const x = Number(c.x);
    const y = Number(c.y);
    return inBounds(x, y) ? { x, y } : null;
  };

  const spawn = cell(raw.spawn);
  const goal = cell(raw.goal);
  if (!spawn) return bad('The spawn is off the grid');
  if (!goal) return bad('The goal is off the grid');
  if (spawn.x === goal.x && spawn.y === goal.y) return bad('Spawn and goal are in the same place');

  if (!Array.isArray(raw.pieces)) return bad('No pieces');
  if (raw.pieces.length > LEVEL_LIMITS.pieces) return bad('Too many pieces');

  const pieces: BuildPiece[] = [];
  const taken = new Set<string>();
  for (const entry of raw.pieces) {
    const at = cell(entry);
    const kind = (entry as Record<string, unknown> | null)?.kind;
    if (!at) return bad('A piece is off the grid');
    if (typeof kind !== 'string' || !PIECE_KINDS.includes(kind as PieceKind)) {
      return bad('Unknown piece');
    }
    // One piece to a cell, which the editor already enforces — so a level that
    // breaks it was not built by the editor.
    const key = `${at.x},${at.y}`;
    if (taken.has(key)) return bad('Two pieces in one cell');
    taken.add(key);
    pieces.push({ x: at.x, y: at.y, kind: kind as PieceKind });
  }

  const level: BuildLevel = {
    v: 1,
    id,
    name,
    spawn,
    goal,
    pieces,
    verifiedMs: null,
    updatedAt: Date.now(),
  };

  const verified = Number(raw.verifiedMs);
  if (Number.isFinite(verified) && verified > 0) {
    level.verifiedMs = Math.min(Math.round(verified), LEVEL_LIMITS.verifiedMs);
  }

  const problem = levelProblem(level);
  return problem ? bad(problem) : { ok: true, level };
}

/**
 * Why a level is not playable, or null when it is.
 *
 * Shared with the editor so the reason a builder is shown and the reason the
 * server gives are the same sentence.
 */
export function levelProblem(level: BuildLevel): string | null {
  if (level.pieces.length === 0) return 'Nothing built yet';
  if (countKind(level, 'block') === 0) return 'Place some ground to stand on';
  if (budgetOf(level) > BUDGET_TOTAL) return 'Over budget';

  for (const kind of PIECE_KINDS) {
    const cap = PIECE_RULES[kind].cap;
    if (cap !== null && countKind(level, kind) > cap) return `Too many ${kind}s`;
  }
  return null;
}
