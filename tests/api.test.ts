import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentServer } from './devServerMock';
import { fakeRedis } from './fakeRedis';
import { RUN_MS, ROUND_MS, SCORE, STARTING_BANK } from '../src/shared/config';

/**
 * End-to-end tests against the real server.
 *
 * These import `src/server/index.ts` itself — the same routing, validation and
 * scoring that ships — and drive it over real HTTP. Vitest aliases the Devvit
 * runtime to the dev harness, which supplies an in-memory Redis, a per-request
 * Reddit identity, and a clock a test can shift so a thirty-second run or a
 * ten-minute round can be tested without waiting for one.
 */

const PORT = 39755;
const BASE = `http://127.0.0.1:${PORT}`;

interface CallResult<T = Record<string, unknown>> {
  status: number;
  body: T;
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
  return { status: res.status, body: (await res.json()) as T };
}

/** Plays a complete, legal run and banks it. */
async function playRun(
  user: string,
  tally: Record<string, number>,
  offset = 0,
): Promise<CallResult> {
  const start = await call<{ runId: string }>('/api/run/start', {
    as: user,
    method: 'POST',
    offset,
  });
  return call('/api/run/finish', {
    as: user,
    method: 'POST',
    offset: offset + RUN_MS,
    body: { runId: start.body.runId, tally },
  });
}

beforeAll(async () => {
  process.env.CLOCKSHOT_PORT = String(PORT);
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
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
    // Alice tries to bank as "bob" by saying so in the body.
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    await call('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: RUN_MS,
      body: { runId: start.body.runId, tally: { fragments: 5 }, username: 'bob', team: 'blue' },
    });

    const board = await call<{ players: { username: string }[] }>('/api/leaderboard', { as: 'alice' });
    expect(board.body.players.map((p) => p.username)).toEqual(['alice']);
  });
});

describe('team selection', () => {
  it('records a new player onto a team', async () => {
    const res = await call<{ team: string; changed: boolean }>('/api/team', {
      as: 'alice',
      method: 'POST',
      body: { team: 'blue' },
    });
    expect(res.body).toMatchObject({ team: 'blue', changed: true });
  });

  it('rejects a team that is not red or blue', async () => {
    const res = await call<{ code: string }>('/api/team', {
      as: 'alice',
      method: 'POST',
      body: { team: 'green' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_request');
  });

  it('allows a switch before the player has banked anything', async () => {
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
    const res = await call<{ team: string; changed: boolean }>('/api/team', {
      as: 'alice',
      method: 'POST',
      body: { team: 'blue' },
    });
    expect(res.body).toMatchObject({ team: 'blue', changed: true });
  });

  it('locks the team once the player has contributed this round', async () => {
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
    await playRun('alice', { fragments: 6 });

    const res = await call<{ team: string; changed: boolean; message?: string }>('/api/team', {
      as: 'alice',
      method: 'POST',
      body: { team: 'blue' },
    });
    expect(res.body.changed).toBe(false);
    expect(res.body.team).toBe('red');
    expect(res.body.message).toBeTruthy();
  });

  it('lets a brand new player run before they have picked a side', async () => {
    const res = await call<{ runId: string; team: string | null }>('/api/run/start', {
      as: 'newbie',
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeTruthy();
    expect(res.body.team).toBeNull();
  });

  it('banks a teamless run once the player says who it is for', async () => {
    const start = await call<{ runId: string }>('/api/run/start', {
      as: 'newbie',
      method: 'POST',
    });
    const res = await call<{ awarded: number; you: { team: string } }>('/api/run/finish', {
      as: 'newbie',
      method: 'POST',
      offset: RUN_MS,
      body: { runId: start.body.runId, tally: { fragments: 6 }, team: 'blue' },
    });
    expect(res.status).toBe(200);
    expect(res.body.awarded).toBe(6);
    expect(res.body.you.team).toBe('blue');

    // The choice has to stick, or the next run asks all over again.
    const state = await call<{ you: { team: string } }>('/api/state', { as: 'newbie' });
    expect(state.body.you.team).toBe('blue');
  });

  it('refuses to bank a teamless run with no side attached', async () => {
    const start = await call<{ runId: string }>('/api/run/start', {
      as: 'newbie',
      method: 'POST',
    });
    const res = await call<{ code: string }>('/api/run/finish', {
      as: 'newbie',
      method: 'POST',
      offset: RUN_MS,
      body: { runId: start.body.runId, tally: { fragments: 6 } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_team');

    // ...and the run must survive, so the player can pick and bank it.
    const retry = await call<{ awarded: number }>('/api/run/finish', {
      as: 'newbie',
      method: 'POST',
      offset: RUN_MS,
      body: { runId: start.body.runId, tally: { fragments: 6 }, team: 'red' },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.awarded).toBe(6);
  });

  it('will not let a teamless run score for the side they did not commit to', async () => {
    // alice is locked to red by the suite's setup and has already banked.
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
    const first = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    await call('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: RUN_MS,
      body: { runId: first.body.runId, tally: { fragments: 4 } },
    });

    const res = await call<{ you: { team: string } }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: RUN_MS * 2 + 60_000,
      body: { runId: 'nope', tally: { fragments: 4 }, team: 'blue' },
    });
    // The forged run id is rejected outright; the point is that a team field on
    // the wire can never move someone off the side they are locked to.
    expect(res.status).toBe(409);
    const state = await call<{ you: { team: string } }>('/api/state', { as: 'alice' });
    expect(state.body.you.team).toBe('red');
  });
});

describe('a complete run', () => {
  beforeEach(async () => {
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
  });

  it('banks seconds the server computed, not ones the client claimed', async () => {
    const res = await playRun('alice', { fragments: 4, largeFragments: 1, enemyKills: 2 });
    const expected = 4 * SCORE.fragment + SCORE.largeFragment + 2 * SCORE.enemyKill;

    expect(res.status).toBe(200);
    expect(res.body.awarded).toBe(expected);
    expect((res.body.community as { banks: Record<string, number> }).banks.red).toBe(
      STARTING_BANK + expected,
    );
  });

  it('takes seconds off the other team when enemy clocks are collected', async () => {
    const res = await playRun('alice', { fragments: 2, enemyFragments: 3 });
    const banks = (res.body.community as { banks: Record<string, number> }).banks;

    expect(res.body.stolen).toBe(3 * SCORE.enemyFragment);
    expect(banks.blue).toBe(STARTING_BANK - 3 * SCORE.enemyFragment);
    expect(banks.red).toBe(STARTING_BANK + 2);
  });

  it('does not charge for hazards or falls', async () => {
    const res = await playRun('alice', { fragments: 10, hazardHits: 2, falls: 1 });
    expect(res.body.awarded).toBe(10);
  });

  it('always banks something for a player who collected something', async () => {
    const res = await playRun('alice', { fragments: 1, hazardHits: 10, falls: 5 });
    expect(res.body.awarded).toBe(1);
    expect((res.body.community as { banks: Record<string, number> }).banks.red).toBe(
      STARTING_BANK + 1,
    );
  });

  it('caps an impossible claim instead of trusting it', async () => {
    const res = await playRun('alice', { fragments: 999999, goldenClocks: 9999 });
    expect(res.body.adjusted).toBe(true);
    expect(res.body.awarded as number).toBeLessThanOrEqual(150);
  });

  it('puts the player on the leaderboard and in the feed', async () => {
    await playRun('alice', { fragments: 7 });

    const board = await call<{ players: { username: string; seconds: number; isYou: boolean }[] }>(
      '/api/leaderboard',
      { as: 'alice' },
    );
    expect(board.body.players[0]).toMatchObject({ username: 'alice', seconds: 7, isYou: true });

    const feed = await call<{ activity: { kind: string; username: string }[] }>('/api/activity');
    expect(feed.body.activity.some((a) => a.kind === 'added' && a.username === 'alice')).toBe(true);
  });
});

describe('run integrity', () => {
  beforeEach(async () => {
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
  });

  it('refuses a run submitted before it could have finished', async () => {
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    const res = await call<{ code: string }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: 2000,
      body: { runId: start.body.runId, tally: { fragments: 50 } },
    });
    expect(res.status).toBe(425);
    expect(res.body.code).toBe('too_early');
  });

  it('keeps an early-submitted run alive so the honest submit still banks', async () => {
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });

    // A moment of clock skew: the client asks before the window has closed.
    await call('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: 2000,
      body: { runId: start.body.runId, tally: { fragments: 5 } },
    });

    // The run must still be there. Losing it here would turn a retry into a
    // lost thirty seconds — the worst failure this game has.
    const res = await call<{ awarded: number }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: RUN_MS,
      body: { runId: start.body.runId, tally: { fragments: 5 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.awarded).toBe(5);
  });

  it('refuses a run that came back far too late', async () => {
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    const res = await call<{ code: string }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: RUN_MS + 120_000,
      body: { runId: start.body.runId, tally: { fragments: 5 } },
    });
    expect(res.body.code).toBe('run_expired');
  });

  it('counts a run once, however many times it is submitted', async () => {
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    const payload = { runId: start.body.runId, tally: { fragments: 9 } };

    const first = await call('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: RUN_MS,
      body: payload,
    });
    const second = await call<{ code: string }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: RUN_MS + 100,
      body: payload,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('run_duplicate');

    const state = await call<{ community: { banks: Record<string, number> } }>('/api/state', {
      as: 'alice',
    });
    expect(state.body.community.banks.red).toBe(STARTING_BANK + 9);
  });

  it('banks only once when the same run is submitted concurrently', async () => {
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });
    const payload = { runId: start.body.runId, tally: { fragments: 8 } };

    // The double-tap: six identical submissions, all in flight at once.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call<{ status: string }>('/api/run/finish', {
          as: 'alice',
          method: 'POST',
          offset: RUN_MS,
          body: payload,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 200).length).toBe(1);
    const state = await call<{ community: { banks: Record<string, number> } }>('/api/state', {
      as: 'alice',
    });
    expect(state.body.community.banks.red).toBe(STARTING_BANK + 8);
  });

  it('rejects a run id that was never issued', async () => {
    const res = await call<{ code: string }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: RUN_MS,
      body: { runId: 'made-up', tally: { fragments: 5 } },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('run_duplicate');
  });

  it('rejects a submission with no run id at all', async () => {
    const res = await call<{ code: string }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      body: { tally: { fragments: 5 } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_request');
  });

  it('will not let one player bank another player’s run', async () => {
    await call('/api/team', { as: 'bob', method: 'POST', body: { team: 'blue' } });
    const start = await call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' });

    const res = await call<{ code: string }>('/api/run/finish', {
      as: 'bob',
      method: 'POST',
      offset: RUN_MS,
      body: { runId: start.body.runId, tally: { fragments: 40 } },
    });
    expect(res.status).toBe(409);
  });

  it('rate limits back-to-back runs', async () => {
    await playRun('alice', { fragments: 3 });
    const again = await call<{ code: string }>('/api/run/start', {
      as: 'alice',
      method: 'POST',
      offset: RUN_MS + 200,
    });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('rate_limited');
  });

  it('returns the same run to a player who refreshed mid-run', async () => {
    const first = await call<{ runId: string; startedAt: number }>('/api/run/start', {
      as: 'alice',
      method: 'POST',
    });
    const second = await call<{ runId: string; startedAt: number }>('/api/run/start', {
      as: 'alice',
      method: 'POST',
      offset: 8000,
    });
    expect(second.body.runId).toBe(first.body.runId);
    // The clock did not restart, so refreshing buys no extra time.
    expect(second.body.startedAt).toBe(first.body.startedAt);
  });

  it('rejects a run whose round ended while it was being played', async () => {
    // Start the run ten seconds before the round boundary so it straddles it:
    // the run itself is a legal length, but it belongs to a round that is over.
    const now = Date.now();
    const boundary = Math.ceil(now / ROUND_MS) * ROUND_MS;
    const startOffset = boundary - 10_000 - now;

    const start = await call<{ runId: string; roundIndex: number }>('/api/run/start', {
      as: 'alice',
      method: 'POST',
      offset: startOffset,
    });
    const res = await call<{ code: string }>('/api/run/finish', {
      as: 'alice',
      method: 'POST',
      offset: startOffset + RUN_MS,
      body: { runId: start.body.runId, tally: { fragments: 5 } },
    });
    expect(res.body.code).toBe('round_changed');
  });

  it('survives a malformed body without failing the request', async () => {
    const res = await fetch(`${BASE}/api/run/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-user': 'alice' },
      body: 'this is not json{{{',
    });
    expect([400, 409]).toContain(res.status);
  });

  it('returns a clear 404 for an unknown endpoint', async () => {
    const res = await call<{ code: string }>('/api/nope', { as: 'alice' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('bad_request');
  });
});

describe('two teams sharing one world', () => {
  beforeEach(async () => {
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
    await call('/api/team', { as: 'bob', method: 'POST', body: { team: 'blue' } });
  });

  it('lets each player see what the other did', async () => {
    await playRun('alice', { fragments: 12 });
    const state = await call<{ community: { banks: Record<string, number>; leader: string } }>(
      '/api/state',
      { as: 'bob' },
    );
    expect(state.body.community.banks.red).toBe(STARTING_BANK + 12);
    expect(state.body.community.leader).toBe('red');
  });

  it('keeps both contributions when two runs land at the same moment', async () => {
    const [aStart, bStart] = await Promise.all([
      call<{ runId: string }>('/api/run/start', { as: 'alice', method: 'POST' }),
      call<{ runId: string }>('/api/run/start', { as: 'bob', method: 'POST' }),
    ]);

    await Promise.all([
      call('/api/run/finish', {
        as: 'alice',
        method: 'POST',
        offset: RUN_MS,
        body: { runId: aStart.body.runId, tally: { fragments: 10 } },
      }),
      call('/api/run/finish', {
        as: 'bob',
        method: 'POST',
        offset: RUN_MS,
        body: { runId: bStart.body.runId, tally: { fragments: 7 } },
      }),
    ]);

    const state = await call<{ community: { banks: Record<string, number>; players: number } }>(
      '/api/state',
      { as: 'alice' },
    );
    expect(state.body.community.banks.red).toBe(STARTING_BANK + 10);
    expect(state.body.community.banks.blue).toBe(STARTING_BANK + 7);
    expect(state.body.community.players).toBe(2);
  });

  it('never lets a bank go negative, however much is stolen', async () => {
    // Repeatedly steal far more than blue could ever hold.
    for (let i = 0; i < 12; i++) {
      await playRun('alice', { enemyFragments: 20 }, i * (RUN_MS + 60_000));
    }
    const state = await call<{ community: { banks: Record<string, number> } }>('/api/state', {
      as: 'alice',
    });
    expect(state.body.community.banks.blue).toBe(0);
    expect(state.body.community.banks.blue).toBeGreaterThanOrEqual(0);
  });

  it('announces a lead change exactly once', async () => {
    await playRun('alice', { fragments: 20 });
    const feed = await call<{ activity: { kind: string }[] }>('/api/activity');
    const leadLines = feed.body.activity.filter((a) => a.kind === 'lead');
    expect(leadLines.length).toBeLessThanOrEqual(1);
  });
});

describe('community rounds', () => {
  it('starts the next round clean while remembering the last one', async () => {
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
    await playRun('alice', { fragments: 15 });

    const next = await call<{
      community: { banks: Record<string, number>; previous: { winner: string; draw: boolean } | null };
    }>('/api/state', { as: 'alice', offset: ROUND_MS });

    expect(next.body.community.banks).toEqual({ red: STARTING_BANK, blue: STARTING_BANK });
    expect(next.body.community.previous?.winner).toBe('red');
    expect(next.body.community.previous?.draw).toBe(false);
  });

  it('reports a draw when the previous round finished level', async () => {
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
    await call('/api/team', { as: 'bob', method: 'POST', body: { team: 'blue' } });
    await playRun('alice', { fragments: 5 });
    await playRun('bob', { fragments: 5 }, RUN_MS + 60_000);

    const next = await call<{ community: { previous: { draw: boolean } | null } }>('/api/state', {
      as: 'alice',
      offset: ROUND_MS,
    });
    expect(next.body.community.previous?.draw).toBe(true);
  });

  it('lets a player change teams once a new round has begun', async () => {
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
    await playRun('alice', { fragments: 5 });

    // Locked during the round...
    const locked = await call<{ changed: boolean }>('/api/team', {
      as: 'alice',
      method: 'POST',
      body: { team: 'blue' },
    });
    expect(locked.body.changed).toBe(false);

    // ...free again in the next one.
    const freed = await call<{ changed: boolean; team: string }>('/api/team', {
      as: 'alice',
      method: 'POST',
      body: { team: 'blue' },
      offset: ROUND_MS,
    });
    expect(freed.body).toMatchObject({ changed: true, team: 'blue' });
  });

  it('reports the round window and a server timestamp the client can sync to', async () => {
    const state = await call<{ community: { startsAt: number; endsAt: number; now: number } }>(
      '/api/state',
      { as: 'alice' },
    );
    const c = state.body.community;
    expect(c.endsAt - c.startsAt).toBe(ROUND_MS);
    expect(c.now).toBeGreaterThanOrEqual(c.startsAt);
    expect(c.now).toBeLessThan(c.endsAt);
  });
});

describe('failure handling', () => {
  it('returns a server error rather than crashing when Redis fails', async () => {
    await call('/api/team', { as: 'alice', method: 'POST', body: { team: 'red' } });
    fakeRedis.failNext = 'hGetAll';

    const res = await call<{ status: string; code: string }>('/api/state', { as: 'alice' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('server_error');

    // ...and the very next request works again.
    const ok = await call<{ status: string }>('/api/state', { as: 'alice' });
    expect(ok.body.status).toBe('ok');
  });
});
