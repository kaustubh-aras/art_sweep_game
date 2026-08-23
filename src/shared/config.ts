/**
 * Clockshot tuning constants shared by the client and the server.
 *
 * The server is the authority for everything in here. The client imports the
 * same numbers only so it can predict and display; any value that decides an
 * outcome is recomputed server-side from these constants, never trusted from
 * the wire.
 */

/** How long one community round lasts. Rounds are derived from this alone. */
export const ROUND_MS = 10 * 60 * 1000;

/** How long a single player's run lasts. */
export const RUN_MS = 30 * 1000;

/**
 * Slack allowed around `RUN_MS` when a run is submitted. Covers request
 * latency and a backgrounded tab resuming late. Anything outside is rejected.
 */
export const RUN_GRACE_EARLY_MS = 1200;
export const RUN_GRACE_LATE_MS = 15 * 1000;

/** Both teams start each round with this many seconds banked. */
export const STARTING_BANK = 60;

/** Seconds awarded per pickup / action. The server re-derives score from these. */
export const SCORE = {
  fragment: 1,
  largeFragment: 3,
  goldenClock: 5,
  /** Taken off the *other* team rather than added to yours. */
  enemyFragment: 2,
  enemyKill: 2,
} as const;

/**
 * There is deliberately no hazard or fall penalty.
 *
 * Getting hit already costs the scarcest thing in a thirty-second run — the
 * clock — through knockback, invulnerability frames and a ruined line. Charging
 * banked seconds on top of that is what let a beginner finish a whole run on
 * zero, which is the worst thing this game could tell a new player. Whatever
 * you collect, you keep.
 */

/**
 * Hard ceilings used to validate a submitted run. These are generous — they
 * exist to make an impossible score impossible, not to police a good one.
 * A run that beats these was not produced by the real game.
 */
export const RUN_CAPS = {
  fragments: 60,
  largeFragments: 20,
  goldenClocks: 6,
  enemyFragments: 20,
  enemyKills: 30,
  hazardHits: 40,
  falls: 20,
  /** Absolute cap on seconds banked for a team by one run. */
  contribution: 150,
  /** Absolute cap on seconds stolen from the other team by one run. */
  stolen: 60,
} as const;

/** Minimum gap between two finished runs by the same player. */
export const RUN_COOLDOWN_MS = 3000;

/** How many entries the leaderboards and the activity feed carry. */
export const LEADERBOARD_SIZE = 25;
export const ACTIVITY_SIZE = 30;

/** Rounds are kept this much longer than their own length, then expire. */
export const ROUND_RETENTION_MS = 3 * ROUND_MS;

export type Team = 'red' | 'blue';

export const TEAMS: readonly Team[] = ['red', 'blue'] as const;

export function isTeam(v: unknown): v is Team {
  return v === 'red' || v === 'blue';
}

export function otherTeam(t: Team): Team {
  return t === 'red' ? 'blue' : 'red';
}

/**
 * How many arenas the client ships. The server does not know what an arena
 * *is* — it only picks a number — so layout stays entirely client-side while
 * the choice stays authoritative.
 */
export const ARENA_COUNT = 3;

/**
 * Which arena a round is played in.
 *
 * A pure function of the round index, exactly like `roundIndexAt`: no storage,
 * no scheduler, and every player in a round independently agrees on the answer.
 * The multiply-xor is a cheap integer hash so consecutive rounds do not simply
 * cycle 0, 1, 2, 0 — which would be learnable and dull.
 */
export function arenaIndexAt(roundIndex: number): number {
  let h = Math.imul(roundIndex >>> 0, 2654435761) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) % ARENA_COUNT;
}

/** The round index for a moment in time. Rounds tile the epoch with no gaps. */
export function roundIndexAt(nowMs: number): number {
  return Math.floor(nowMs / ROUND_MS);
}

/** When a given round started and ends, in epoch ms. */
export function roundWindow(index: number): { startsAt: number; endsAt: number } {
  const startsAt = index * ROUND_MS;
  return { startsAt, endsAt: startsAt + ROUND_MS };
}
