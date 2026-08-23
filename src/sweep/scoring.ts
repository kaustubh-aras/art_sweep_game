import {
  POINTS_MAX,
  POINTS_MIN,
  POINTS_WINDOW,
  SWEEP_PERIOD,
  LOCKOUT_SWEEPS,
  LOCKOUT_SWEEPS_HARSH,
  LOCKOUT_ESCALATE_AFTER,
  BOUNTY_PER_HOUR,
  BOUNTY_CAP,
  HEAT_GRID,
} from './tuning';
import { TIER_BONUS, type Tier } from './words';

/** Solver score: 100 -> 10 over the first minute on the post (GDD §6). */
export function solverPoints(elapsedMs: number): number {
  const s = POINTS_MAX - (POINTS_MAX - POINTS_MIN) * (elapsedMs / POINTS_WINDOW);
  return Math.max(POINTS_MIN, Math.round(s));
}

/** 0..1 across the decay window — drives the points bar and its urgency states. */
export function decayProgress(elapsedMs: number): number {
  return Math.min(1, Math.max(0, elapsedMs / POINTS_WINDOW));
}

/** Wrong guess costs a sweep; from the third, two (GDD §6). */
export function lockoutMs(wrongCount: number): number {
  const sweeps = wrongCount >= LOCKOUT_ESCALATE_AFTER ? LOCKOUT_SWEEPS_HARSH : LOCKOUT_SWEEPS;
  return sweeps * SWEEP_PERIOD;
}

/** Crack bounty: +10 an hour unsolved, +10 an upvote, capped (GDD §6). */
export function bountyFor(ageMs: number, upvotes: number): number {
  const hours = Math.floor(ageMs / 3_600_000);
  return Math.min(BOUNTY_CAP, hours * BOUNTY_PER_HOUR + upvotes * 10);
}

/** "14h 02m" for the cracked-after readout. */
export function formatAge(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? s.toFixed(1) + 's' : Math.round(s) + 's';
}

// ---- drawer scoring ------------------------------------------------------

/**
 * What the drawer is actually being graded on (GDD §3): did you use the hand?
 *
 *  - **wake**  ink laid immediately behind the hand survives a full rotation;
 *              ink laid in front of it is erased on the spot
 *  - **retrace** the picture is never whole, so an element has to be redrawn on
 *              several passes for a guesser to assemble it
 *  - **spread** a legible drawing uses the dial, not one corner of it
 *
 * All three are pure consequences of the timer, which is the point.
 */
export interface DrawStats {
  points: number;
  wakePoints: number;
  /** heat cell -> bitmask of sweeps it received ink on. */
  cells: Map<number, number>;
}

export function newDrawStats(): DrawStats {
  return { points: 0, wakePoints: 0, cells: new Map() };
}

/** A cell counts as "spread" target when a decent drawing would fill this many. */
const TARGET_CELLS = 60;

export interface Readability {
  score: number; // 0..100
  wake: number; // 0..1
  retrace: number; // 0..1
  spread: number; // 0..1
}

export function readability(stats: DrawStats): Readability {
  if (stats.points === 0) return { score: 0, wake: 0, retrace: 0, spread: 0 };

  const wake = stats.wakePoints / stats.points;

  let retraced = 0;
  for (const mask of stats.cells.values()) {
    // Popcount: how many distinct sweeps touched this cell.
    let n = 0;
    let m = mask;
    while (m) {
      n += m & 1;
      m >>>= 1;
    }
    if (n >= 3) retraced += 1;
    else if (n === 2) retraced += 0.6;
  }
  const retrace = stats.cells.size === 0 ? 0 : Math.min(1, retraced / stats.cells.size);
  const spread = Math.min(1, stats.cells.size / TARGET_CELLS);

  const score = Math.round(100 * (0.45 * wake + 0.3 * retrace + 0.25 * spread));
  return { score, wake, retrace, spread };
}

/** Unit-space point -> heat cell (matches the 24 x 24 grid in §6). */
export function cellOf(ux: number, uy: number): number {
  const gx = Math.min(HEAT_GRID - 1, Math.max(0, Math.floor(((ux + 1) / 2) * HEAT_GRID)));
  const gy = Math.min(HEAT_GRID - 1, Math.max(0, Math.floor(((uy + 1) / 2) * HEAT_GRID)));
  return gy * HEAT_GRID + gx;
}

export interface SimSolve {
  name: string;
  ms: number;
  points: number; // what the solver scored
  drawerTake: number; // floor(S / 2), the drawer's cut (§6)
}

/**
 * How the sub reacts to the link you just posted. A readable drawing gets
 * cracked by more redditors and faster, and the drawer takes half of each
 * solver's score plus the word's tier bonus (GDD §6).
 */
export function simulateSolves(
  r: number,
  tier: Tier,
  names: string[],
  rand: () => number,
): SimSolve[] {
  const count = r < 10 ? 0 : Math.min(names.length, 1 + Math.floor(r / 12));
  const out: SimSolve[] = [];
  for (let i = 0; i < count; i++) {
    const base = 9000 + (100 - r) * 420 + i * 6500;
    const ms = Math.round(base * (0.8 + rand() * 0.45));
    const points = solverPoints(ms);
    out.push({
      name: names[i],
      ms,
      points,
      drawerTake: Math.floor((points / 2) * (1 + TIER_BONUS[tier])),
    });
  }
  return out;
}

export function drawerTotal(solves: SimSolve[]): number {
  return solves.reduce((a, s) => a + s.drawerTake, 0);
}
