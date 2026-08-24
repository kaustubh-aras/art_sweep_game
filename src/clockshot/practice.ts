/**
 * Playing something the server never handed out.
 *
 * A normal run is authorised: the client asks `/api/run/start`, and the id,
 * seed and arena all come back from the server, which is what makes the score
 * worth posting. A test run has none of that — it is a player looking at their
 * own level — so it fabricates the same shape locally and is never submitted.
 *
 * Keeping the fake in one place is deliberate. `PlayScene` takes a run and an
 * arena and does not care where either came from; the single flag it reads is
 * `Practice`, and everywhere that flag is set, the scene knows not to talk to
 * the server about what happens next.
 */

import type { RunStartResponse } from '@/shared/api';
import { MAX_RUN_MS, START_TIME_MS } from '@/shared/config';
import { store } from './store';

export interface Practice {
  /** The level being tested, so the editor can pick it back up afterwards. */
  levelId: string;
  name: string;
  /** The scene to return to when the test ends, however it ends. */
  returnTo: string;
}

/** What a test run reports back to whoever launched it. */
export interface PracticeResult {
  /** Clock left at the goal, or null if the goal was never reached. */
  clearedMs: number | null;
}

/**
 * A run object for a level the server has never heard of.
 *
 * `runId` is the literal string "practice" rather than something id-shaped:
 * if one of these ever reaches `/api/run/finish` it should be obviously wrong
 * in a log, not quietly plausible.
 */
export function practiceRun(seed: number): RunStartResponse {
  const now = store.serverNow();
  return {
    status: 'ok',
    runId: 'practice',
    startedAt: now,
    expiresAt: now + MAX_RUN_MS,
    now,
    roundIndex: 0,
    seed,
    arenaIndex: 0,
    startTimeMs: START_TIME_MS,
  };
}
