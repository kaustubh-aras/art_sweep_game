/**
 * Every Redis key Clockshot uses, in one place.
 *
 * Devvit scopes Redis per app installation, so these names only have to be
 * unique within one subreddit's copy of the game. Round-scoped keys carry the
 * round index so a new round starts from clean state without anything having
 * to delete the old one — the old keys simply expire.
 */

const round = (index: number): string => `r:${index}`;

export const K = {
  /**
   * Hash of `red`/`blue` -> *delta* from the starting bank, not the bank
   * itself. Storing the delta means a round needs no initialization step, so
   * there is no race between the first two players to arrive.
   */
  banks: (index: number): string => `${round(index)}:banks`,

  /** Sorted set: member = username, score = seconds contributed this round. */
  players: (index: number): string => `${round(index)}:players`,

  /** Hash: username -> team, so a leaderboard row can be coloured. */
  playerTeams: (index: number): string => `${round(index)}:pteams`,

  /** Sorted set: member = JSON activity item, score = timestamp. */
  activity: (index: number): string => `${round(index)}:activity`,

  /** Hash of round-level scalars (currently just the last known leader). */
  meta: (index: number): string => `${round(index)}:meta`,

  /** A player's team choice, deliberately outside any round so it persists. */
  playerTeam: (userId: string): string => `p:${userId}:team`,

  /** The player's in-flight run, if any. Carries its own TTL. */
  activeRun: (userId: string): string => `p:${userId}:run`,

  /** Set once a run is banked, so the same run can never be counted twice. */
  runDone: (runId: string): string => `run:${runId}:done`,

  /** Timestamp of the player's last banked run, for rate limiting. */
  lastFinish: (userId: string): string => `p:${userId}:last`,
} as const;
