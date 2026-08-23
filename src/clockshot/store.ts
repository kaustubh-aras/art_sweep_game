import { api, NetError } from './net';
import type { ActivityItem, CommunityState, StateResponse } from '../shared/api';
import type { Team } from '../shared/config';

/**
 * The client's view of the shared world, plus the clock correction that makes
 * it trustworthy.
 *
 * The device clock is never used to decide anything. Every response carries the
 * server's `now`, and the offset between that and `Date.now()` is kept here, so
 * "how long is left in this round" is answered in server time even if the
 * player's device clock is wrong by hours.
 */

type Listener = () => void;

class Store {
  private offsetMs = 0;
  private haveOffset = false;

  community: CommunityState | null = null;
  username = '';
  team: Team | null = null;
  contribution = 0;
  rank: number | null = null;
  canPlay = false;
  cooldownMs = 0;
  activity: ActivityItem[] = [];

  /** Set when the last refresh failed, so screens can show a reconnect state. */
  lastError: NetError | null = null;
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

  /** Milliseconds left in the community round, floored at zero. */
  msLeftInRound(): number {
    if (!this.community) return 0;
    return Math.max(0, this.community.endsAt - this.serverNow());
  }

  /** True once the round we hold state for has run out. */
  get roundStale(): boolean {
    return this.community !== null && this.msLeftInRound() <= 0;
  }

  apply(res: StateResponse): void {
    this.syncClock(res.community.now);
    this.community = res.community;
    this.username = res.you.username;
    this.team = res.you.team;
    this.contribution = res.you.contribution;
    this.rank = res.you.rank;
    this.canPlay = res.you.canPlay;
    this.cooldownMs = res.you.cooldownMs;
    this.activity = res.activity;
    this.lastError = null;
    this.loaded = true;
    this.emit();
  }

  /** Folds a run's result in without waiting for another round trip. */
  applyCommunity(community: CommunityState, activity: ActivityItem[]): void {
    this.syncClock(community.now);
    this.community = community;
    this.activity = activity;
    this.emit();
  }

  setTeam(team: Team): void {
    this.team = team;
    this.emit();
  }

  async refresh(): Promise<void> {
    try {
      this.apply(await api.state());
    } catch (err) {
      this.lastError = err instanceof NetError ? err : new NetError('server_error', 'Unknown error.');
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

/**
 * Formats a duration as m:ss, which is how every clock in the game reads.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Seconds, for the run timer, where a minute never appears. */
export function formatSeconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

/** Turns an activity item into the line a player reads. */
export function activityLine(item: ActivityItem): string {
  const who = `u/${item.username}`;
  const team = item.team === 'red' ? 'Red Team' : 'Blue Team';
  switch (item.kind) {
    case 'added':
      return `${who} added ${item.seconds}s to ${team}.`;
    case 'stole':
      return `${who} stole ${item.seconds}s from ${item.team === 'red' ? 'Blue Team' : 'Red Team'}.`;
    case 'lead':
      return `${team} has taken the lead.`;
    case 'golden':
      return `${team} collected the Golden Clock.`;
    case 'joined':
      return `${who} joined ${team}.`;
    case 'roundEnd':
      return `The community round has ended. ${team} wins.`;
    default:
      return `${who} played a run.`;
  }
}
