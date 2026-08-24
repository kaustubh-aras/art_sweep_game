import { beforeEach, describe, expect, it } from 'vitest';
import { fakeRedis } from './fakeRedis';
import {
  claimRun,
  markFinished,
  msUntilAllowed,
  plausibleClock,
  readActiveRun,
  sanitizeTally,
  scoreRun,
  startRun,
  validateTiming,
} from '../src/server/runs';
import {
  MAX_RUN_MS,
  RUN_CAPS,
  RUN_COOLDOWN_MS,
  RUN_GRACE_LATE_MS,
  SCORE,
  START_TIME_MS,
  TIME_GAIN,
} from '../src/shared/config';
import { EMPTY_TALLY, type RunTally } from '../src/shared/api';

beforeEach(() => fakeRedis.reset());

const tally = (over: Partial<RunTally> = {}): RunTally => ({ ...EMPTY_TALLY, ...over });

/** A run that finished, for tests that only care about one dimension. */
const finished = (over: Partial<RunTally> = {}): RunTally =>
  tally({ reachedGoal: true, ...over });

describe('starting a run', () => {
  it('issues a run id and stamps the server start time', async () => {
    const now = 1_000_000;
    const { run, resumed } = await startRun('t2_a', 3, now);
    expect(run.runId).toBeTruthy();
    expect(run.startedAt).toBe(now);
    expect(resumed).toBe(false);
  });

  it('hands back the same run when a player refreshes mid-run', async () => {
    const now = 1_000_000;
    const first = await startRun('t2_a', 3, now);
    const second = await startRun('t2_a', 3, now + 10_000);

    expect(second.resumed).toBe(true);
    expect(second.run.runId).toBe(first.run.runId);
    // Crucially the clock is not restarted, so a refresh cannot buy more time.
    expect(second.run.startedAt).toBe(now);
  });

  it('permits only one active run at a time', async () => {
    const now = 1_000_000;
    const a = await startRun('t2_a', 3, now);
    const b = await startRun('t2_a', 3, now + 1000);
    expect(b.run.runId).toBe(a.run.runId);
    expect((await readActiveRun('t2_a'))?.runId).toBe(a.run.runId);
  });

  it('issues a fresh run once the old one has expired', async () => {
    const now = 1_000_000;
    const a = await startRun('t2_a', 3, now);
    const b = await startRun('t2_a', 3, now + MAX_RUN_MS + RUN_GRACE_LATE_MS + 1);
    expect(b.run.runId).not.toBe(a.run.runId);
    expect(b.resumed).toBe(false);
  });

  it('issues a fresh run when the board window has moved on', async () => {
    const now = 1_000_000;
    const a = await startRun('t2_a', 3, now);
    const b = await startRun('t2_a', 4, now + 5000);
    expect(b.run.runId).not.toBe(a.run.runId);
    expect(b.run.roundIndex).toBe(4);
  });

  it('gives every run its own arena seed', async () => {
    const a = await startRun('t2_a', 3, 1_000_000);
    const b = await startRun('t2_b', 3, 1_000_000);
    expect(a.run.seed).toEqual(expect.any(Number));
    expect(b.run.seed).toEqual(expect.any(Number));
  });
});

describe('claiming a run (duplicate protection)', () => {
  it('lets the first submission through and refuses the second', async () => {
    expect(await claimRun('run-1', 1000)).toBe(true);
    expect(await claimRun('run-1', 1001)).toBe(false);
  });

  it('admits exactly one winner when submissions race', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimRun('run-race', 1000)));
    expect(results.filter(Boolean).length).toBe(1);
  });
});

describe('run timing (server clock only)', () => {
  const run = { runId: 'r', startedAt: 1_000_000, roundIndex: 3, seed: 1 };

  it('accepts a run of any sensible length', () => {
    // There is no fixed run length any more — a run lasts as long as the player
    // can keep the clock alive.
    expect(validateTiming(run, run.startedAt + 4_000, 3).ok).toBe(true);
    expect(validateTiming(run, run.startedAt + 90_000, 3).ok).toBe(true);
  });

  it('holds an implausibly instant run rather than voiding it', () => {
    const v = validateTiming(run, run.startedAt + 10, 3);
    expect(v.ok).toBe(false);
    // Recoverable on purpose: the caller must keep the run.
    if (!v.ok) expect(v.code).toBe('too_early');
  });

  it('rejects a run that came back far too late', () => {
    const v = validateTiming(run, run.startedAt + MAX_RUN_MS + RUN_GRACE_LATE_MS + 1, 3);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('run_expired');
  });

  it('rejects a run whose board reset while it was being played', () => {
    const v = validateTiming(run, run.startedAt + 5_000, 4);
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
    const input = finished({ anchorsUsed: 9, clocks: 4, msLeft: 3200 });
    const { tally: out, adjusted } = sanitizeTally(input);
    expect(out).toEqual(input);
    expect(adjusted).toBe(false);
  });

  it('caps an absurd claim', () => {
    const { tally: out, adjusted } = sanitizeTally({ anchorsUsed: 999_999, reachedGoal: true });
    expect(out.anchorsUsed).toBe(RUN_CAPS.anchors);
    expect(adjusted).toBe(true);
  });

  it('treats anything but a literal true as an unfinished run', () => {
    // The single most valuable field to lie about, so it takes no coercion.
    for (const v of ['true', 1, {}, [], 'yes']) {
      expect(sanitizeTally({ reachedGoal: v }).tally.reachedGoal).toBe(false);
    }
  });

  it('survives junk of the wrong type', () => {
    const { tally: out } = sanitizeTally({
      anchorsUsed: 'lots',
      msLeft: null,
      clocks: true,
      goldens: [3],
      hits: {},
    });
    expect(out.anchorsUsed).toBe(0);
    expect(out.msLeft).toBe(0);
    expect(out.clocks).toBe(0);
    expect(out.goldens).toBe(0);
    expect(out.hits).toBe(0);
  });

  it('survives a missing or non-object body', () => {
    expect(sanitizeTally(undefined).tally).toEqual(EMPTY_TALLY);
    expect(sanitizeTally(null).tally).toEqual(EMPTY_TALLY);
  });

  it('refuses negative counts', () => {
    const { tally: out } = sanitizeTally({ anchorsUsed: -50, msLeft: -1 });
    expect(out.anchorsUsed).toBe(0);
    expect(out.msLeft).toBe(0);
  });
});

describe('scoring (the server decides what a run was worth)', () => {
  it('scores nothing at all for a run that never reached the goal', () => {
    // The whole run is one question. A near miss is still a miss.
    const { points } = scoreRun(tally({ anchorsUsed: 20, clocks: 30, msLeft: 9_000 }));
    expect(points).toBe(0);
  });

  it('pays the flat award for finishing', () => {
    expect(scoreRun(finished()).points).toBe(SCORE.goal);
  });

  it('pays per distinct anchor', () => {
    const { points, breakdown } = scoreRun(finished({ anchorsUsed: 8 }));
    expect(breakdown.anchors).toBe(8 * SCORE.anchor);
    expect(points).toBe(SCORE.goal + 8 * SCORE.anchor);
  });

  it('pays per whole second left, so arriving early beats scraping in', () => {
    const early = scoreRun(finished({ msLeft: 6_400 })).points;
    const late = scoreRun(finished({ msLeft: 400 })).points;
    expect(early).toBeGreaterThan(late);
    expect(early - late).toBe(6 * SCORE.secondLeft);
  });

  it('rounds leftover time down to whole seconds', () => {
    // So the number on the results screen matches the HUD the player watched.
    expect(scoreRun(finished({ msLeft: 2_999 })).breakdown.time).toBe(2 * SCORE.secondLeft);
  });

  it('shows its working', () => {
    const { points, breakdown } = scoreRun(finished({ anchorsUsed: 5, msLeft: 3_000 }));
    expect(breakdown).toEqual({
      goal: SCORE.goal,
      anchors: 5 * SCORE.anchor,
      time: 3 * SCORE.secondLeft,
    });
    expect(points).toBe(breakdown.goal + breakdown.anchors + breakdown.time);
  });

  it('caps a run that somehow beats every ceiling at once', () => {
    const { points } = scoreRun(
      finished({ anchorsUsed: RUN_CAPS.anchors, msLeft: RUN_CAPS.msLeft }),
    );
    expect(points).toBeLessThanOrEqual(RUN_CAPS.points);
  });
});

describe('clock plausibility', () => {
  /**
   * The invariant is about the *budget*, not the wall clock: leftover time can
   * never exceed the starting tank plus what was collected, less what the hits
   * took. Wall time is useless here because the clock is frozen before the
   * first input and again while paused.
   */
  it('accepts a clock the pickups could have paid for', () => {
    // 10s tank + 4 clocks (+8s) = 18s of budget; claiming 5s left is fine.
    expect(plausibleClock(finished({ clocks: 4, msLeft: 5_000 }))).toBe(true);
  });

  it('accepts the untouched starting tank', () => {
    expect(plausibleClock(finished({ msLeft: START_TIME_MS }))).toBe(true);
  });

  it('rejects more clock than the run could ever have held', () => {
    // Nothing collected, so 30s cannot have come from a 10s tank.
    expect(plausibleClock(finished({ msLeft: 30_000 }))).toBe(false);
  });

  it('counts collected time towards the budget', () => {
    const claim = { msLeft: 30_000 };
    expect(plausibleClock(finished(claim))).toBe(false);
    // 15 clocks is +30s, so the same claim is now entirely possible.
    expect(plausibleClock(finished({ ...claim, clocks: 15 }))).toBe(true);
  });

  it('counts a golden clock at its own richer rate', () => {
    expect(TIME_GAIN.golden).toBeGreaterThan(TIME_GAIN.clock);
    expect(plausibleClock(finished({ goldens: 4, msLeft: 28_000 }))).toBe(true);
    expect(plausibleClock(finished({ clocks: 4, msLeft: 28_000 }))).toBe(false);
  });

  it('takes hits back off the budget', () => {
    // 10s + 10 clocks (+20s) = 30s, less 5 hits (-10s) = 20s.
    expect(plausibleClock(finished({ clocks: 10, hits: 5, msLeft: 19_000 }))).toBe(true);
    expect(plausibleClock(finished({ clocks: 10, hits: 5, msLeft: 25_000 }))).toBe(false);
  });

  it('does not care how long the run took in wall time', () => {
    // A player who read the screen for a minute before moving is still honest;
    // an earlier version of this check flagged exactly that as adjusted.
    expect(plausibleClock(finished({ clocks: 4, msLeft: 5_000 }))).toBe(true);
  });
});
