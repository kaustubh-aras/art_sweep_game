import { redis } from '@devvit/web/server';
import { K } from './keys';
import {
  MAX_RUN_MS,
  RUN_CAPS,
  RUN_COOLDOWN_MS,
  RUN_GRACE_LATE_MS,
  SCORE,
  START_TIME_MS,
  TIME_GAIN,
  TIME_LOSS,
} from '../shared/config';
import type { RunTally } from '../shared/api';

/**
 * Run lifecycle and validation.
 *
 * The rule the whole file exists to enforce: the client reports *what it did*,
 * never *what it earned*. Points are recomputed here from `SCORE`, every count
 * is capped, and the clock that decides whether a run is still valid is the
 * server's — a client timestamp is never read.
 */

export interface ActiveRun {
  runId: string;
  startedAt: number;
  roundIndex: number;
  seed: number;
}

/** TTL for the in-flight run record: the longest possible run plus grace. */
const RUN_TTL_SECONDS = Math.ceil((MAX_RUN_MS + RUN_GRACE_LATE_MS + 30_000) / 1000);

/** How long a spent run id is remembered, so a replay cannot slip in later. */
const DONE_TTL_SECONDS = Math.ceil((MAX_RUN_MS + RUN_GRACE_LATE_MS + 300_000) / 1000);

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
  return {
    runId: raw.runId,
    startedAt,
    roundIndex,
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
  roundIndex: number,
  nowMs: number,
): Promise<{ run: ActiveRun; resumed: boolean }> {
  const existing = await readActiveRun(userId);
  if (existing) {
    const expired = nowMs > existing.startedAt + MAX_RUN_MS + RUN_GRACE_LATE_MS;
    const spent = await isRunSpent(existing.runId);
    if (!expired && !spent && existing.roundIndex === roundIndex) {
      return { run: existing, resumed: true };
    }
    // Stale or already scored — clear it so a fresh run can begin.
    await redis.del(K.activeRun(userId));
  }

  const run: ActiveRun = {
    runId: newRunId(),
    startedAt: nowMs,
    roundIndex,
    seed: Math.floor(Math.random() * 0x7fffffff),
  };

  await redis.hSet(K.activeRun(userId), {
    runId: run.runId,
    startedAt: String(run.startedAt),
    roundIndex: String(run.roundIndex),
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
 * double tap, or a replay — can never be scored twice.
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
    // Anything other than a literal `true` is a run that did not finish.
    reachedGoal: raw.reachedGoal === true,
    msLeft: capped(raw.msLeft, RUN_CAPS.msLeft),
    anchorsUsed: capped(raw.anchorsUsed, RUN_CAPS.anchors),
    clocks: capped(raw.clocks, RUN_CAPS.clocks),
    goldens: capped(raw.goldens, RUN_CAPS.goldens),
    hits: capped(raw.hits, RUN_CAPS.hits),
  };

  const counts = ['msLeft', 'anchorsUsed', 'clocks', 'goldens', 'hits'] as const;
  const adjusted =
    counts.some((k) => Math.floor(Number(raw[k]) || 0) !== tally[k]) ||
    (raw.reachedGoal !== undefined && raw.reachedGoal !== tally.reachedGoal);

  return { tally, adjusted };
}

export interface ScoredRun {
  points: number;
  breakdown: { goal: number; anchors: number; time: number };
}

/**
 * Turns a tally into points. The only place the conversion happens.
 *
 * Not reaching the goal scores nothing at all. The whole run is one question —
 * can you get there before the clock runs out — and paying for a near miss
 * would blur it. Runs are short and restarting is instant, so a zero costs a
 * player about fifteen seconds.
 */
export function scoreRun(tally: RunTally): ScoredRun {
  if (!tally.reachedGoal) {
    return { points: 0, breakdown: { goal: 0, anchors: 0, time: 0 } };
  }

  const goal = SCORE.goal;
  const anchors = tally.anchorsUsed * SCORE.anchor;
  // Whole seconds only, so the number on the results screen matches the number
  // the player watched on the HUD.
  const time = Math.floor(tally.msLeft / 1000) * SCORE.secondLeft;

  const points = Math.min(goal + anchors + time, RUN_CAPS.points);
  return { points, breakdown: { goal, anchors, time } };
}

export type RunRejection =
  | { ok: true }
  | { ok: false; code: 'run_expired' | 'round_changed'; message: string }
  /**
   * Too early. Kept separate because it is the only timing failure that is
   * *recoverable*: a late run really is gone, but an early one is almost always
   * clock skew, and the right answer is "not yet" rather than "your run is
   * void". The caller must leave the active run in place when it sees this.
   */
  | { ok: false; code: 'too_early'; message: string; retryInMs: number };

/**
 * Checks a run's timing against the server clock alone.
 *
 * There is no fixed run length any more — a run lasts as long as the player can
 * keep the clock alive — so the only bounds are "at least long enough to have
 * started" and "not longer than any run could possibly be".
 */
export function validateTiming(run: ActiveRun, nowMs: number, roundIndex: number): RunRejection {
  const elapsed = nowMs - run.startedAt;

  // A run cannot finish before it has begun. Anything faster than a fraction of
  // the starting tank did not come from the real game.
  const floor = 250;
  if (elapsed < floor) {
    return {
      ok: false,
      code: 'too_early',
      message: 'That run has not finished yet.',
      retryInMs: floor - elapsed,
    };
  }

  if (elapsed > MAX_RUN_MS + RUN_GRACE_LATE_MS) {
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
      message: 'The leaderboard reset while you were playing.',
    };
  }

  return { ok: true };
}

/**
 * A last sanity check that the clock the client claims could ever have existed.
 *
 * The player starts with `START_TIME_MS` and the only way to gain more is to
 * collect, so leftover time can never exceed the starting tank plus everything
 * picked up, less everything the hits took away.
 *
 * Note what is deliberately *not* used here: the wall time the run took. The
 * clock is frozen before the player's first input and again whenever they
 * pause, so wall-elapsed is always at least clock-elapsed and often far more.
 * Subtracting it flagged perfectly honest runs as adjusted — including every
 * run where the player spent a moment reading the screen before moving.
 * `MAX_RUN_MS` already bounds how long a run may stay open.
 */
export function plausibleClock(tally: RunTally): boolean {
  const gained = tally.clocks * TIME_GAIN.clock + tally.goldens * TIME_GAIN.golden;
  const lost = tally.hits * TIME_LOSS.hazard;
  const budget = START_TIME_MS + gained * 1000 - lost * 1000;
  // A second of slack for frame timing and the trip to the server.
  return tally.msLeft <= budget + 1000;
}
