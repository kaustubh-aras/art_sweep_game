import { beforeEach, describe, expect, it } from 'vitest';
import { fakeRedis } from './fakeRedis';
import {
  addContribution,
  addToBank,
  communityState,
  ensurePlayer,
  leaderOf,
  leaderboard,
  noteLeadChange,
  previousRound,
  pushActivity,
  rankOf,
  readActivity,
  readBanks,
} from '../src/server/community';
import {
  ROUND_MS,
  STARTING_BANK,
  roundIndexAt,
  roundWindow,
} from '../src/shared/config';

beforeEach(() => fakeRedis.reset());

describe('round derivation', () => {
  it('tiles the epoch with no gaps or overlaps', () => {
    const i = roundIndexAt(Date.now());
    const a = roundWindow(i);
    const b = roundWindow(i + 1);
    expect(a.endsAt).toBe(b.startsAt);
    expect(a.endsAt - a.startsAt).toBe(ROUND_MS);
  });

  it('puts a moment in the round that contains it', () => {
    const i = 12345;
    const { startsAt, endsAt } = roundWindow(i);
    expect(roundIndexAt(startsAt)).toBe(i);
    expect(roundIndexAt(endsAt - 1)).toBe(i);
    expect(roundIndexAt(endsAt)).toBe(i + 1);
  });
});

describe('team banks', () => {
  it('starts both teams level without any initialization step', async () => {
    const banks = await readBanks(1);
    expect(banks).toEqual({ red: STARTING_BANK, blue: STARTING_BANK });
  });

  it('adds seconds to the right team only', async () => {
    await addToBank(1, 'red', 10);
    expect(await readBanks(1)).toEqual({ red: STARTING_BANK + 10, blue: STARTING_BANK });
  });

  it('never lets a bank go negative, and reports what was really taken', async () => {
    const result = await addToBank(1, 'blue', -(STARTING_BANK + 25));
    expect(result.bank).toBe(0);
    // Only the seconds that existed could be taken.
    expect(result.applied).toBe(-STARTING_BANK);
    expect((await readBanks(1)).blue).toBe(0);
  });

  it('stays at zero when drained repeatedly', async () => {
    await addToBank(1, 'blue', -STARTING_BANK);
    const second = await addToBank(1, 'blue', -10);
    expect(second.applied).toBe(0);
    expect((await readBanks(1)).blue).toBe(0);
  });

  it('survives concurrent writes without losing any of them', async () => {
    // Twenty simultaneous runs, each banking 3 seconds for red.
    await Promise.all(Array.from({ length: 20 }, () => addToBank(1, 'red', 3)));
    expect((await readBanks(1)).red).toBe(STARTING_BANK + 60);
  });

  it('keeps two teams independent under simultaneous load', async () => {
    await Promise.all([
      ...Array.from({ length: 10 }, () => addToBank(1, 'red', 2)),
      ...Array.from({ length: 10 }, () => addToBank(1, 'blue', 5)),
    ]);
    expect(await readBanks(1)).toEqual({
      red: STARTING_BANK + 20,
      blue: STARTING_BANK + 50,
    });
  });
});

describe('leader', () => {
  it('reports null when level', () => {
    expect(leaderOf({ red: 10, blue: 10 })).toBeNull();
  });

  it('reports the team ahead', () => {
    expect(leaderOf({ red: 11, blue: 10 })).toBe('red');
    expect(leaderOf({ red: 10, blue: 11 })).toBe('blue');
  });

  it('announces a takeover exactly once', async () => {
    // First observation establishes a baseline and must not announce.
    expect(await noteLeadChange(1, 'red')).toBe(false);
    // Same leader again: still nothing to say.
    expect(await noteLeadChange(1, 'red')).toBe(false);
    // A genuine flip announces.
    expect(await noteLeadChange(1, 'blue')).toBe(true);
    expect(await noteLeadChange(1, 'blue')).toBe(false);
  });

  it('does not announce falling into a tie', async () => {
    await noteLeadChange(1, 'red');
    expect(await noteLeadChange(1, null)).toBe(false);
  });
});

describe('leaderboard', () => {
  it('ranks by seconds, highest first, and flags the requester', async () => {
    await addContribution(1, 'alice', 'red', 30);
    await addContribution(1, 'bob', 'blue', 45);
    await addContribution(1, 'carol', 'red', 12);

    const rows = await leaderboard(1, 'carol');
    expect(rows.map((r) => r.username)).toEqual(['bob', 'alice', 'carol']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows.find((r) => r.isYou)?.username).toBe('carol');
    expect(rows[0]!.team).toBe('blue');
  });

  it('accumulates a player across several runs', async () => {
    await addContribution(1, 'alice', 'red', 10);
    await addContribution(1, 'alice', 'red', 7);
    expect(await rankOf(1, 'alice')).toBe(1);
    const rows = await leaderboard(1, 'alice');
    expect(rows[0]!.seconds).toBe(17);
  });

  it('returns an empty board for a round nobody has played', async () => {
    expect(await leaderboard(99, 'alice')).toEqual([]);
    expect(await rankOf(99, 'alice')).toBeNull();
  });

  it('counts a player who joined but has not scored', async () => {
    await ensurePlayer(1, 'dave', 'blue');
    const state = await communityState(1 * ROUND_MS);
    expect(state.players).toBe(1);
    expect((await leaderboard(1, 'dave'))[0]!.seconds).toBe(0);
  });
});

describe('activity feed', () => {
  it('returns newest first', async () => {
    const t = Date.now();
    await pushActivity(1, { kind: 'added', username: 'a', team: 'red', seconds: 1, at: t });
    await pushActivity(1, { kind: 'added', username: 'b', team: 'blue', seconds: 2, at: t + 10 });
    const feed = await readActivity(1);
    expect(feed[0]!.username).toBe('b');
    expect(feed[1]!.username).toBe('a');
  });

  it('keeps entries distinct even in the same millisecond', async () => {
    const t = Date.now();
    await pushActivity(1, { kind: 'added', username: 'a', team: 'red', seconds: 1, at: t });
    await pushActivity(1, { kind: 'added', username: 'a', team: 'red', seconds: 1, at: t });
    expect((await readActivity(1)).length).toBe(2);
  });

  it('stays bounded as the round goes on', async () => {
    const t = Date.now();
    for (let i = 0; i < 60; i++) {
      await pushActivity(1, { kind: 'added', username: `u${i}`, team: 'red', seconds: 1, at: t + i });
    }
    const feed = await readActivity(1);
    expect(feed.length).toBeLessThanOrEqual(30);
    // Trimming must drop the oldest, never the newest.
    expect(feed[0]!.username).toBe('u59');
  });

  it('skips a corrupted entry rather than failing the whole feed', async () => {
    const t = Date.now();
    await pushActivity(1, { kind: 'added', username: 'good', team: 'red', seconds: 1, at: t });
    await fakeRedis.zAdd('r:1:activity', { member: 'not json{', score: t + 1 });
    const feed = await readActivity(1);
    expect(feed.map((f) => f.username)).toEqual(['good']);
  });
});

describe('round transitions', () => {
  it('reports no previous round before anyone has played one', async () => {
    expect(await previousRound(5)).toBeNull();
  });

  it('reports the previous winner once a round has been played', async () => {
    await addToBank(4, 'red', 30);
    await ensurePlayer(4, 'alice', 'red');
    const prev = await previousRound(5);
    expect(prev?.winner).toBe('red');
    expect(prev?.draw).toBe(false);
    expect(prev?.banks.red).toBe(STARTING_BANK + 30);
  });

  it('reports a draw when a played round ended level', async () => {
    await ensurePlayer(4, 'alice', 'red');
    await addToBank(4, 'red', 10);
    await addToBank(4, 'blue', 10);
    const prev = await previousRound(5);
    expect(prev?.draw).toBe(true);
    expect(prev?.winner).toBeNull();
  });

  it('starts a new round clean while the old one keeps its totals', async () => {
    await addToBank(4, 'red', 40);
    await addContribution(4, 'alice', 'red', 40);

    // The next round shares no state with the last.
    expect(await readBanks(5)).toEqual({ red: STARTING_BANK, blue: STARTING_BANK });
    expect(await leaderboard(5, 'alice')).toEqual([]);
    // ...and the old round is still intact for the "previous winner" panel.
    expect((await readBanks(4)).red).toBe(STARTING_BANK + 40);
  });

  it('sets an expiry on round keys so old rounds clean themselves up', async () => {
    await ensurePlayer(7, 'alice', 'red');
    expect(fakeRedis.ttlOf('r:7:players')).toBeGreaterThan(Date.now());
  });
});

describe('community state', () => {
  it('describes the round containing the given moment', async () => {
    const now = 9 * ROUND_MS + 1234;
    const state = await communityState(now);
    expect(state.roundIndex).toBe(9);
    expect(state.startsAt).toBe(9 * ROUND_MS);
    expect(state.endsAt).toBe(10 * ROUND_MS);
    expect(state.now).toBe(now);
    expect(state.banks).toEqual({ red: STARTING_BANK, blue: STARTING_BANK });
    expect(state.leader).toBeNull();
  });
});
