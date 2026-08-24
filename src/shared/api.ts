/**
 * The wire contract between the Clockshot client and its Devvit server.
 *
 * Every response the client renders is shaped here. Note what is absent from
 * the request types: the client never sends a username, a score, or a
 * timestamp it computed itself. It sends what it did during a run; the server
 * decides what that was worth.
 */

/**
 * Raw tally of what a player did during one run.
 *
 * Everything here is a count or a duration — never a score. `anchorsUsed` is
 * the number of *distinct* anchors the player swung from, which is what the
 * points are paid on.
 */
export interface RunTally {
  /** True only if the player actually touched the goal. */
  reachedGoal: boolean;
  /** Milliseconds still on the clock at the moment they reached it. */
  msLeft: number;
  anchorsUsed: number;
  clocks: number;
  goldens: number;
  hits: number;
}

export const EMPTY_TALLY: RunTally = {
  reachedGoal: false,
  msLeft: 0,
  anchorsUsed: 0,
  clocks: 0,
  goldens: 0,
  hits: 0,
};

/** A player's standing on the board. */
export interface LeaderRow {
  rank: number;
  username: string;
  points: number;
  /** True for the requesting player, so the client can highlight the row. */
  isYou: boolean;
}

export type ActivityKind = 'finished' | 'best' | 'lead' | 'windowEnd';

/** One line in the community feed. Rendered from these fields, not a string. */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  username: string;
  points: number;
  at: number;
}

/** The shared state of the current leaderboard window. */
export interface BoardState {
  roundIndex: number;
  startsAt: number;
  endsAt: number;
  /** Server clock at the moment of the response; the client corrects drift. */
  now: number;
  /** Best score anyone has posted this window, or null if nobody has yet. */
  topScore: number | null;
  topPlayer: string | null;
  players: number;
  previous: PreviousWindow | null;
}

export interface PreviousWindow {
  roundIndex: number;
  topScore: number | null;
  topPlayer: string | null;
}

/** Everything the client needs to render the menu in one call. */
export interface StateResponse {
  status: 'ok';
  board: BoardState;
  you: {
    username: string;
    /** This player's best score in the current window. */
    best: number;
    rank: number | null;
    runs: number;
    /** Set when this player already has a run in flight. */
    activeRunId: string | null;
    canPlay: boolean;
    cooldownMs: number;
  };
  activity: ActivityItem[];
}

export interface RunStartResponse {
  status: 'ok';
  runId: string;
  /** Server time the run began, and the latest it may be submitted. */
  startedAt: number;
  expiresAt: number;
  now: number;
  roundIndex: number;
  /** Seed so the arena layout is identical if the player refreshes mid-run. */
  seed: number;
  /** Which arena this window is played in. */
  arenaIndex: number;
  /** Milliseconds the player starts with on the clock. */
  startTimeMs: number;
}

export interface RunFinishRequest {
  runId: string;
  tally: RunTally;
}

export interface RunFinishResponse {
  status: 'ok';
  /** What the server decided the run was worth, after capping. */
  points: number;
  /** The parts that made up that number, so the screen can show its working. */
  breakdown: {
    goal: number;
    anchors: number;
    time: number;
  };
  /** Set when the server clamped the client's claim. */
  adjusted: boolean;
  /** True when this beat the player's own best this window. */
  personalBest: boolean;
  /** True when this took the top of the board. */
  tookLead: boolean;
  board: BoardState;
  you: {
    best: number;
    rank: number | null;
    runs: number;
  };
  activity: ActivityItem[];
}

export interface LeaderboardResponse {
  status: 'ok';
  players: LeaderRow[];
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
