import { redis } from '@devvit/web/server';
import { K } from './keys';
import {
  ACTIVITY_SIZE,
  LEADERBOARD_SIZE,
  ROUND_RETENTION_MS,
  roundIndexAt,
  roundWindow,
} from '../shared/config';
import type { ActivityItem, BoardState, LeaderRow, PreviousWindow } from '../shared/api';

/**
 * The leaderboard window.
 *
 * Windows are derived from the wall clock (`roundIndexAt`) rather than created
 * by a scheduled job, so there is nothing to go wrong at a boundary: the window
 * a request belongs to is a pure function of when it arrived. A window's state
 * is whatever accumulated under its index, and old indices expire on their own.
 */

/** Marks every key belonging to a window so it cleans itself up later. */
async function touchWindowTtl(index: number): Promise<void> {
  const seconds = Math.ceil(ROUND_RETENTION_MS / 1000);
  const keys = [K.board(index), K.activity(index), K.meta(index)];
  // Expiry is best-effort: a window that outlives its TTL is harmless, and a
  // failure here must never fail the player's request.
  await Promise.all(keys.map((k) => redis.expire(k, seconds).catch(() => undefined)));
}

/**
 * Records a score, keeping only the player's best for this window.
 *
 * The board is a sorted set scored by personal best, which means ranking needs
 * no separate pass and a worse run can never displace a better one. Returns
 * whether this run actually improved on what was already there.
 */
export async function recordScore(
  index: number,
  username: string,
  points: number,
): Promise<{ best: number; personalBest: boolean }> {
  const previous = await redis.zScore(K.board(index), username);
  const hadBefore = previous !== undefined && previous !== null;
  const best = hadBefore ? Math.max(previous, points) : points;

  if (!hadBefore || points > previous) {
    await redis.zAdd(K.board(index), { member: username, score: best });
  }
  await touchWindowTtl(index);

  return { best, personalBest: !hadBefore || points > previous };
}

/** Puts a player on the board at zero so they are counted before they score. */
export async function ensurePlayer(index: number, username: string): Promise<void> {
  const existing = await redis.zScore(K.board(index), username);
  if (existing === undefined || existing === null) {
    await redis.zAdd(K.board(index), { member: username, score: 0 });
  }
  await touchWindowTtl(index);
}

export async function playerCount(index: number): Promise<number> {
  return (await redis.zCard(K.board(index))) ?? 0;
}

export async function bestOf(index: number, username: string): Promise<number> {
  return (await redis.zScore(K.board(index), username)) ?? 0;
}

/** How many runs this player has finished in this window. */
export async function runsOf(index: number, username: string): Promise<number> {
  const raw = await redis.get(K.runCount(index, username));
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function bumpRuns(index: number, username: string): Promise<number> {
  const key = K.runCount(index, username);
  const raw = await redis.get(key);
  const next = (Number.isFinite(Number(raw)) ? Number(raw) : 0) + 1;
  await redis.set(key, String(next), {
    expiration: new Date(Date.now() + ROUND_RETENTION_MS),
  });
  return next;
}

/** The top rows of the board, highest first. */
export async function leaderboard(index: number, you: string): Promise<LeaderRow[]> {
  const rows = await redis.zRange(K.board(index), 0, LEADERBOARD_SIZE - 1, {
    by: 'rank',
    reverse: true,
  });
  return rows
    .filter((r) => r.score > 0)
    .map((r, i) => ({
      rank: i + 1,
      username: r.member,
      points: Math.round(r.score),
      isYou: r.member === you,
    }));
}

/** 1-based rank on the board, or null if the player is off it. */
export async function rankOf(index: number, username: string): Promise<number | null> {
  const rows = await leaderboard(index, '');
  const at = rows.findIndex((r) => r.username === username);
  return at === -1 ? null : at + 1;
}

/** The single best score in a window, and who holds it. */
export async function topOf(
  index: number,
): Promise<{ score: number | null; player: string | null }> {
  const rows = await redis.zRange(K.board(index), 0, 0, { by: 'rank', reverse: true });
  const top = rows[0];
  if (!top || top.score <= 0) return { score: null, player: null };
  return { score: Math.round(top.score), player: top.member };
}

/* -------------------------------------------------------------------------- */
/* Activity feed                                                              */
/* -------------------------------------------------------------------------- */

let activityCounter = 0;

/**
 * Appends to the window's feed.
 *
 * The feed is a sorted set scored by timestamp rather than a list, because the
 * Devvit Redis client offers no list operations. Members must stay unique, so
 * each item carries an id — two players scoring the same amount in the same
 * millisecond would otherwise collapse into a single entry.
 */
export async function pushActivity(
  index: number,
  item: Omit<ActivityItem, 'id'>,
): Promise<ActivityItem> {
  const salt = Math.floor(Math.random() * 1e6).toString(36);
  const id = [item.at.toString(36), (activityCounter++).toString(36), salt].join('-');
  const full: ActivityItem = { ...item, id };

  await redis.zAdd(K.activity(index), { member: JSON.stringify(full), score: item.at });

  // Keep the feed bounded. Ranks run low-to-high, so dropping everything below
  // the last ACTIVITY_SIZE entries leaves exactly the newest behind.
  await redis.zRemRangeByRank(K.activity(index), 0, -(ACTIVITY_SIZE + 1)).catch(() => undefined);

  return full;
}

export async function readActivity(index: number): Promise<ActivityItem[]> {
  const rows = await redis.zRange(K.activity(index), 0, ACTIVITY_SIZE - 1, {
    by: 'rank',
    reverse: true,
  });
  const out: ActivityItem[] = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.member) as ActivityItem;
      if (parsed && typeof parsed.username === 'string') out.push(parsed);
    } catch {
      // A malformed entry must not take the whole feed down with it.
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Lead tracking                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns true when this call is the one that took the top spot, so exactly one
 * "has taken the lead" line reaches the feed no matter how many runs land.
 */
export async function noteLeadChange(index: number, leader: string | null): Promise<boolean> {
  const key = K.meta(index);
  const prev = (await redis.hGet(key, 'leader')) ?? '';
  const next = leader ?? '';
  if (prev === next) return false;
  await redis.hSet(key, { leader: next });
  // Only announce a real takeover, not the first score of the window.
  return prev !== '' && leader !== null;
}

/* -------------------------------------------------------------------------- */
/* Window assembly                                                            */
/* -------------------------------------------------------------------------- */

export async function previousWindow(index: number): Promise<PreviousWindow | null> {
  const prevIndex = index - 1;
  const top = await topOf(prevIndex);
  if (top.score === null) return null;
  return { roundIndex: prevIndex, topScore: top.score, topPlayer: top.player };
}

export async function boardState(nowMs: number): Promise<BoardState> {
  const index = roundIndexAt(nowMs);
  const { startsAt, endsAt } = roundWindow(index);
  const [top, players, previous] = await Promise.all([
    topOf(index),
    playerCount(index),
    previousWindow(index),
  ]);
  return {
    roundIndex: index,
    startsAt,
    endsAt,
    now: nowMs,
    topScore: top.score,
    topPlayer: top.player,
    players,
    previous,
  };
}
