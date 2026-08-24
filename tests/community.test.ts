import { beforeEach, describe, expect, it } from 'vitest';
import { fakeRedis } from './fakeRedis';
import {
  bestOf,
  boardState,
  bumpRuns,
  ensurePlayer,
  leaderboard,
  noteLeadChange,
  playerCount,
  previousWindow,
  pushActivity,
  rankOf,
  readActivity,
  recordScore,
  runsOf,
  topOf,
} from '../src/server/community';
import { ACTIVITY_SIZE, LEADERBOARD_SIZE, ROUND_MS } from '../src/shared/config';

beforeEach(() => fakeRedis.reset());

const W = 42; // an arbitrary board window

describe('recording a score', () => {
  it('stores a first score as the player best', async () => {
    const { best, personalBest } = await recordScore(W, 'alice', 1200);
    expect(best).toBe(1200);
    expect(personalBest).toBe(true);
  });

  it('keeps only the better of two runs', async () => {
    await recordScore(W, 'alice', 1800);
    const worse = await recordScore(W, 'alice', 900);
    expect(worse.best).toBe(1800);
    expect(worse.personalBest).toBe(false);
    expect(await bestOf(W, 'alice')).toBe(1800);
  });

  it('reports a genuine improvement', async () => {
    await recordScore(W, 'alice', 900);
    const better = await recordScore(W, 'alice', 1800);
    expect(better.best).toBe(1800);
    expect(better.personalBest).toBe(true);
  });

  it('does not treat an equal score as a new best', async () => {
    await recordScore(W, 'alice', 1000);
    expect((await recordScore(W, 'alice', 1000)).personalBest).toBe(false);
  });

  it('keeps players independent', async () => {
    await recordScore(W, 'alice', 1500);
    await recordScore(W, 'bob', 700);
    expect(await bestOf(W, 'alice')).toBe(1500);
    expect(await bestOf(W, 'bob')).toBe(700);
  });

  it('keeps windows independent', async () => {
    await recordScore(W, 'alice', 1500);
    expect(await bestOf(W + 1, 'alice')).toBe(0);
  });
});

describe('the board', () => {
  it('is empty before anyone scores', async () => {
    expect(await leaderboard(W, 'alice')).toEqual([]);
    expect((await topOf(W)).score).toBeNull();
  });

  it('counts a player who turned up but has not scored', async () => {
    await ensurePlayer(W, 'alice');
    expect(await playerCount(W)).toBe(1);
    // ...but does not list them, because a zero is not a score.
    expect(await leaderboard(W, 'alice')).toEqual([]);
  });

  it('orders by points, highest first', async () => {
    await recordScore(W, 'alice', 900);
    await recordScore(W, 'bob', 2400);
    await recordScore(W, 'cara', 1500);
    const rows = await leaderboard(W, 'bob');
    expect(rows.map((r) => r.username)).toEqual(['bob', 'cara', 'alice']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('marks the requesting player so the client can highlight them', async () => {
    await recordScore(W, 'alice', 900);
    await recordScore(W, 'bob', 2400);
    const rows = await leaderboard(W, 'alice');
    expect(rows.find((r) => r.username === 'alice')?.isYou).toBe(true);
    expect(rows.find((r) => r.username === 'bob')?.isYou).toBe(false);
  });

  it('reports the top score and who holds it', async () => {
    await recordScore(W, 'alice', 900);
    await recordScore(W, 'bob', 2400);
    expect(await topOf(W)).toEqual({ score: 2400, player: 'bob' });
  });

  it('ranks a player, or says they are unranked', async () => {
    await recordScore(W, 'alice', 900);
    await recordScore(W, 'bob', 2400);
    expect(await rankOf(W, 'bob')).toBe(1);
    expect(await rankOf(W, 'alice')).toBe(2);
    expect(await rankOf(W, 'nobody')).toBeNull();
  });

  it('holds no more than the advertised number of rows', async () => {
    for (let i = 0; i < LEADERBOARD_SIZE + 10; i++) {
      await recordScore(W, `p${i}`, 100 + i);
    }
    expect((await leaderboard(W, '')).length).toBe(LEADERBOARD_SIZE);
  });
});

describe('run counts', () => {
  it('starts at zero and counts up', async () => {
    expect(await runsOf(W, 'alice')).toBe(0);
    expect(await bumpRuns(W, 'alice')).toBe(1);
    expect(await bumpRuns(W, 'alice')).toBe(2);
    expect(await runsOf(W, 'alice')).toBe(2);
  });

  it('counts runs even for a player who never scores', async () => {
    // Every out-of-time attempt still happened, and the menu says so.
    await bumpRuns(W, 'alice');
    expect(await runsOf(W, 'alice')).toBe(1);
    expect(await bestOf(W, 'alice')).toBe(0);
  });
});

describe('activity feed', () => {
  it('returns items newest first', async () => {
    await pushActivity(W, { kind: 'finished', username: 'alice', points: 900, at: 1000 });
    await pushActivity(W, { kind: 'best', username: 'bob', points: 2400, at: 2000 });
    const feed = await readActivity(W);
    expect(feed[0]?.username).toBe('bob');
    expect(feed[1]?.username).toBe('alice');
  });

  it('keeps two identical items apart', async () => {
    // Same player, same score, same millisecond: without unique ids these
    // would collapse into one entry in the sorted set.
    const a = await pushActivity(W, { kind: 'finished', username: 'a', points: 1, at: 5 });
    const b = await pushActivity(W, { kind: 'finished', username: 'a', points: 1, at: 5 });
    expect(a.id).not.toBe(b.id);
    expect((await readActivity(W)).length).toBe(2);
  });

  it('stays bounded', async () => {
    for (let i = 0; i < ACTIVITY_SIZE + 20; i++) {
      await pushActivity(W, { kind: 'finished', username: `p${i}`, points: i, at: 1000 + i });
    }
    expect((await readActivity(W)).length).toBeLessThanOrEqual(ACTIVITY_SIZE);
  });
});

describe('lead changes', () => {
  it('stays quiet for the first score of a window', async () => {
    // Nobody "takes the lead" from an empty board.
    expect(await noteLeadChange(W, 'alice')).toBe(false);
  });

  it('announces a genuine takeover exactly once', async () => {
    await noteLeadChange(W, 'alice');
    expect(await noteLeadChange(W, 'bob')).toBe(true);
    expect(await noteLeadChange(W, 'bob')).toBe(false);
  });
});

describe('window assembly', () => {
  it('derives the window from the wall clock alone', async () => {
    const now = 7 * ROUND_MS + 1234;
    const state = await boardState(now);
    expect(state.roundIndex).toBe(7);
    expect(state.startsAt).toBe(7 * ROUND_MS);
    expect(state.endsAt).toBe(8 * ROUND_MS);
    expect(state.now).toBe(now);
  });

  it('carries the top score', async () => {
    const now = 7 * ROUND_MS;
    await recordScore(7, 'alice', 3300);
    const state = await boardState(now);
    expect(state.topScore).toBe(3300);
    expect(state.topPlayer).toBe('alice');
  });

  it('reports nothing for a previous window nobody played', async () => {
    expect(await previousWindow(W)).toBeNull();
  });

  it('reports the winner of the previous window', async () => {
    await recordScore(W - 1, 'bob', 1900);
    expect(await previousWindow(W)).toEqual({
      roundIndex: W - 1,
      topScore: 1900,
      topPlayer: 'bob',
    });
  });
});
