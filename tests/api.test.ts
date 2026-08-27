import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentServer } from './devServerMock';
import { fakeRedis } from './fakeRedis';
import { ROUND_MS, SCORE, START_TIME_MS } from '../src/shared/config';
import type { RunTally } from '../src/shared/api';

/**
 * End-to-end tests against the real server.
 *
 * These import `src/server/index.ts` itself — the same routing, validation and
 * scoring that ships — and drive it over real HTTP. Vitest aliases the Devvit
 * runtime to the dev harness, which supplies an in-memory Redis, a per-request
 * Reddit identity, and a clock a test can shift so a run or a board window can
 * be exercised without waiting for one.
 */

const PORT = 39755;
const BASE = `http://127.0.0.1:${PORT}`;

interface CallResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = Record<string, unknown>>(
  path: string,
  opts: { as?: string; method?: 'GET' | 'POST'; body?: unknown; offset?: number } = {},
): Promise<CallResult<T>> {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'x-dev-user': opts.as ?? 'anon',
      'x-dev-time-offset': String(opts.offset ?? 0),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: res.headers,
  };
}

/** Plays a complete run and posts it. `elapsed` is how long it "took". */
async function playRun(
  user: string,
  tally: Partial<RunTally>,
  opts: { offset?: number; elapsed?: number } = {},
): Promise<CallResult> {
  const offset = opts.offset ?? 0;
  const elapsed = opts.elapsed ?? 4_000;
  const start = await call<{ runId: string }>('/api/run/start', {
    as: user,
    method: 'POST',
    offset,
  });
  return call('/api/run/finish', {
    as: user,
    method: 'POST',
    offset: offset + elapsed,
    body: { runId: start.body.runId, tally },
  });
}

beforeAll(async () => {
  process.env.CLOCKSHOT_PORT = String(PORT);

  /**
   * Stand the suite up just after a round boundary.
   *
   * Rounds roll over every `ROUND_MS`, and several tests below finish a run up
   * to ninety seconds after starting it. Run against the raw wall clock, any of
   * those lands in the *next* round whenever real time happens to be within
   * ninety seconds of a boundary — and the server rejects it, correctly, as
   * `round_changed`. That is a fifteen-percent chance of red, arriving in
   * bursts, on code nobody touched.
   *
   * Shifting the whole process to the start of a round leaves the full ten
   * minutes of headroom, so the outcome depends on the test rather than on what
   * time it is. The tests that care about rollover still ask for it explicitly
   * with their own per-request offsets.
   */
  const intoRound = Date.now() % ROUND_MS;
  process.env.CLOCKSHOT_TIME_OFFSET = String(ROUND_MS - intoRound + 1_000);
  const mod = (await import('../src/server/index')) as unknown as { default?: unknown };
  void mod;
  // The module starts listening on import; give the socket a moment to bind.
  await new Promise((r) => setTimeout(r, 250));
});

afterAll(() => {
  // Without this the bound socket keeps the test runner alive.
  currentServer()?.close();
});

beforeEach(() => {
  fakeRedis.reset();
});

describe('wire format', () => {
  /**
   * Devvit's gateway rejects a chunked reply outright — it wants a real
   * `Content-Length`. A plain Node server (which is what the dev harness is)
   * accepts chunked responses happily, so this went unnoticed until the first
   * upload failed to install. These assertions are the only thing standing
   * between that bug and a repeat.
   */
  it('sends an explicit Content-Length on success', async () => {
    const res = await call('/api/state', { as: 'alice' });
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0);
  });

  it('sends an explicit Content-Length on failure', async () => {
    const res = await call('/api/run/start', { method: 'POST' }); // logged out
    expect(res.status).toBe(401);
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0);
  });

  it('never falls back to chunked transfer encoding', async () => {
    const res = await call('/api/leaderboard', { as: 'alice' });
    expect(res.headers.get('transfer-encoding')).toBeNull();
  });

  it('counts bytes, not characters, for a non-ASCII body', async () => {
    const res = await call('/api/leaderboard', { as: 'zoë' });
    expect(Number(res.headers.get('content-length'))).toBe(
      Buffer.byteLength(JSON.stringify(res.body), 'utf8'),
    );
  });
});

describe('identity', () => {
  it('lets a logged-out viewer watch but not play', async () => {
    const state = await call<{ you: { username: string; canPlay: boolean } }>('/api/state');
    expect(state.status).toBe(200);
    expect(state.body.you.username).toBe('');
    expect(state.body.you.canPlay).toBe(false);

    const start = await call<{ code: string }>('/api/run/start', { method: 'POST' });
    expect(start.status).toBe(401);
    expect(start.body.code).toBe('no_user');
  });

  it('never takes a username from the client', async () => {
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    await call('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: 4_000,
      body: {
        runId: start.body.runId,
        tally: { reachedGoal: true, anchorsUsed: 3, msLeft: 2_000 },
        username: 'bob',
      },
    });
    const board = await call<{ players: { username: string }[] }>('/api/leaderboard', {
      as: 'alice',
    });
    expect(board.body.players.map((p) => p.username)).toEqual(['alice']);
  });
});

describe('starting a run', () => {
  it('hands back everything the client needs to build the arena', async () => {
    const res = await call<{
      runId: string;
      seed: number;
      arenaIndex: number;
      startTimeMs: number;
    }>('/api/run/start', { as: 'alice', method: 'POST' });

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeTruthy();
    expect(res.body.seed).toEqual(expect.any(Number));
    expect(res.body.arenaIndex).toBeGreaterThanOrEqual(0);
    // The tank comes from the server, so it can be retuned without a client
    // release and a modified client cannot simply grant itself more.
    expect(res.body.startTimeMs).toBe(START_TIME_MS);
  });

  it('needs no team, no setup and no ceremony', async () => {
    const res = await call('/api/run/start', { as: 'brand_new', method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('a complete run', () => {
  it('scores the goal, the anchors and the leftover clock', async () => {
    const res = await playRun('alice', {
      reachedGoal: true,
      anchorsUsed: 7,
      clocks: 5,
      msLeft: 3_400,
    });
    expect(res.status).toBe(200);
    expect(res.body.points).toBe(SCORE.goal + 7 * SCORE.anchor + 3 * SCORE.secondLeft);
    expect(res.body.breakdown).toEqual({
      goal: SCORE.goal,
      anchors: 7 * SCORE.anchor,
      time: 3 * SCORE.secondLeft,
    });
  });

  it('scores nothing for a run that ran out of time', async () => {
    const res = await playRun('alice', { reachedGoal: false, anchorsUsed: 12, clocks: 20 });
    expect(res.status).toBe(200);
    expect(res.body.points).toBe(0);
  });

  it('rewards arriving with time in hand', async () => {
    const early = await playRun('alice', { reachedGoal: true, anchorsUsed: 5, msLeft: 6_000 });
    const late = await playRun('bob', { reachedGoal: true, anchorsUsed: 5, msLeft: 500 });
    expect(early.body.points as number).toBeGreaterThan(late.body.points as number);
  });

  it('puts the player on the board and in the feed', async () => {
    await playRun('alice', { reachedGoal: true, anchorsUsed: 4, msLeft: 2_000 });

    const board = await call<{ players: { username: string; points: number; isYou: boolean }[] }>(
      '/api/leaderboard',
      { as: 'alice' },
    );
    expect(board.body.players[0]).toMatchObject({ username: 'alice', isYou: true });

    const feed = await call<{ activity: { kind: string; username: string }[] }>('/api/activity');
    expect(feed.body.activity.some((a) => a.username === 'alice')).toBe(true);
  });

  it('keeps only a player’s best run', async () => {
    // Offsets step past RUN_COOLDOWN_MS; back-to-back runs are rate limited.
    await playRun('alice', { reachedGoal: true, anchorsUsed: 10, msLeft: 5_000 });
    const worse = await playRun(
      'alice',
      { reachedGoal: true, anchorsUsed: 1, msLeft: 0 },
      { offset: 20_000 },
    );
    expect(worse.body.personalBest).toBe(false);

    const state = await call<{ you: { best: number } }>('/api/state', { as: 'alice' });
    expect(state.body.you.best).toBe(SCORE.goal + 10 * SCORE.anchor + 5 * SCORE.secondLeft);
  });

  it('flags a personal best', async () => {
    const first = await playRun('alice', { reachedGoal: true, anchorsUsed: 2, msLeft: 1_000 });
    expect(first.body.personalBest).toBe(true);
    const better = await playRun(
      'alice',
      { reachedGoal: true, anchorsUsed: 9, msLeft: 4_000 },
      { offset: 20_000 },
    );
    expect(better.body.personalBest).toBe(true);
  });

  it('counts every attempt, scored or not', async () => {
    await playRun('alice', { reachedGoal: false });
    await playRun('alice', { reachedGoal: false }, { offset: 20_000 });
    const state = await call<{ you: { runs: number; best: number } }>('/api/state', {
      as: 'alice',
      offset: 20_000,
    });
    expect(state.body.you.runs).toBe(2);
    expect(state.body.you.best).toBe(0);
  });
});

describe('run integrity', () => {
  it('caps an impossible claim instead of trusting it', async () => {
    const res = await playRun('alice', {
      reachedGoal: true,
      anchorsUsed: 999_999,
      msLeft: 999_999_999,
    });
    expect(res.body.adjusted).toBe(true);
    expect(res.body.points as number).toBeLessThanOrEqual(40_000);
  });

  it('refuses a leftover clock the run could not have held', async () => {
    // Nothing collected, so 40 seconds cannot have come from a 10-second tank.
    const res = await playRun('alice', {
      reachedGoal: true,
      anchorsUsed: 3,
      clocks: 0,
      msLeft: 40_000,
    });
    expect(res.body.adjusted).toBe(true);
    // The time component is zeroed; the goal and anchors still stand.
    expect(res.body.breakdown).toMatchObject({ time: 0, goal: SCORE.goal });
  });

  it('does not flag an honest run that simply took a while', async () => {
    // The clock freezes before the first input and while paused, so wall time
    // routinely exceeds clock time. That must not read as cheating.
    const res = await playRun(
      'alice',
      { reachedGoal: true, anchorsUsed: 4, clocks: 6, msLeft: 5_000 },
      { elapsed: 90_000 },
    );
    expect(res.body.adjusted).toBe(false);
    expect(res.body.breakdown).toMatchObject({ time: 5 * SCORE.secondLeft });
  });

  it('holds an implausibly instant submit rather than voiding the run', async () => {
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    const early = await call<{ code: string }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      body: { runId: start.body.runId, tally: { reachedGoal: true, msLeft: 5_000 } },
    });
    expect(early.status).toBe(425);
    expect(early.body.code).toBe('too_early');

    // ...and the run must survive, so the honest submit still scores.
    const real = await call<{ points: number }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: 5_000,
      body: { runId: start.body.runId, tally: { reachedGoal: true, anchorsUsed: 2, msLeft: 1_500 } },
    });
    expect(real.status).toBe(200);
    expect(real.body.points).toBe(SCORE.goal + 2 * SCORE.anchor + SCORE.secondLeft);
  });

  it('counts a run exactly once', async () => {
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    const body = {
      runId: start.body.runId,
      tally: { reachedGoal: true, anchorsUsed: 5, msLeft: 2_000 },
    };
    const first = await call('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: 4_000,
      body,
    });
    const second = await call<{ code: string }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: 4_100,
      body,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('run_duplicate');
  });

  it('refuses a run that came back far too late', async () => {
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    const res = await call<{ code: string }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: 10 * 60 * 1000,
      body: { runId: start.body.runId, tally: { reachedGoal: true } },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('run_expired');
  });

  it('rate limits back-to-back runs', async () => {
    await playRun('alice', { reachedGoal: true, msLeft: 1_000 });
    const res = await call<{ code: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });
});

describe('the board', () => {
  it('shows the top score to everyone', async () => {
    await playRun('alice', { reachedGoal: true, anchorsUsed: 10, msLeft: 5_000 });
    const state = await call<{ board: { topScore: number; topPlayer: string } }>('/api/state', {
      as: 'bob',
    });
    expect(state.body.board.topPlayer).toBe('alice');
    expect(state.body.board.topScore).toBeGreaterThan(0);
  });

  it('announces a takeover exactly once', async () => {
    await playRun('alice', { reachedGoal: true, anchorsUsed: 2, msLeft: 1_000 });
    const bob = await playRun(
      'bob',
      { reachedGoal: true, anchorsUsed: 20, msLeft: 9_000 },
      { offset: 20_000 },
    );
    expect(bob.body.tookLead).toBe(true);

    const feed = await call<{ activity: { kind: string }[] }>('/api/activity');
    expect(feed.body.activity.filter((a) => a.kind === 'lead').length).toBe(1);
  });

  it('starts a clean board when the window rolls over', async () => {
    await playRun('alice', { reachedGoal: true, anchorsUsed: 10, msLeft: 5_000 });
    const next = await call<{ board: { topScore: number | null } }>('/api/state', {
      as: 'alice',
      offset: ROUND_MS,
    });
    expect(next.body.board.topScore).toBeNull();
  });

  it('remembers who won the previous window', async () => {
    await playRun('alice', { reachedGoal: true, anchorsUsed: 10, msLeft: 5_000 });
    const next = await call<{ board: { previous: { topPlayer: string } | null } }>('/api/state', {
      as: 'alice',
      offset: ROUND_MS,
    });
    expect(next.body.board.previous?.topPlayer).toBe('alice');
  });
});

describe('failure handling', () => {
  it('returns a server error rather than crashing when Redis fails', async () => {
    fakeRedis.failNext = 'zRange';
    const res = await call<{ code: string }>('/api/state', { as: 'alice' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('server_error');
  });

  it('404s an unknown endpoint in a shape the client understands', async () => {
    const res = await call<{ status: string; code: string }>('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });
});
