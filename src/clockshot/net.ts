import type { BuildLevel } from '@/shared/level';
import type {
  ActivityResponse,
  ErrorResponse,
  LeaderboardResponse,
  RunFinishResponse,
  LevelPostResponse,
  PublishResponse,
  RunStartResponse,
  RunTally,
  StateResponse,
} from '../shared/api';

/**
 * The client half of the API.
 *
 * Everything here either resolves to a typed success or throws a `NetError`
 * carrying a message worth showing a player. Callers never see a raw fetch
 * rejection, an HTML error page, or an unparsed body.
 */

export class NetError extends Error {
  readonly code: ErrorResponse['code'] | 'offline' | 'timeout';

  constructor(code: NetError['code'], message: string) {
    super(message);
    this.name = 'NetError';
    this.code = code;
  }

  /** True when trying the exact same call again is reasonable. */
  get retryable(): boolean {
    return (
      this.code === 'offline' ||
      this.code === 'timeout' ||
      this.code === 'server_error' ||
      // The server kept the run and told us to come back — the one rejection
      // that is a "not yet" rather than a "no".
      this.code === 'too_early'
    );
  }
}

const TIMEOUT_MS = 10_000;

async function call<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // An aborted request is a timeout; anything else means we never got out.
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    throw new NetError(
      aborted ? 'timeout' : 'offline',
      aborted ? 'The server took too long to answer.' : 'Cannot reach the server.',
    );
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    // A non-JSON body means something upstream failed, not the game.
    throw new NetError('server_error', 'The server sent back something unreadable.');
  }

  const payload = parsed as ErrorResponse | T;
  if (payload && (payload as ErrorResponse).status === 'error') {
    const e = payload as ErrorResponse;
    throw new NetError(e.code, e.message);
  }

  if (!res.ok) {
    throw new NetError('server_error', `Request failed (${res.status}).`);
  }

  return payload as T;
}

export const api = {
  state: (): Promise<StateResponse> => call<StateResponse>('/api/state', 'GET'),

  startRun: (): Promise<RunStartResponse> => call<RunStartResponse>('/api/run/start', 'POST'),

  finishRun: (runId: string, tally: RunTally): Promise<RunFinishResponse> =>
    call<RunFinishResponse>('/api/run/finish', 'POST', { runId, tally }),

  leaderboard: (): Promise<LeaderboardResponse> =>
    call<LeaderboardResponse>('/api/leaderboard', 'GET'),

  activity: (): Promise<ActivityResponse> => call<ActivityResponse>('/api/activity', 'GET'),

  /**
   * What arena this post is.
   *
   * Asked by every post on boot. An ordinary Clockshot post answers with a null
   * level and the daily arena is played; a level post answers with the arena it
   * carries, and that gets played instead.
   */
  levelPost: (): Promise<LevelPostResponse> => call<LevelPostResponse>('/api/level', 'GET'),

  publishLevel: (level: BuildLevel): Promise<PublishResponse> =>
    call<PublishResponse>('/api/level/publish', 'POST', { level }),
};

/**
 * Retries a call a couple of times when the failure looks transient.
 *
 * Used for banking a run: losing a player's 30 seconds to one dropped packet is
 * the worst failure this game has, so that call gets more than one chance.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // A rejection the server made deliberately will not change on a retry.
      if (err instanceof NetError && !err.retryable) throw err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** i));
      }
    }
  }
  throw lastError;
}
