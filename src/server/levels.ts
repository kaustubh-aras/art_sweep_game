import { redis } from '@devvit/web/server';
import { parseLevel, type BuildLevel } from '../shared/level';

/**
 * Published levels, and the boards that grow on them.
 *
 * A published level is a Reddit post. That is the whole feature: the post *is*
 * the level, so it carries the level in its own storage and anyone who opens it
 * plays that arena rather than the daily one. Nothing is copied into a feed and
 * nothing has to be discovered — a level travels the way every other thing on
 * Reddit travels, by someone linking it.
 *
 * The level JSON is stored against the post id rather than the author, because
 * the post id is what the web view already knows about itself. A player opening
 * a level post asks "what am I?" and gets an arena back.
 */

const K = {
  /** The level JSON for a post, if that post is a level post. */
  level: (postId: string): string => `lvl:${postId}`,
  /** Sorted set: member = username, score = their best on this level. */
  board: (postId: string): string => `lvl:${postId}:board`,
  /** How many distinct people have cleared it. Cheap headline for the card. */
  clears: (postId: string): string => `lvl:${postId}:clears`,
  /** Every level a player has published, newest last. */
  byAuthor: (username: string): string => `author:${username}:levels`,
};

export interface PublishedLevel {
  level: BuildLevel;
  author: string;
  publishedAt: number;
}

/**
 * How many levels one account may publish per day.
 *
 * A published level creates a Reddit post, so this is a spam ceiling before it
 * is a game rule — the cost of getting it wrong is somebody's subreddit, not
 * somebody's score.
 */
export const PUBLISH_PER_DAY = 5;

/** Stores a level against the post that now is it. */
export async function saveLevel(
  postId: string,
  level: BuildLevel,
  author: string,
): Promise<void> {
  const record: PublishedLevel = { level, author, publishedAt: Date.now() };
  await redis.set(K.level(postId), JSON.stringify(record));
  await redis.zAdd(K.byAuthor(author), { member: postId, score: Date.now() });
}

/**
 * Reads the level a post carries, or null when the post is an ordinary one.
 *
 * Parsed rather than cast on the way back out. Storage is trusted less than it
 * looks: a level written by an older build of the game could be a shape this
 * one does not understand, and a malformed arena would take the whole run down
 * rather than politely declining to load.
 */
export async function readLevel(postId: string): Promise<PublishedLevel | null> {
  const raw = await redis.get(K.level(postId));
  if (!raw) return null;

  try {
    const record = JSON.parse(raw) as Partial<PublishedLevel>;
    const parsed = parseLevel(record.level);
    if (!parsed.ok) return null;
    return {
      level: parsed.level,
      author: typeof record.author === 'string' ? record.author : 'someone',
      publishedAt: Number(record.publishedAt) || 0,
    };
  } catch {
    return null;
  }
}

/** Whether this account has room to publish another level today. */
export async function publishAllowance(username: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `pub:${username}:${day}`;
  const used = Number((await redis.get(key)) ?? 0);
  return Math.max(0, PUBLISH_PER_DAY - used);
}

/** Counts one publish against today's allowance. */
export async function notePublish(username: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `pub:${username}:${day}`;
  const next = await redis.incrBy(key, 1);
  // Expire a day after it can still matter, so nothing accumulates for ever.
  if (next === 1) await redis.expire(key, 60 * 60 * 36);
}

export interface LevelRow {
  rank: number;
  username: string;
  points: number;
  isYou: boolean;
}

/**
 * Records a clear on a level's own board.
 *
 * `gt` means only an improvement is written, so the board is a table of bests
 * without a second pass to work that out — and a player who runs a level twenty
 * times still occupies exactly one row.
 */
export async function recordLevelScore(
  postId: string,
  username: string,
  points: number,
): Promise<{ best: number; first: boolean }> {
  const before = await redis.zScore(K.board(postId), username);
  const first = before === undefined || before === null;

  await redis.zAdd(K.board(postId), { member: username, score: points });
  if (first) await redis.incrBy(K.clears(postId), 1);

  const best = Math.max(points, Number(before ?? 0));
  return { best, first };
}

/** The level's board, best first. */
export async function levelBoard(
  postId: string,
  you: string,
  limit = 25,
): Promise<LevelRow[]> {
  const raw = await redis.zRange(K.board(postId), 0, limit - 1, {
    by: 'rank',
    reverse: true,
  });

  return raw.map((entry, i) => ({
    rank: i + 1,
    username: entry.member,
    points: Math.round(entry.score),
    isYou: entry.member === you,
  }));
}

/** How many distinct players have cleared it. */
export async function clearCount(postId: string): Promise<number> {
  return Number((await redis.get(K.clears(postId))) ?? 0);
}
