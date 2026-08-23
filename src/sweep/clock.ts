import { SWEEP_PERIOD, AFTERGLOW_FLOOR, CENTER_DEADZONE, INK_WEDGES } from './tuning';

/**
 * The sweep clock (GDD §3).
 *
 * `h(t) = 360 * (t mod P) / P`, hand turning clockwise from 12 o'clock.
 * Everything downstream is a pure function of this angle, which is what makes
 * a replay identical for every player and independent of frame rate.
 *
 * The clock is advanced by explicit delta-time rather than read from
 * `performance.now()` so that pausing, losing focus, and scene restarts are all
 * exact: no wall-clock drift can leak into gameplay.
 */
export class SweepClock {
  /** Elapsed session time in ms. Only ever moves forward via `advance()`. */
  private t = 0;
  private paused = false;

  constructor(public period: number = SWEEP_PERIOD) {}

  reset(t = 0): void {
    this.t = t;
    this.paused = false;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Advance by a frame delta in ms. Large deltas (tab was backgrounded) are
   *  clamped so the hand never teleports through a whole rotation. */
  advance(deltaMs: number): void {
    if (this.paused) return;
    this.t += Math.min(Math.max(deltaMs, 0), 100);
  }

  /** Session time in ms. */
  now(): number {
    return this.t;
  }

  /** Hand angle in degrees, 0 = 12 o'clock, increasing clockwise. */
  handAngle(): number {
    return (360 * (this.t % this.period)) / this.period;
  }

  /** Completed rotations, fractional. */
  sweeps(): number {
    return this.t / this.period;
  }

  /** Whole rotations completed. */
  sweepIndex(): number {
    return Math.floor(this.t / this.period);
  }

  /** 0..1 through the current rotation. */
  sweepPhase(): number {
    return (this.t % this.period) / this.period;
  }
}

/** Signed angle of a point in the unit circle, degrees clockwise from 12.
 *  Points near the hub have no meaningful angle, so they pin to 0 (§3). */
export function angleOf(x: number, y: number): number {
  const r = Math.hypot(x, y);
  if (r < CENTER_DEADZONE) return 0;
  // Screen y grows downward; 12 o'clock is -y. atan2(x, -y) gives clockwise-from-12.
  const deg = (Math.atan2(x, -y) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** Age of a point as a 0..1 fraction of a rotation: 1 = freshly behind the
 *  hand, 0 = the hand is on it right now (GDD §3 `a`). */
export function freshness(handDeg: number, pointDeg: number): number {
  return 1 - (((handDeg - pointDeg) % 360) + 360) % 360 / 360;
}

/** Render alpha for a point: the GDD's `1.0 -> 0.25` remap of `a`. */
export function afterglowAlpha(handDeg: number, pointDeg: number): number {
  const a = freshness(handDeg, pointDeg);
  return AFTERGLOW_FLOOR + (1 - AFTERGLOW_FLOOR) * a;
}

/** Which angular wedge an angle falls in. */
export function wedgeOf(deg: number): number {
  const w = Math.floor((deg / 360) * INK_WEDGES);
  return w < 0 ? 0 : w >= INK_WEDGES ? INK_WEDGES - 1 : w;
}

/** Center angle of a wedge, in degrees. */
export function wedgeCenter(index: number): number {
  return ((index + 0.5) / INK_WEDGES) * 360;
}

/** Shortest forward distance from `from` to `to` in degrees (0..360). */
export function forwardDelta(from: number, to: number): number {
  return (((to - from) % 360) + 360) % 360;
}
