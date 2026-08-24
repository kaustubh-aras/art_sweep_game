/**
 * Clockshot tuning constants shared by the client and the server.
 *
 * The server is the authority for everything in here. The client imports the
 * same numbers only so it can predict and display; any value that decides an
 * outcome is recomputed server-side from these constants, never trusted from
 * the wire.
 */

/**
 * How long one leaderboard window lasts.
 *
 * Still the old round length. How long a board *should* live is an open
 * question — 10 minutes keeps a race winnable for a newcomer, a day makes a
 * score mean more — so this stays where it is until that is decided. Nothing
 * else assumes a particular value; changing this constant moves the whole
 * system, because the window is derived from it rather than stored.
 */
export const ROUND_MS = 10 * 60 * 1000;

/**
 * Time is the fuel, and this is the tank.
 *
 * A run does not have a fixed length any more. The player starts with this
 * much on the clock, it drains from the moment they first move, and the only
 * way to keep going is to collect more. A run ends when they reach the goal or
 * when the clock hits zero — so a good player's run is *longer*, not shorter.
 */
export const START_TIME_MS = 10 * 1000;

/** Seconds a pickup puts back on the clock. */
export const TIME_GAIN = {
  clock: 2,
  golden: 5,
} as const;

/**
 * The least clock a checkpoint restart may hand back.
 *
 * A checkpoint remembers the clock you had when you first touched it. Pass one
 * on fumes and that alone would drop you into an unwinnable loop, so the
 * restart is floored here — enough to reach the next thing, never enough to
 * make dying attractive.
 */
export const CHECKPOINT_MIN_MS = 5 * 1000;

/** Seconds knocked off for touching something that hurts. */
export const TIME_LOSS = {
  hazard: 2,
  enemy: 2,
} as const;

/**
 * The longest a single run may last, whatever the player collects.
 *
 * Without a ceiling a good enough player could farm pickups forever, and the
 * server would have no way to tell that from a client that simply lied about
 * how long it had been running.
 */
export const MAX_RUN_MS = 5 * 60 * 1000;

/** Slack around a submitted run's own timing. Covers latency and a slow tab. */
export const RUN_GRACE_LATE_MS = 20 * 1000;

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a run is worth.
 *
 * Two things earn points: how much of the arena you actually flew through, and
 * how much clock you had left when you touched the goal. Time dominates on
 * purpose — arriving with six seconds in hand should beat scraping in on
 * fumes, which is what "the less the time, the lesser the score" means.
 *
 * `anchor` counts *distinct* anchors, never total grapples. Paying per grapple
 * would make swinging back and forth on one hook the best strategy in the
 * game, which is the opposite of the route-finding this is meant to reward.
 */
export const SCORE = {
  /** Flat award for finishing at all. Not finishing scores nothing. */
  goal: 500,
  /** Per distinct anchor used along the way. */
  anchor: 25,
  /** Per whole second still on the clock at the goal. */
  secondLeft: 100,
} as const;

/**
 * Hard ceilings used to validate a submitted run. These are generous — they
 * exist to make an impossible score impossible, not to police a good one.
 * A run that beats these was not produced by the real game.
 */
export const RUN_CAPS = {
  /** Distinct anchors in the biggest arena, with room to spare. */
  anchors: 40,
  clocks: 80,
  goldens: 6,
  hits: 60,
  /** Nobody finishes with more clock than the tank could ever hold. */
  msLeft: MAX_RUN_MS,
  /** Absolute ceiling on one run's score. */
  points: 40_000,
} as const;

/** Minimum gap between two finished runs by the same player. */
export const RUN_COOLDOWN_MS = 3000;

/** How many entries the leaderboard and the activity feed carry. */
export const LEADERBOARD_SIZE = 25;
export const ACTIVITY_SIZE = 30;

/** Boards are kept this much longer than their own window, then expire. */
export const ROUND_RETENTION_MS = 3 * ROUND_MS;

/**
 * How many arenas the client ships. The server does not know what an arena
 * *is* — it only picks a number — so layout stays entirely client-side while
 * the choice stays authoritative.
 */
export const ARENA_COUNT = 3;

/**
 * Which arena a board window is played in.
 *
 * A pure function of the window index, exactly like `roundIndexAt`: no storage,
 * no scheduler, and every player independently agrees on the answer. The
 * multiply-xor is a cheap integer hash so consecutive windows do not simply
 * cycle 0, 1, 2 — which would be learnable and dull.
 */
export function arenaIndexAt(roundIndex: number): number {
  let h = Math.imul(roundIndex >>> 0, 2654435761) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) % ARENA_COUNT;
}

/** The board window for a moment in time. Windows tile the epoch with no gaps. */
export function roundIndexAt(nowMs: number): number {
  return Math.floor(nowMs / ROUND_MS);
}

/** When a given window started and ends, in epoch ms. */
export function roundWindow(index: number): { startsAt: number; endsAt: number } {
  const startsAt = index * ROUND_MS;
  return { startsAt, endsAt: startsAt + ROUND_MS };
}
