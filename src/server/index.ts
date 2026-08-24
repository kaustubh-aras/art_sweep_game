import { context, createServer, getServerPort, reddit } from '@devvit/web/server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UiResponse } from '@devvit/web/shared';

import {
  bestOf,
  boardState,
  bumpRuns,
  ensurePlayer,
  leaderboard,
  noteLeadChange,
  pushActivity,
  rankOf,
  readActivity,
  recordScore,
  runsOf,
  topOf,
} from './community';
import {
  claimRun,
  clearActiveRun,
  msUntilAllowed,
  markFinished,
  plausibleClock,
  readActiveRun,
  sanitizeTally,
  scoreRun,
  startRun,
  validateTiming,
} from './runs';
import { START_TIME_MS, MAX_RUN_MS, arenaIndexAt, roundIndexAt } from '../shared/config';
import type {
  ActivityItem,
  ActivityResponse,
  ErrorResponse,
  LeaderboardResponse,
  RunFinishResponse,
  RunStartResponse,
  StateResponse,
} from '../shared/api';

/**
 * Clockshot's Devvit server.
 *
 * Two rules shape every handler below:
 *
 *   1. Identity comes from `context`, never from the request body. A client
 *      cannot claim to be someone else because it is never asked who it is.
 *   2. The server owns the clock and the scoring. A run is worth what
 *      `scoreRun` says it is worth, timed against the server's own `Date.now()`.
 */

const TITLE = 'Clockshot — Swing Against the Clock';

const TEXT_FALLBACK = [
  '**Clockshot** is a grappling time trial.',
  '',
  'You start with ten seconds. The clock drains the moment you move, and the',
  'only way to keep going is to swing through the clock pickups scattered',
  'across the arena. Reach the goal before it hits zero.',
  '',
  'The more of the arena you fly through and the more time you have left when',
  'you land, the higher you place on the board.',
  '',
  'Open this post in the Reddit app or on new Reddit to play.',
].join('\n');

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                   */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A body this large is not something any endpoint here accepts.
    if (size > 64 * 1024) return {};
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/**
 * Sends a JSON response with an explicit `Content-Length`.
 *
 * The length is not optional here. Without it Node falls back to chunked
 * transfer encoding, which the Devvit gateway refuses outright:
 *
 *   server responded with Content-Length header "null" but greater than zero
 *   required for nonempty response
 *
 * That surfaced as a failed app install on the very first upload, and it would
 * have broken every endpoint in this file the same way — the local dev harness
 * is a plain Node server and accepts chunked replies quite happily, so nothing
 * short of a real deploy could have caught it.
 *
 * The byte length has to come from a Buffer rather than `string.length`:
 * usernames are UTF-8, and any non-ASCII character would make a character count
 * disagree with the bytes actually on the wire.
 */
function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body) ?? 'null', 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.byteLength),
  });
  res.end(payload);
}

function fail(
  res: ServerResponse,
  status: number,
  code: ErrorResponse['code'],
  message: string,
): void {
  send(res, status, { status: 'error', code, message } satisfies ErrorResponse);
}

/** The signed-in player, or null when the post is being viewed logged out. */
function currentPlayer(): { userId: string; username: string } | null {
  const userId = context.userId;
  const username = context.username;
  if (!userId || !username) return null;
  return { userId, username };
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

async function handleState(res: ServerResponse): Promise<void> {
  const player = currentPlayer();
  const now = Date.now();
  const board = await boardState(now);

  if (!player) {
    // Logged-out viewers still get to watch the board; they just cannot play.
    send(res, 200, {
      status: 'ok',
      board,
      you: {
        username: '',
        best: 0,
        rank: null,
        runs: 0,
        activeRunId: null,
        canPlay: false,
        cooldownMs: 0,
      },
      activity: await readActivity(board.roundIndex),
    } satisfies StateResponse);
    return;
  }

  const [activity, cooldownMs, active] = await Promise.all([
    readActivity(board.roundIndex),
    msUntilAllowed(player.userId, now),
    readActiveRun(player.userId),
  ]);

  const [best, rank, runs] = await Promise.all([
    bestOf(board.roundIndex, player.username),
    rankOf(board.roundIndex, player.username),
    runsOf(board.roundIndex, player.username),
  ]);

  send(res, 200, {
    status: 'ok',
    board,
    you: {
      username: player.username,
      best: Math.round(best),
      rank,
      runs,
      activeRunId: active?.runId ?? null,
      canPlay: cooldownMs === 0,
      cooldownMs,
    },
    activity,
  } satisfies StateResponse);
}

async function handleRunStart(res: ServerResponse): Promise<void> {
  const player = currentPlayer();
  if (!player) return fail(res, 401, 'no_user', 'Log in to Reddit to play.');

  const now = Date.now();
  const cooldown = await msUntilAllowed(player.userId, now);
  if (cooldown > 0) {
    return fail(
      res,
      429,
      'rate_limited',
      `Take a breath — ${Math.ceil(cooldown / 1000)}s until your next run.`,
    );
  }

  const roundIndex = roundIndexAt(now);
  const { run } = await startRun(player.userId, roundIndex, now);
  await ensurePlayer(roundIndex, player.username);

  send(res, 200, {
    status: 'ok',
    runId: run.runId,
    startedAt: run.startedAt,
    expiresAt: run.startedAt + MAX_RUN_MS,
    now,
    roundIndex: run.roundIndex,
    seed: run.seed,
    arenaIndex: arenaIndexAt(run.roundIndex),
    startTimeMs: START_TIME_MS,
  } satisfies RunStartResponse);
}

async function handleRunFinish(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const player = currentPlayer();
  if (!player) return fail(res, 401, 'no_user', 'Log in to Reddit to play.');

  const body = await readJson(req);
  const runId = typeof body.runId === 'string' ? body.runId : '';
  if (!runId) return fail(res, 400, 'bad_request', 'That submission was missing its run.');

  const now = Date.now();
  const run = await readActiveRun(player.userId);

  // No active run, or a different one, means this was already scored or never
  // started here. Either way there is nothing to award.
  if (!run || run.runId !== runId) {
    return fail(res, 409, 'run_duplicate', 'That run has already been counted.');
  }

  const roundIndex = roundIndexAt(now);
  const timing = validateTiming(run, now, roundIndex);
  if (!timing.ok) {
    // An early submit is recoverable, so the run is deliberately left in place
    // and nothing is spent — the client simply asks again once the clock has
    // caught up. Clearing here would turn a moment of clock skew into a lost
    // run, because the honest submit that follows would find nothing to score.
    if (timing.code === 'too_early') {
      return fail(res, 425, 'too_early', timing.message);
    }
    await clearActiveRun(player.userId);
    await markFinished(player.userId, now);
    return fail(res, 409, timing.code, timing.message);
  }

  // The atomic gate: only one request can ever claim this run id.
  if (!(await claimRun(runId, now))) {
    await clearActiveRun(player.userId);
    return fail(res, 409, 'run_duplicate', 'That run has already been counted.');
  }

  await clearActiveRun(player.userId);
  await markFinished(player.userId, now);

  const sanitized = sanitizeTally(body.tally);
  let { tally } = sanitized;
  let { adjusted } = sanitized;

  // The clock the client claims to have left has to be one it could ever have
  // held, given the starting tank and what it says it collected.
  if (!plausibleClock(tally)) {
    tally = { ...tally, msLeft: 0 };
    adjusted = true;
  }

  const { points, breakdown } = scoreRun(tally);

  const runs = await bumpRuns(roundIndex, player.username);
  const { best, personalBest } = await recordScore(roundIndex, player.username, points);

  const newActivity: ActivityItem[] = [];
  if (points > 0) {
    newActivity.push(
      await pushActivity(roundIndex, {
        kind: personalBest ? 'best' : 'finished',
        username: player.username,
        points,
        at: now,
      }),
    );
  }

  const top = await topOf(roundIndex);
  const tookLead = await noteLeadChange(roundIndex, top.player);
  if (tookLead && top.player === player.username) {
    newActivity.push(
      await pushActivity(roundIndex, {
        kind: 'lead',
        username: player.username,
        points: top.score ?? points,
        at: now + 1,
      }),
    );
  }

  const [board, rank, activity] = await Promise.all([
    boardState(Date.now()),
    rankOf(roundIndex, player.username),
    readActivity(roundIndex),
  ]);

  send(res, 200, {
    status: 'ok',
    points,
    breakdown,
    adjusted,
    personalBest: personalBest && points > 0,
    tookLead: tookLead && top.player === player.username,
    board,
    you: { best: Math.round(best), rank, runs },
    activity,
  } satisfies RunFinishResponse);
}

async function handleLeaderboard(res: ServerResponse): Promise<void> {
  const player = currentPlayer();
  const roundIndex = roundIndexAt(Date.now());
  send(res, 200, {
    status: 'ok',
    players: await leaderboard(roundIndex, player?.username ?? ''),
    roundIndex,
  } satisfies LeaderboardResponse);
}

async function handleActivity(res: ServerResponse): Promise<void> {
  const roundIndex = roundIndexAt(Date.now());
  send(res, 200, {
    status: 'ok',
    activity: await readActivity(roundIndex),
  } satisfies ActivityResponse);
}

/* -------------------------------------------------------------------------- */
/* Post creation                                                              */
/* -------------------------------------------------------------------------- */

async function createGamePost(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({
    subredditName: context.subredditName,
    title: TITLE,
    textFallback: { text: TEXT_FALLBACK },
  });
  return {
    navigateTo: post,
    showToast: { text: 'Clockshot post created.', appearance: 'success' },
  };
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

const server = createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    switch (`${method} ${path}`) {
      case 'GET /api/state':
        return await handleState(res);
      case 'POST /api/run/start':
        return await handleRunStart(res);
      case 'POST /api/run/finish':
        return await handleRunFinish(req, res);
      case 'GET /api/leaderboard':
        return await handleLeaderboard(res);
      case 'GET /api/activity':
        return await handleActivity(res);

      case 'POST /internal/menu/create-post':
        return send(res, 200, await createGamePost());
      case 'POST /internal/on-app-install':
        await createGamePost();
        return send(res, 200, { status: 'ok' });

      default:
        return fail(res, 404, 'bad_request', `Unknown endpoint: ${method} ${path}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[clockshot] ${method} ${path} failed:`, message);
    if (path.startsWith('/internal/')) {
      return send(res, 500, { showToast: `Clockshot: ${message}` } satisfies UiResponse);
    }
    return fail(res, 500, 'server_error', 'Something went wrong on our side. Try again.');
  }
});

server.listen(getServerPort());
