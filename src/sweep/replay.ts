import { flatten, type InkPoint, type Recording } from './strokes';
import type { InkLayer } from './inkLayer';

/**
 * Streams a recording onto an InkLayer in step with the sweep clock (GDD §6).
 *
 * The replay is a pure function of (strokes, clock time): no wall-clock reads,
 * no accumulated float drift, and the loop point falls exactly on a rotation
 * boundary — so the ink from the previous loop is erased by the hand rather
 * than snapping away, and the seam is invisible.
 */
export class Replayer {
  private points: InkPoint[];
  private cursor = 0;
  private lastPhase = -1;
  private loop = 0;

  constructor(
    private rec: Recording,
    private ink: InkLayer,
  ) {
    this.points = flatten(rec);
  }

  /** Total loop length in ms. */
  get length(): number {
    return this.rec.length;
  }

  /** How many times the replay has wrapped. */
  get loops(): number {
    return this.loop;
  }

  reset(): void {
    this.cursor = 0;
    this.lastPhase = -1;
    this.loop = 0;
    this.ink.clearAll();
  }

  /** Feed every point whose timestamp has now passed. `tMs` is clock time. */
  update(tMs: number): void {
    const len = this.rec.length;
    if (len <= 0) return;
    const phase = tMs % len;

    if (this.lastPhase < 0) {
      this.lastPhase = 0;
      this.cursor = 0;
    } else if (phase < this.lastPhase) {
      // Wrapped: finish the tail of the loop, then start again from zero.
      this.emitUntil(len + 1);
      this.cursor = 0;
      this.loop++;
      this.ink.endStroke();
    }

    this.emitUntil(phase);
    this.lastPhase = phase;
  }

  private emitUntil(phase: number): void {
    const pts = this.points;
    while (this.cursor < pts.length && pts[this.cursor].t <= phase) {
      const p = pts[this.cursor];
      // A stroke id that changes between loops keeps loops from joining up;
      // InkLayer starts a fresh polyline whenever the id changes.
      this.ink.addPoint(p.x, p.y, p.ink, p.stroke + this.loop * 1_000_003);
      this.cursor++;
    }
  }
}
