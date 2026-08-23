import { context, createServer, getServerPort, reddit } from '@devvit/web/server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UiResponse } from '@devvit/web/shared';

import { K } from './keys';
import { redis } from '@devvit/web/server';
import {
  addContribution,
  addToBank,
  communityState,
  contributionOf,
  ensurePlayer,
  leaderOf,
  leaderboard,
  noteLeadChange,
  pushActivity,
  rankOf,
  readActivity,
  readBanks,
  teamTotals,
} from './community';
import {
  claimRun,
  clearActiveRun,
  msUntilAllowed,
  markFinished,
  readActiveRun,
  sanitizeTally,
  scoreRun,
  startRun,
  validateTiming,
} from './runs';
import { RUN_MS, arenaIndexAt, isTeam, otherTeam, roundIndexAt, type Team } from '../shared/config';
import type {
  ActivityItem,
  ActivityResponse,
  ErrorResponse,
  LeaderboardResponse,
  RunFinishResponse,
  RunStartResponse,
  StateResponse,
  TeamResponse,
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

const TITLE = 'Clockshot — Community Time War';

const TEXT_FALLBACK = [
  '**Clockshot** is a community time war.',
  '',
  'Pick Red or Blue, take a 30-second grappling run through the arena, and every',
  'second you bank goes straight into the shared team clock. Whichever team is',
  'ahead when the community round ends wins it.',
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
 *   Failed to POST to Node.js server endpoint /internal/on-app-install;
 *   server responded with Content-Length header "null" but greater than zero
 *   required for nonempty response
 *
 * That surfaced as a failed app install on the very first upload, and it would
 * have broken every endpoint in this file the same way — the local dev harness
 * is a plain Node server and accepts chunked replies quite happily, so nothing
 * short of a real deploy could have caught it.
 *
 * The byte length has to come from a Buffer rather than `string.length`:
 * usernames and activity lines are UTF-8, and any non-ASCII character would
 * make a character count disagree with the bytes actually on the wire.
 */
function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body) ?? 'null', 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.byteLength),
  });
  res.end(payload);
}

function fail(res: ServerResponse, status: number, code: ErrorResponse['code'], message: string): void {
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
/* Team selection                                                             */
/* -------------------------------------------------------------------------- */

async function readTeam(userId: string): Promise<Team | null> {
  const raw = await redis.get(K.playerTeam(userId));
  return isTeam(raw) ? raw : null;
}

async function writeTeam(userId: string, team: Team): Promise<void> {
  await redis.set(K.playerTeam(userId), team);
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

async function handleState(res: ServerResponse): Promise<void> {
  const player = currentPlayer();
  const now = Date.now();
  const community = await communityState(now);

  if (!player) {
    // Logged-out viewers still get to watch the battle; they just cannot play.
    send(res, 200, {
      status: 'ok',
      community,
      you: {
        username: '',
        team: null,
        contribution: 0,
        rank: null,
        activeRunId: null,
        canPlay: false,
        cooldownMs: 0,
      },
      activity: await readActivity(community.roundIndex),
    } satisfies StateResponse);
    return;
  }

  const [team, activity, cooldownMs, active] = await Promise.all([
    readTeam(player.userId),
    readActivity(community.roundIndex),
    msUntilAllowed(player.userId, now),
    readActiveRun(player.userId),
  ]);

  const [contribution, rank] = await Promise.all([
    contributionOf(community.roundIndex, player.username),
    rankOf(community.roundIndex, player.username),
  ]);

  send(res, 200, {
    status: 'ok',
    community,
    you: {
      username: player.username,
      team,
      contribution: Math.round(contribution),
      rank,
      activeRunId: active?.runId ?? null,
      // Not having a side no longer blocks a run — the choice comes after.
      canPlay: cooldownMs === 0,
      cooldownMs,
    },
    activity,
  } satisfies StateResponse);
}

async function handleTeam(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const player = currentPlayer();
  if (!player) return fail(res, 401, 'no_user', 'Log in to Reddit to pick a team.');

  const body = await readJson(req);
  if (!isTeam(body.team)) {
    return fail(res, 400, 'bad_request', 'Pick either the red team or the blue team.');
  }

  const now = Date.now();
  const roundIndex = roundIndexAt(now);
  const current = await readTeam(player.userId);

  if (current === body.team) {
    await ensurePlayer(roundIndex, player.username, body.team);
    return send(res, 200, { status: 'ok', team: body.team, changed: false } satisfies TeamResponse);
  }

  // Switching sides mid-round would let one player bank for both teams, so the
  // choice locks as soon as they have contributed anything to this round.
  if (current !== null) {
    const contributed = await contributionOf(roundIndex, player.username);
    if (contributed > 0) {
      return send(res, 200, {
        status: 'ok',
        team: current,
        changed: false,
        message: 'You have already played for your team this round. You can switch when the next round begins.',
      } satisfies TeamResponse);
    }
  }

  await writeTeam(player.userId, body.team);
  await ensurePlayer(roundIndex, player.username, body.team);

  const joined = await pushActivity(roundIndex, {
    kind: 'joined',
    username: player.username,
    team: body.team,
    seconds: 0,
    at: now,
  });
  void joined;

  send(res, 200, { status: 'ok', team: body.team, changed: true } satisfies TeamResponse);
}

async function handleRunStart(res: ServerResponse): Promise<void> {
  const player = currentPlayer();
  if (!player) return fail(res, 401, 'no_user', 'Log in to Reddit to play.');

  // No team is not an error here. A first-time player is sent straight into a
  // run and picks a side when they bank it — being asked to commit to a colour
  // before seeing the game is the single biggest thing standing between a new
  // player and their first thirty seconds.
  const team = await readTeam(player.userId);

  const now = Date.now();
  const cooldown = await msUntilAllowed(player.userId, now);
  if (cooldown > 0) {
    return fail(res, 429, 'rate_limited', `Take a breath — ${Math.ceil(cooldown / 1000)}s until your next run.`);
  }

  const roundIndex = roundIndexAt(now);
  const { run } = await startRun(player.userId, team, roundIndex, now);
  // Only a player who has actually chosen a side belongs on the round board.
  if (team) await ensurePlayer(roundIndex, player.username, team);

  send(res, 200, {
    status: 'ok',
    runId: run.runId,
    startedAt: run.startedAt,
    expiresAt: run.startedAt + RUN_MS,
    now,
    team: run.team,
    roundIndex: run.roundIndex,
    seed: run.seed,
    arenaIndex: arenaIndexAt(run.roundIndex),
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

  // No active run, or a different one, means this was already banked or never
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
    // run, because the honest submit that follows would find nothing to bank.
    if (timing.code === 'too_early') {
      return fail(res, 425, 'too_early', timing.message);
    }
    // A late or out-of-round run genuinely cannot count, and it still has to be
    // cleared or the player is stuck with a run they can never finish.
    await clearActiveRun(player.userId);
    await markFinished(player.userId, now);
    return fail(res, 409, timing.code, timing.message);
  }

  // Resolve which side these seconds belong to *before* the run is spent, so a
  // submission that arrives without a choice can simply be sent back for one
  // rather than burning the run.
  let team = run.team;
  if (!team) {
    if (!isTeam(body.team)) {
      return fail(res, 400, 'no_team', 'Pick a side to bank these seconds.');
    }
    // The round lock still wins: someone who already banked for a side this
    // round cannot use a teamless run to score for the other one.
    const existing = await readTeam(player.userId);
    const contributed = existing ? await contributionOf(roundIndex, player.username) : 0;
    if (existing && contributed > 0) {
      team = existing;
    } else {
      team = body.team;
      await writeTeam(player.userId, team);
    }
  }

  // The atomic gate: only one request can ever claim this run id.
  if (!(await claimRun(runId, now))) {
    await clearActiveRun(player.userId);
    return fail(res, 409, 'run_duplicate', 'That run has already been counted.');
  }

  await clearActiveRun(player.userId);
  await markFinished(player.userId, now);

  const { tally, adjusted } = sanitizeTally(body.tally);
  const { awarded, stolen } = scoreRun(tally);
  const foe = otherTeam(team);

  // Both bank writes are atomic increments, so simultaneous runs from other
  // players add to these totals rather than overwriting them.
  await addToBank(roundIndex, team, awarded);
  const loss = stolen > 0 ? await addToBank(roundIndex, foe, -stolen) : { applied: 0 };
  const actuallyStolen = Math.abs(loss.applied);

  const contribution = await addContribution(
    roundIndex,
    player.username,
    team,
    awarded + actuallyStolen,
  );

  const newActivity: ActivityItem[] = [];
  if (awarded > 0) {
    newActivity.push(
      await pushActivity(roundIndex, {
        kind: 'added',
        username: player.username,
        team,
        seconds: awarded,
        at: now,
      }),
    );
  }
  if (actuallyStolen > 0) {
    newActivity.push(
      await pushActivity(roundIndex, {
        kind: 'stole',
        username: player.username,
        team,
        seconds: actuallyStolen,
        at: now,
      }),
    );
  }
  if (tally.goldenClocks > 0) {
    newActivity.push(
      await pushActivity(roundIndex, {
        kind: 'golden',
        username: player.username,
        team,
        seconds: tally.goldenClocks,
        at: now,
      }),
    );
  }

  const banks = await readBanks(roundIndex);
  const leader = leaderOf(banks);
  const leadChanged = await noteLeadChange(roundIndex, leader);
  if (leadChanged && leader) {
    newActivity.push(
      await pushActivity(roundIndex, {
        kind: 'lead',
        username: player.username,
        team: leader,
        seconds: banks[leader],
        at: now + 1,
      }),
    );
  }

  const [community, rank, activity] = await Promise.all([
    communityState(Date.now()),
    rankOf(roundIndex, player.username),
    readActivity(roundIndex),
  ]);

  send(res, 200, {
    status: 'ok',
    awarded,
    stolen: actuallyStolen,
    adjusted,
    community,
    you: { team, contribution: Math.round(contribution), rank },
    leadChanged,
    activity,
  } satisfies RunFinishResponse);
}

async function handleLeaderboard(res: ServerResponse): Promise<void> {
  const player = currentPlayer();
  const now = Date.now();
  const roundIndex = roundIndexAt(now);
  const [players, banks] = await Promise.all([
    leaderboard(roundIndex, player?.username ?? ''),
    readBanks(roundIndex),
  ]);
  send(res, 200, {
    status: 'ok',
    players,
    teams: teamTotals(banks),
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
      case 'POST /api/team':
        return await handleTeam(req, res);
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
