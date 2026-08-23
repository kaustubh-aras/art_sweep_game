/**
 * The wire contract between the Clockshot client and its Devvit server.
 *
 * Every response the client renders is shaped here. Note what is absent from
 * the request types: the client never sends a username, a team bank, or a
 * timestamp it computed itself. It sends what it did during a run; the server
 * decides what that was worth.
 */
import type { Team } from './config';

/** Raw tally of what a player did during one run. All values are counts. */
export interface RunTally {
  fragments: number;
  largeFragments: number;
  goldenClocks: number;
  enemyFragments: number;
  enemyKills: number;
  hazardHits: number;
  falls: number;
}

export const EMPTY_TALLY: RunTally = {
  fragments: 0,
  largeFragments: 0,
  goldenClocks: 0,
  enemyFragments: 0,
  enemyKills: 0,
  hazardHits: 0,
  falls: 0,
};

/** A player's standing, used by both leaderboards. */
export interface LeaderRow {
  rank: number;
  username: string;
  seconds: number;
  team: Team | null;
  /** True for the requesting player, so the client can highlight the row. */
  isYou: boolean;
}

export type ActivityKind =
  | 'added'
  | 'stole'
  | 'lead'
  | 'golden'
  | 'joined'
  | 'roundEnd';

/** One line in the community feed. Rendered from these fields, not a string. */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  username: string;
  team: Team;
  seconds: number;
  at: number;
}

/** The shared state of the current community round. */
export interface CommunityState {
  roundIndex: number;
  startsAt: number;
  endsAt: number;
  /** Server clock at the moment of the response; the client corrects drift. */
  now: number;
  banks: Record<Team, number>;
  leader: Team | null;
  players: number;
  previous: PreviousRound | null;
}

export interface PreviousRound {
  roundIndex: number;
  banks: Record<Team, number>;
  winner: Team | null;
  /** True when the round ended level. */
  draw: boolean;
}

/** Everything the client needs to render the menu and dashboard in one call. */
export interface StateResponse {
  status: 'ok';
  community: CommunityState;
  you: {
    username: string;
    team: Team | null;
    /** Seconds this player has contributed during the current round. */
    contribution: number;
    rank: number | null;
    /** Set when this player already has a run in flight. */
    activeRunId: string | null;
    /** True once the player may start another run. */
    canPlay: boolean;
    cooldownMs: number;
  };
  activity: ActivityItem[];
}

export interface TeamRequest {
  team: Team;
}

export interface TeamResponse {
  status: 'ok';
  team: Team;
  /** False when the pick was rejected because the round already has their runs. */
  changed: boolean;
  message?: string;
}

export interface RunStartResponse {
  status: 'ok';
  runId: string;
  /** Server time the run began, and when it must be submitted by. */
  startedAt: number;
  expiresAt: number;
  now: number;
  /** Null when the player has not picked a side yet — they choose after. */
  team: Team | null;
  roundIndex: number;
  /** Seed so the arena layout is identical if the player refreshes mid-run. */
  seed: number;
  /**
   * Which arena this round is played in.
   *
   * Derived from the round index, so everybody playing right now is in the same
   * place and their scores are comparable. The server picks the number; the
   * client owns what that number looks like.
   */
  arenaIndex: number;
}

export interface RunFinishRequest {
  runId: string;
  tally: RunTally;
  /**
   * The side these seconds go to, sent only when the run started without one.
   *
   * This is the play-first path: a new player runs, sees what they earned, and
   * *then* decides who gets it — which turns the team choice from a toll gate
   * into a reward. Ignored when the run already carries a team.
   */
  team?: Team;
}

export interface RunFinishResponse {
  status: 'ok';
  /** What the server decided the run was worth, after capping. */
  awarded: number;
  stolen: number;
  /** Set when the server clamped the client's claim. */
  adjusted: boolean;
  community: CommunityState;
  you: {
    team: Team;
    contribution: number;
    rank: number | null;
  };
  leadChanged: boolean;
  activity: ActivityItem[];
}

export interface LeaderboardResponse {
  status: 'ok';
  players: LeaderRow[];
  teams: { team: Team; seconds: number }[];
  roundIndex: number;
}

export interface ActivityResponse {
  status: 'ok';
  activity: ActivityItem[];
}

/** Every failure the client can encounter, in a shape it can act on. */
export interface ErrorResponse {
  status: 'error';
  code:
    | 'no_user'
    | 'no_team'
    | 'bad_request'
    | 'run_not_found'
    | 'run_expired'
    /** The run window has not closed yet. Recoverable — ask again shortly. */
    | 'too_early'
    | 'run_duplicate'
    | 'round_changed'
    | 'rate_limited'
    | 'server_error';
  message: string;
}

export type ApiResponse<T> = T | ErrorResponse;

export function isError(r: unknown): r is ErrorResponse {
  return typeof r === 'object' && r !== null && (r as ErrorResponse).status === 'error';
}
