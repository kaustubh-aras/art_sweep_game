import { redis } from '@devvit/web/server';
import { K } from './keys';
import {
  RUN_CAPS,
  RUN_COOLDOWN_MS,
  RUN_GRACE_EARLY_MS,
  RUN_GRACE_LATE_MS,
  RUN_MS,
  SCORE,
  type Team,
  isTeam,
} from '../shared/config';
import type { RunTally } from '../shared/api';

/**
 * Run lifecycle and validation.
 *
 * The rule the whole file exists to enforce: the client reports *what it did*,
 * never *what it earned*. Seconds are recomputed here from `SCORE`, every count
 * is capped, and the clock that decides whether a run is still valid is the
 * server's — a client timestamp is never read.
 */

export interface ActiveRun {
  runId: string;
  startedAt: number;
  roundIndex: number;
  team: Team;
  seed: number;
}

/** TTL for the in-flight run record: the run window plus its late grace. */
const RUN_TTL_SECONDS = Math.ceil((RUN_MS + RUN_GRACE_LATE_MS + 30_000) / 1000);

/** How long a spent run id is remembered, so a replay cannot slip in later. */
const DONE_TTL_SECONDS = Math.ceil((RUN_MS + RUN_GRACE_LATE_MS + 300_000) / 1000);

function newRunId(): string {
  const rand = () => Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${Date.now().toString(36)}${rand()}${rand()}`;
}

export async function readActiveRun(userId: string): Promise<ActiveRun | null> {
  const raw = await redis.hGetAll(K.activeRun(userId));
  if (!raw || !raw.runId) return null;
  const startedAt = Number(raw.startedAt);
  const roundIndex = Number(raw.roundIndex);
  const seed = Number(raw.seed);
  if (!Number.isFinite(startedAt) || !Number.isFinite(roundIndex)) return null;
  if (!isTeam(raw.team)) return null;
  return {
    runId: raw.runId,
    startedAt,
    roundIndex,
    team: raw.team,
    seed: Number.isFinite(seed) ? seed : 1,
  };
}

/**
 * Starts a run, or hands back the one already in flight.
 *
 * Returning the existing run rather than refusing is deliberate: a player who
 * refreshes mid-run gets their run back instead of being locked out, and it
 * still holds the "one active run per player" line, because the returned run
 * keeps its original server start time and cannot be extended by asking again.
 */
export async function startRun(
  userId: string,
  team: Team,
  roundIndex: number,
  nowMs: number,
): Promise<{ run: ActiveRun; resumed: boolean }> {
  const existing = await readActiveRun(userId);
  if (existing) {
    const expired = nowMs > existing.startedAt + RUN_MS + RUN_GRACE_LATE_MS;
    const spent = await isRunSpent(existing.runId);
    if (!expired && !spent && existing.roundIndex === roundIndex) {
      return { run: existing, resumed: true };
    }
    // Stale or already banked — clear it so a fresh run can begin.
    await redis.del(K.activeRun(userId));
  }

  const run: ActiveRun = {
    runId: newRunId(),
    startedAt: nowMs,
    roundIndex,
    team,
    seed: Math.floor(Math.random() * 0x7fffffff),
  };

  await redis.hSet(K.activeRun(userId), {
    runId: run.runId,
    startedAt: String(run.startedAt),
    roundIndex: String(run.roundIndex),
    team: run.team,
    seed: String(run.seed),
  });
  await redis.expire(K.activeRun(userId), RUN_TTL_SECONDS);

  return { run, resumed: false };
}

async function isRunSpent(runId: string): Promise<boolean> {
  return (await redis.exists(K.runDone(runId))) > 0;
}

/**
 * Claims a run id exactly once.
 *
 * `set` with `nx` is the atomic part: of two requests carrying the same run id,
 * only one can create the key, so a double submission — whether from a retry, a
 * double tap, or a replay — can never be banked twice.
 */
export async function claimRun(runId: string, nowMs: number): Promise<boolean> {
  // Fast path for an obvious replay, before we touch anything.
  if ((await redis.exists(K.runDone(runId))) > 0) return false;

  const created = await redis.set(K.runDone(runId), String(nowMs), {
    nx: true,
    expiration: new Date(nowMs + DONE_TTL_SECONDS * 1000),
  });

  // `Set` is declared as returning a `StringValue` (see the redisapi proto), so
  // a win resolves to Redis' "OK" and a refused `nx` write resolves to the
  // proto default — the empty string. Anything non-empty means we claimed it.
  return created !== '' && created !== undefined && created !== null;
}

export async function clearActiveRun(userId: string): Promise<void> {
  await redis.del(K.activeRun(userId)).catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

export async function msUntilAllowed(userId: string, nowMs: number): Promise<number> {
  const raw = await redis.get(K.lastFinish(userId));
  const last = Number(raw);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + RUN_COOLDOWN_MS - nowMs);
}

export async function markFinished(userId: string, nowMs: number): Promise<void> {
  await redis.set(K.lastFinish(userId), String(nowMs), {
    expiration: new Date(nowMs + RUN_COOLDOWN_MS * 4),
  });
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Only a genuine number counts.
 *
 * `Number()` coercion is too generous for untrusted input — `Number([3])` is 3
 * and `Number(true)` is 1, and both of those shapes can arrive through JSON.
 * Anything that is not already a finite number is treated as zero.
 */
function capped(v: unknown, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), max);
}

/** Coerces whatever arrived on the wire into a tally within the caps. */
export function sanitizeTally(input: unknown): { tally: RunTally; adjusted: boolean } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const tally: RunTally = {
    fragments: capped(raw.fragments, RUN_CAPS.fragments),
    largeFragments: capped(raw.largeFragments, RUN_CAPS.largeFragments),
    goldenClocks: capped(raw.goldenClocks, RUN_CAPS.goldenClocks),
    enemyFragments: capped(raw.enemyFragments, RUN_CAPS.enemyFragments),
    enemyKills: capped(raw.enemyKills, RUN_CAPS.enemyKills),
    hazardHits: capped(raw.hazardHits, RUN_CAPS.hazardHits),
    falls: capped(raw.falls, RUN_CAPS.falls),
  };

  // "Adjusted" means we did not take the client's word for something — either a
  // count was out of range, or it was not a number at all.
  const adjusted = (
    ['fragments', 'largeFragments', 'goldenClocks', 'enemyFragments', 'enemyKills', 'hazardHits', 'falls'] as const
  ).some((k) => Math.floor(Number(raw[k]) || 0) !== tally[k]);

  return { tally, adjusted };
}

export interface ScoredRun {
  /** Seconds added to the player's own team. */
  awarded: number;
  /** Seconds taken off the opposing team. */
  stolen: number;
}

/**
 * Turns a tally into seconds. This is the only place the conversion happens,
 * and the client's own arithmetic is never consulted.
 */
export function scoreRun(tally: RunTally): ScoredRun {
  const gained =
    tally.fragments * SCORE.fragment +
    tally.largeFragments * SCORE.largeFragment +
    tally.goldenClocks * SCORE.goldenClock +
    tally.enemyKills * SCORE.enemyKill;

  const lost = tally.hazardHits * SCORE.hazardPenalty + tally.falls * SCORE.fallPenalty;

  // Collected seconds cannot go below zero, then the per-run ceiling applies.
  const awarded = Math.min(Math.max(0, gained - lost), RUN_CAPS.contribution);
  const stolen = Math.min(tally.enemyFragments * SCORE.enemyFragment, RUN_CAPS.stolen);

  return { awarded, stolen };
}

export type RunRejection =
  | { ok: true }
  | { ok: false; code: 'run_expired' | 'round_changed'; message: string };

/** Checks a run's timing against the server clock alone. */
export function validateTiming(run: ActiveRun, nowMs: number, roundIndex: number): RunRejection {
  const elapsed = nowMs - run.startedAt;

  if (elapsed < RUN_MS - RUN_GRACE_EARLY_MS) {
    return {
      ok: false,
      code: 'run_expired',
      message: 'That run was submitted before it could have finished.',
    };
  }

  if (elapsed > RUN_MS + RUN_GRACE_LATE_MS) {
    return {
      ok: false,
      code: 'run_expired',
      message: 'That run took too long to come back and has expired.',
    };
  }

  if (run.roundIndex !== roundIndex) {
    return {
      ok: false,
      code: 'round_changed',
      message: 'The community round ended while you were playing.',
    };
  }

  return { ok: true };
}
