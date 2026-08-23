import { beforeEach, describe, expect, it } from 'vitest';
import { fakeRedis } from './fakeRedis';
import {
  claimRun,
  clearActiveRun,
  markFinished,
  msUntilAllowed,
  readActiveRun,
  sanitizeTally,
  scoreRun,
  startRun,
  validateTiming,
} from '../src/server/runs';
import {
  RUN_CAPS,
  RUN_COOLDOWN_MS,
  RUN_GRACE_LATE_MS,
  RUN_MS,
  SCORE,
} from '../src/shared/config';
import { EMPTY_TALLY, type RunTally } from '../src/shared/api';

beforeEach(() => fakeRedis.reset());

const tally = (over: Partial<RunTally> = {}): RunTally => ({ ...EMPTY_TALLY, ...over });

describe('starting a run', () => {
  it('issues a run id and stamps the server start time', async () => {
    const now = 1_000_000;
    const { run, resumed } = await startRun('t2_a', 'red', 3, now);
    expect(run.runId).toBeTruthy();
    expect(run.startedAt).toBe(now);
    expect(run.team).toBe('red');
    expect(resumed).toBe(false);
  });

  it('hands back the same run when a player refreshes mid-run', async () => {
    const now = 1_000_000;
    const first = await startRun('t2_a', 'red', 3, now);
    // Ten seconds later the page reloads and asks again.
    const second = await startRun('t2_a', 'red', 3, now + 10_000);

    expect(second.resumed).toBe(true);
    expect(second.run.runId).toBe(first.run.runId);
    // Crucially the clock is not restarted, so a refresh cannot buy more time.
    expect(second.run.startedAt).toBe(now);
  });

  it('permits only one active run at a time', async () => {
    const now = 1_000_000;
    const a = await startRun('t2_a', 'red', 3, now);
    const b = await startRun('t2_a', 'red', 3, now + 1000);
    expect(b.run.runId).toBe(a.run.runId);
    const stored = await readActiveRun('t2_a');
    expect(stored?.runId).toBe(a.run.runId);
  });

  it('issues a fresh run once the old one has expired', async () => {
    const now = 1_000_000;
    const a = await startRun('t2_a', 'red', 3, now);
    const later = now + RUN_MS + RUN_GRACE_LATE_MS + 1;
    const b = await startRun('t2_a', 'red', 3, later);
    expect(b.run.runId).not.toBe(a.run.runId);
    expect(b.resumed).toBe(false);
  });

  it('issues a fresh run when the community round has moved on', async () => {
    const now = 1_000_000;
    const a = await startRun('t2_a', 'red', 3, now);
    const b = await startRun('t2_a', 'red', 4, now + 5000);
    expect(b.run.runId).not.toBe(a.run.runId);
    expect(b.run.roundIndex).toBe(4);
  });

  it('keeps different players independent', async () => {
    const now = 1_000_000;
    const a = await startRun('t2_a', 'red', 3, now);
    const b = await startRun('t2_b', 'blue', 3, now);
    expect(a.run.runId).not.toBe(b.run.runId);
  });
});

describe('claiming a run (duplicate protection)', () => {
  it('lets the first submission through and refuses the second', async () => {
    expect(await claimRun('run-1', 1000)).toBe(true);
    expect(await claimRun('run-1', 1001)).toBe(false);
  });

  it('admits exactly one winner when submissions race', async () => {
    // The double-tap / retry case: many requests, same run id, at once.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimRun('run-race', 1000)),
    );
    expect(results.filter(Boolean).length).toBe(1);
  });

  it('treats different runs as independent', async () => {
    expect(await claimRun('run-1', 1000)).toBe(true);
    expect(await claimRun('run-2', 1000)).toBe(true);
  });
});

describe('run timing (server clock only)', () => {
  const run = { runId: 'r', startedAt: 1_000_000, roundIndex: 3, team: 'red' as const, seed: 1 };

  it('accepts a run submitted at its natural end', () => {
    expect(validateTiming(run, run.startedAt + RUN_MS, 3).ok).toBe(true);
  });

  it('accepts a slightly late submission, for network lag', () => {
    expect(validateTiming(run, run.startedAt + RUN_MS + 2000, 3).ok).toBe(true);
  });

  it('rejects a run submitted impossibly early', () => {
    const v = validateTiming(run, run.startedAt + 3000, 3);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('run_expired');
  });

  it('rejects a run that came back far too late', () => {
    const v = validateTiming(run, run.startedAt + RUN_MS + RUN_GRACE_LATE_MS + 1, 3);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('run_expired');
  });

  it('rejects a run whose round ended while it was being played', () => {
    const v = validateTiming(run, run.startedAt + RUN_MS, 4);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('round_changed');
  });
});

describe('rate limiting', () => {
  it('is open by default', async () => {
    expect(await msUntilAllowed('t2_a', 1000)).toBe(0);
  });

  it('holds a player off immediately after a run', async () => {
    await markFinished('t2_a', 1000);
    expect(await msUntilAllowed('t2_a', 1000)).toBe(RUN_COOLDOWN_MS);
    expect(await msUntilAllowed('t2_a', 1000 + RUN_COOLDOWN_MS)).toBe(0);
  });

  it('does not hold off a different player', async () => {
    await markFinished('t2_a', 1000);
    expect(await msUntilAllowed('t2_b', 1000)).toBe(0);
  });
});

describe('tally sanitizing', () => {
  it('passes an honest tally through untouched', () => {
    const input = tally({ fragments: 10, enemyKills: 3 });
    const { tally: out, adjusted } = sanitizeTally(input);
    expect(out).toEqual(input);
    expect(adjusted).toBe(false);
  });

  it('caps an absurd claim', () => {
    const { tally: out, adjusted } = sanitizeTally({ fragments: 999_999 });
    expect(out.fragments).toBe(RUN_CAPS.fragments);
    expect(adjusted).toBe(true);
  });

  it('refuses negative counts', () => {
    const { tally: out } = sanitizeTally({ fragments: -50, falls: -1 });
    expect(out.fragments).toBe(0);
    expect(out.falls).toBe(0);
  });

  it('survives junk of the wrong type', () => {
    // Every one of these shapes can arrive through JSON, and none of them is a
    // count. Loose coercion would turn [3] into 3 and true into 1.
    const { tally: out } = sanitizeTally({
      fragments: 'lots',
      goldenClocks: null,
      enemyKills: true,
      falls: [3],
      largeFragments: {},
      enemyFragments: '9',
    });
    expect(out.fragments).toBe(0);
    expect(out.goldenClocks).toBe(0);
    expect(out.enemyKills).toBe(0);
    expect(out.falls).toBe(0);
    expect(out.largeFragments).toBe(0);
    expect(out.enemyFragments).toBe(0);
  });

  it('survives a missing or non-object body', () => {
    expect(sanitizeTally(undefined).tally).toEqual(EMPTY_TALLY);
    expect(sanitizeTally(null).tally).toEqual(EMPTY_TALLY);
  });

  it('floors fractional counts', () => {
    const { tally: out } = sanitizeTally({ fragments: 7.9 });
    expect(out.fragments).toBe(7);
  });
});

describe('scoring (the server decides what a run was worth)', () => {
  it('adds up pickups at their listed values', () => {
    const { awarded } = scoreRun(
      tally({ fragments: 4, largeFragments: 2, goldenClocks: 1, enemyKills: 3 }),
    );
    expect(awarded).toBe(
      4 * SCORE.fragment + 2 * SCORE.largeFragment + SCORE.goldenClock + 3 * SCORE.enemyKill,
    );
  });

  it('subtracts hazard and fall penalties', () => {
    const { awarded } = scoreRun(tally({ fragments: 10, hazardHits: 2, falls: 1 }));
    expect(awarded).toBe(10 - 2 * SCORE.hazardPenalty - SCORE.fallPenalty);
  });

  it('never returns a negative award', () => {
    const { awarded } = scoreRun(tally({ fragments: 1, hazardHits: 20, falls: 20 }));
    expect(awarded).toBe(0);
  });

  it('counts enemy fragments as stolen, not gained', () => {
    const { awarded, stolen } = scoreRun(tally({ enemyFragments: 4 }));
    expect(awarded).toBe(0);
    expect(stolen).toBe(4 * SCORE.enemyFragment);
  });

  it('caps a single run contribution', () => {
    const { awarded } = scoreRun(tally({ goldenClocks: RUN_CAPS.goldenClocks, fragments: RUN_CAPS.fragments, largeFragments: RUN_CAPS.largeFragments, enemyKills: RUN_CAPS.enemyKills }));
    expect(awarded).toBeLessThanOrEqual(RUN_CAPS.contribution);
  });

  it('caps how much one run can steal', () => {
    const { stolen } = scoreRun(tally({ enemyFragments: RUN_CAPS.enemyFragments }));
    expect(stolen).toBeLessThanOrEqual(RUN_CAPS.stolen);
  });

  it('scores an empty run as nothing', () => {
    expect(scoreRun(EMPTY_TALLY)).toEqual({ awarded: 0, stolen: 0 });
  });

  it('cannot be talked into a huge score by a hostile client', () => {
    // Everything at once, all wildly inflated.
    const { tally: clean } = sanitizeTally({
      fragments: 1e9,
      largeFragments: 1e9,
      goldenClocks: 1e9,
      enemyFragments: 1e9,
      enemyKills: 1e9,
      hazardHits: 0,
      falls: 0,
    });
    const { awarded, stolen } = scoreRun(clean);
    expect(awarded).toBe(RUN_CAPS.contribution);
    // The count cap bites before the seconds cap here, which is the point of
    // having both: enemyFragments is capped at 20, worth 2 seconds each.
    expect(stolen).toBe(RUN_CAPS.enemyFragments * SCORE.enemyFragment);
    expect(stolen).toBeLessThanOrEqual(RUN_CAPS.stolen);
  });
});

describe('clearing a run', () => {
  it('removes the active run so the player is not stuck', async () => {
    await startRun('t2_a', 'red', 3, 1000);
    await clearActiveRun('t2_a');
    expect(await readActiveRun('t2_a')).toBeNull();
  });

  it('reports no active run for a player who never started one', async () => {
    expect(await readActiveRun('t2_nobody')).toBeNull();
  });
});
