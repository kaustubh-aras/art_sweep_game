import { api, NetError } from './net';
import type { ActivityItem, BoardState, StateResponse } from '../shared/api';

/**
 * The client's view of the board, plus the clock correction that makes it
 * trustworthy.
 *
 * The device clock is never used to decide anything. Every response carries the
 * server's `now`, and the offset between that and `Date.now()` is kept here, so
 * "how long is left in this window" is answered in server time even if the
 * player's device clock is wrong by hours.
 */

type Listener = () => void;

class Store {
  private offsetMs = 0;
  private haveOffset = false;

  board: BoardState | null = null;
  username = '';
  /** This player's best score in the current window. */
  best = 0;
  rank: number | null = null;
  runs = 0;
  canPlay = false;
  cooldownMs = 0;
  activity: ActivityItem[] = [];

  /** Set when the last refresh failed, so screens can show a reconnect state. */
  lastError: NetError | null = null;
  /** The refresh currently in flight, so simultaneous callers share one call. */
  private inflight: Promise<void> | null = null;
  loaded = false;

  private listeners = new Set<Listener>();

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // A broken listener must not stop the others from updating.
      }
    }
  }

  /** Server time right now, corrected for this device's clock drift. */
  serverNow(): number {
    return Date.now() + this.offsetMs;
  }

  private syncClock(serverTime: number): void {
    this.offsetMs = serverTime - Date.now();
    this.haveOffset = true;
  }

  get clockSynced(): boolean {
    return this.haveOffset;
  }

  /** Milliseconds left in the current board window, floored at zero. */
  msLeftInWindow(): number {
    if (!this.board) return 0;
    return Math.max(0, this.board.endsAt - this.serverNow());
  }

  /** True once the window we hold state for has run out. */
  get windowStale(): boolean {
    return this.board !== null && this.msLeftInWindow() <= 0;
  }

  apply(res: StateResponse): void {
    this.syncClock(res.board.now);
    this.board = res.board;
    this.username = res.you.username;
    this.best = res.you.best;
    this.rank = res.you.rank;
    this.runs = res.you.runs;
    this.canPlay = res.you.canPlay;
    this.cooldownMs = res.you.cooldownMs;
    this.activity = res.activity;
    this.lastError = null;
    this.loaded = true;
    this.emit();
  }

  /** Folds a run's result in without waiting for another round trip. */
  applyBoard(board: BoardState, activity: ActivityItem[]): void {
    this.syncClock(board.now);
    this.board = board;
    this.activity = activity;
    this.emit();
  }

  /**
   * Refreshes the board, once, however many callers ask at the same moment.
   *
   * The splash card and the boot scene both want this state the instant the
   * post opens. Sharing the call in flight makes that one request instead of
   * two identical ones racing each other.
   */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchState();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async fetchState(): Promise<void> {
    try {
      this.apply(await api.state());
    } catch (err) {
      this.lastError =
        err instanceof NetError ? err : new NetError('server_error', 'Unknown error.');
      this.emit();
      throw err;
    }
  }

  /** Refresh without surfacing a failure — for background polling. */
  async refreshQuietly(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      // The store already recorded the error; a poll failing is not an event.
    }
  }
}

export const store = new Store();

/** Formats a duration as m:ss, which is how every window clock reads. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Seconds to one decimal, for the run clock where a minute never appears. */
export function formatSeconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

/** Thousands separators, so a five-figure score stays readable at a glance. */
export function formatPoints(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Turns an activity item into the line a player reads. */
export function activityLine(item: ActivityItem): string {
  const who = `u/${item.username}`;
  const pts = formatPoints(item.points);
  switch (item.kind) {
    case 'finished':
      return `${who} scored ${pts}.`;
    case 'best':
      return `${who} set a new personal best — ${pts}.`;
    case 'lead':
      return `${who} took the top spot with ${pts}.`;
    case 'windowEnd':
      return `The board reset. ${who} finished on top with ${pts}.`;
    default:
      return `${who} took a run.`;
  }
}
