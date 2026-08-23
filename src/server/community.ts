import { redis } from '@devvit/web/server';
import { K } from './keys';
import {
  ACTIVITY_SIZE,
  LEADERBOARD_SIZE,
  ROUND_RETENTION_MS,
  STARTING_BANK,
  TEAMS,
  type Team,
  isTeam,
  otherTeam,
  roundIndexAt,
  roundWindow,
} from '../shared/config';
import type { ActivityItem, CommunityState, LeaderRow, PreviousRound } from '../shared/api';

/**
 * The shared community round.
 *
 * Rounds are derived from the wall clock (`roundIndexAt`) rather than created
 * by a scheduled job, so there is nothing to go wrong at a boundary: the round
 * a request belongs to is a pure function of when it arrived. A round's state
 * is whatever accumulated under its index, and old indices expire on their own.
 */

/** Seconds a bank holds, given the stored delta. Never below zero. */
function bankFromDelta(delta: number): number {
  return Math.max(0, STARTING_BANK + delta);
}

function parseDelta(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Marks every key belonging to a round so it cleans itself up later. */
async function touchRoundTtl(index: number): Promise<void> {
  const seconds = Math.ceil(ROUND_RETENTION_MS / 1000);
  const keys = [
    K.banks(index),
    K.players(index),
    K.playerTeams(index),
    K.activity(index),
    K.meta(index),
  ];
  // Expiry is best-effort: a round that outlives its TTL window is harmless,
  // and a failure here must never fail the player's request.
  await Promise.all(keys.map((k) => redis.expire(k, seconds).catch(() => undefined)));
}

export async function readBanks(index: number): Promise<Record<Team, number>> {
  const raw = await redis.hGetAll(K.banks(index));
  return {
    red: bankFromDelta(parseDelta(raw?.red)),
    blue: bankFromDelta(parseDelta(raw?.blue)),
  };
}

export function leaderOf(banks: Record<Team, number>): Team | null {
  if (banks.red === banks.blue) return null;
  return banks.red > banks.blue ? 'red' : 'blue';
}

/**
 * Adds `seconds` to a team's bank atomically.
 *
 * `hIncrBy` is the whole mechanism — two runs landing at once each get their
 * own increment, so neither can overwrite the other. When seconds are taken
 * away the delta is pinned so the bank can never read below zero, and the
 * amount actually removed is returned rather than the amount requested.
 */
export async function addToBank(
  index: number,
  team: Team,
  seconds: number,
): Promise<{ applied: number; bank: number }> {
  if (seconds === 0) {
    const banks = await readBanks(index);
    return { applied: 0, bank: banks[team] };
  }

  const delta = await redis.hIncrBy(K.banks(index), team, seconds);
  const floor = -STARTING_BANK;

  if (delta < floor) {
    // We took more than the bank held. Give back the overshoot so the stored
    // delta lands exactly on empty, and report only what really came off.
    const overshoot = floor - delta;
    await redis.hIncrBy(K.banks(index), team, overshoot);
    return { applied: seconds + overshoot, bank: 0 };
  }

  return { applied: seconds, bank: bankFromDelta(delta) };
}

/** Records a player's contribution on the round leaderboard. */
export async function addContribution(
  index: number,
  username: string,
  team: Team,
  seconds: number,
): Promise<number> {
  const total = await redis.zIncrBy(K.players(index), username, seconds);
  await redis.hSet(K.playerTeams(index), { [username]: team });
  return total;
}

/**
 * Ensures a player appears on the round's board even before they score, so the
 * "players this round" count reflects everyone who turned up.
 */
export async function ensurePlayer(
  index: number,
  username: string,
  team: Team,
): Promise<void> {
  const existing = await redis.zScore(K.players(index), username);
  if (existing === undefined) {
    await redis.zAdd(K.players(index), { member: username, score: 0 });
  }
  await redis.hSet(K.playerTeams(index), { [username]: team });
  await touchRoundTtl(index);
}

export async function playerCount(index: number): Promise<number> {
  return (await redis.zCard(K.players(index))) ?? 0;
}

export async function contributionOf(index: number, username: string): Promise<number> {
  return (await redis.zScore(K.players(index), username)) ?? 0;
}

/** 1-based rank on the individual board, or null if the player is off it. */
export async function rankOf(index: number, username: string): Promise<number | null> {
  const rows = await redis.zRange(K.players(index), 0, LEADERBOARD_SIZE - 1, {
    by: 'rank',
    reverse: true,
  });
  const at = rows.findIndex((r) => r.member === username);
  return at === -1 ? null : at + 1;
}

export async function leaderboard(index: number, you: string): Promise<LeaderRow[]> {
  const rows = await redis.zRange(K.players(index), 0, LEADERBOARD_SIZE - 1, {
    by: 'rank',
    reverse: true,
  });
  if (rows.length === 0) return [];

  const teams = (await redis.hGetAll(K.playerTeams(index))) ?? {};
  return rows.map((r, i) => ({
    rank: i + 1,
    username: r.member,
    seconds: Math.round(r.score),
    team: isTeam(teams[r.member]) ? (teams[r.member] as Team) : null,
    isYou: r.member === you,
  }));
}

/* -------------------------------------------------------------------------- */
/* Activity feed                                                              */
/* -------------------------------------------------------------------------- */

let activityCounter = 0;

/**
 * Appends to the round's feed.
 *
 * The feed is a sorted set scored by timestamp rather than a list, because the
 * Devvit Redis client offers no list operations. Members must stay unique, so
 * each item carries an id — two players scoring the same amount in the same
 * millisecond would otherwise collapse into a single entry.
 */
export async function pushActivity(
  index: number,
  item: Omit<ActivityItem, 'id'>,
): Promise<ActivityItem> {
  const salt = Math.floor(Math.random() * 1e6).toString(36);
  const id = [item.at.toString(36), (activityCounter++).toString(36), salt].join('-');
  const full: ActivityItem = { ...item, id };

  await redis.zAdd(K.activity(index), {
    member: JSON.stringify(full),
    score: item.at,
  });

  // Keep the feed bounded. Ranks run low-to-high, so dropping everything below
  // the last ACTIVITY_SIZE entries leaves exactly the newest behind.
  await redis
    .zRemRangeByRank(K.activity(index), 0, -(ACTIVITY_SIZE + 1))
    .catch(() => undefined);

  return full;
}

export async function readActivity(index: number): Promise<ActivityItem[]> {
  const rows = await redis.zRange(K.activity(index), 0, ACTIVITY_SIZE - 1, {
    by: 'rank',
    reverse: true,
  });
  const out: ActivityItem[] = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.member) as ActivityItem;
      if (parsed && typeof parsed.username === 'string') out.push(parsed);
    } catch {
      // A malformed entry must not take the whole feed down with it.
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Lead tracking                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns true when this call is the one that flipped the lead, so exactly one
 * "has taken the lead" line reaches the feed no matter how many runs land.
 */
export async function noteLeadChange(index: number, leader: Team | null): Promise<boolean> {
  const key = K.meta(index);
  const prev = (await redis.hGet(key, 'leader')) ?? '';
  const next = leader ?? 'tie';
  if (prev === next) return false;
  await redis.hSet(key, { leader: next });
  // Only announce a real takeover, not the first write and not a drop to a tie.
  return prev !== '' && leader !== null;
}

/* -------------------------------------------------------------------------- */
/* Round assembly                                                             */
/* -------------------------------------------------------------------------- */

export async function previousRound(index: number): Promise<PreviousRound | null> {
  const prevIndex = index - 1;
  const [banks, played] = await Promise.all([
    readBanks(prevIndex),
    playerCount(prevIndex),
  ]);
  // A round nobody played is not worth reporting a winner for.
  if (played === 0 && banks.red === STARTING_BANK && banks.blue === STARTING_BANK) {
    return null;
  }
  const winner = leaderOf(banks);
  return { roundIndex: prevIndex, banks, winner, draw: winner === null };
}

export async function communityState(nowMs: number): Promise<CommunityState> {
  const index = roundIndexAt(nowMs);
  const { startsAt, endsAt } = roundWindow(index);
  const [banks, players, previous] = await Promise.all([
    readBanks(index),
    playerCount(index),
    previousRound(index),
  ]);
  return {
    roundIndex: index,
    startsAt,
    endsAt,
    now: nowMs,
    banks,
    leader: leaderOf(banks),
    players,
    previous,
  };
}

export function teamTotals(banks: Record<Team, number>): { team: Team; seconds: number }[] {
  return [...TEAMS]
    .map((team) => ({ team, seconds: banks[team] }))
    .sort((a, b) => b.seconds - a.seconds);
}

export { otherTeam };
