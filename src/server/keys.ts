/**
 * Every Redis key Clockshot uses, in one place.
 *
 * Devvit scopes Redis per app installation, so these names only have to be
 * unique within one subreddit's copy of the game. Window-scoped keys carry the
 * window index so a new board starts from clean state without anything having
 * to delete the old one — the old keys simply expire.
 */

const win = (index: number): string => `w:${index}`;

export const K = {
  /**
   * Sorted set: member = username, score = that player's *best* run this
   * window. A zset scored by best-ever is the whole leaderboard — no separate
   * ranking pass, and `zAdd` with `gt` makes "only if it beats what is there"
   * a single atomic write.
   */
  board: (index: number): string => `${win(index)}:board`,

  /** Sorted set: member = JSON activity item, score = timestamp. */
  activity: (index: number): string => `${win(index)}:activity`,

  /** Hash of window-level scalars (currently just the last known leader). */
  meta: (index: number): string => `${win(index)}:meta`,

  /** How many runs a player has finished this window. */
  runCount: (index: number, username: string): string => `${win(index)}:runs:${username}`,

  /** The player's in-flight run, if any. Carries its own TTL. */
  activeRun: (userId: string): string => `p:${userId}:run`,

  /** Set once a run is scored, so the same run can never be counted twice. */
  runDone: (runId: string): string => `run:${runId}:done`,

  /** Timestamp of the player's last scored run, for rate limiting. */
  lastFinish: (userId: string): string => `p:${userId}:last`,
} as const;
