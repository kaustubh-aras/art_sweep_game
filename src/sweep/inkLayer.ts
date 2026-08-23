import Phaser from 'phaser';
import { INK_WEDGES, DRAWER_GHOST_ALPHA } from './tuning';
import { angleOf, afterglowAlpha, wedgeOf, forwardDelta } from './clock';
import type { InkIndex } from './strokes';
import { T } from '@/ui/theme';

/** A run of consecutive points from one stroke that all live in one wedge. */
interface Poly {
  ink: InkIndex;
  /** Unit-space coords, flat: [x, y, x, y, ...]. */
  pts: number[];
  /** Which stroke laid this down, so separate strokes never join up. */
  stroke: number;
}

/**
 * The radar ink canvas (GDD §3).
 *
 * The naive implementation re-evaluates every recorded point's alpha every
 * frame. Instead we bucket ink into `INK_WEDGES` angular slices, each backed by
 * its own Graphics object:
 *
 *  - afterglow is a per-wedge `alpha` write — 60 float assignments a frame with
 *    no geometry rebuilt, so it costs nothing on a phone
 *  - erasure is `clear()` on the wedge the hand just entered, which is exactly
 *    the GDD rule: a point is erased the next time the hand reaches its angle
 *
 * The wedge's trailing edge is used for the alpha lookup, so ink laid down
 * immediately behind the hand reads at full brightness instead of flickering.
 */
export class InkLayer {
  private container: Phaser.GameObjects.Container;
  private gfx: Phaser.GameObjects.Graphics[] = [];
  /** Retained geometry per wedge so a resize can rebuild without losing ink. */
  private polys: Poly[][] = [];
  /** The open polyline per wedge, so streaming points extend instead of restart. */
  private open: (Poly | null)[] = [];

  private radius = 1;
  private lineWidth = 4;
  private lastHand = 0;
  private primed = false;

  constructor(scene: Phaser.Scene, depth: number) {
    this.container = scene.add.container(0, 0).setDepth(depth);
    for (let i = 0; i < INK_WEDGES; i++) {
      const g = scene.add.graphics();
      this.gfx.push(g);
      this.polys.push([]);
      this.open.push(null);
      this.container.add(g);
    }
  }

  /** Place and scale the layer. Safe to call on every resize. */
  setGeometry(cx: number, cy: number, radius: number): void {
    this.radius = radius;
    this.lineWidth = Math.max(3.5, radius * 0.048);
    this.container.setPosition(cx, cy);
    this.rebuild();
  }

  setVisible(v: boolean): void {
    this.container.setVisible(v);
  }

  /** Drop every stroke and reset the erase cursor. */
  clearAll(): void {
    for (let i = 0; i < INK_WEDGES; i++) {
      this.polys[i].length = 0;
      this.open[i] = null;
      this.gfx[i].clear();
    }
    this.primed = false;
  }

  /**
   * Add one point of a stroke. `stroke` is a monotonically increasing id; a
   * change in it is a pen-up, which starts a fresh polyline.
   */
  addPoint(x: number, y: number, ink: InkIndex, stroke: number): void {
    const w = wedgeOf(angleOf(x, y));
    const cur = this.open[w];
    if (cur && cur.stroke === stroke && cur.ink === ink) {
      cur.pts.push(x, y);
      this.drawPoly(w, cur, cur.pts.length / 2 - 2);
      return;
    }
    // New polyline. Bridge from the previous wedge's last point so a stroke
    // crossing a wedge boundary has no visible gap.
    const poly: Poly = { ink, pts: [], stroke };
    const prev = this.lastPointOfStroke(stroke, ink);
    if (prev) poly.pts.push(prev.x, prev.y);
    poly.pts.push(x, y);
    this.polys[w].push(poly);
    this.open[w] = poly;
    this.drawPoly(w, poly, 0);
  }

  /** Close the current stroke so the next point starts a new polyline. */
  endStroke(): void {
    for (let i = 0; i < INK_WEDGES; i++) this.open[i] = null;
  }

  /** Per-frame: fade every wedge and erase the ones the hand has just crossed. */
  update(handDeg: number): void {
    if (!this.primed) {
      this.lastHand = handDeg;
      this.primed = true;
    }
    this.eraseCrossed(this.lastHand, handDeg);
    this.lastHand = handDeg;

    const step = 360 / INK_WEDGES;
    for (let i = 0; i < INK_WEDGES; i++) {
      this.gfx[i].setAlpha(afterglowAlpha(handDeg, i * step));
    }
  }

  /** Ink currently on the field, as unit-space polylines (used for scoring). */
  livePolys(): Poly[] {
    const out: Poly[] = [];
    for (const list of this.polys) for (const p of list) out.push(p);
    return out;
  }

  destroy(): void {
    this.container.destroy(true);
    this.gfx.length = 0;
    this.polys.length = 0;
    this.open.length = 0;
  }

  // ---- internals ---------------------------------------------------------

  private lastPointOfStroke(stroke: number, ink: InkIndex): { x: number; y: number } | null {
    for (let i = 0; i < INK_WEDGES; i++) {
      const p = this.open[i];
      if (p && p.stroke === stroke && p.ink === ink && p.pts.length >= 2) {
        return { x: p.pts[p.pts.length - 2], y: p.pts[p.pts.length - 1] };
      }
    }
    return null;
  }

  /** Clear every wedge whose leading boundary the hand swept past. */
  private eraseCrossed(from: number, to: number): void {
    const step = 360 / INK_WEDGES;
    const travelled = forwardDelta(from, to);
    if (travelled <= 0) return;
    // Wrapping a whole rotation in one frame (a long stall) wipes the field.
    if (travelled >= 360) {
      for (let i = 0; i < INK_WEDGES; i++) this.wipe(i);
      return;
    }
    const firstIdx = Math.ceil(from / step);
    const lastIdx = Math.floor((from + travelled) / step);
    for (let k = firstIdx; k <= lastIdx; k++) {
      this.wipe(((k % INK_WEDGES) + INK_WEDGES) % INK_WEDGES);
    }
  }

  private wipe(i: number): void {
    if (this.polys[i].length === 0 && this.open[i] === null) return;
    this.polys[i].length = 0;
    this.open[i] = null;
    this.gfx[i].clear();
  }

  /** Append geometry for a polyline from `fromIndex` (in points) onward. */
  private drawPoly(w: number, poly: Poly, fromIndex: number): void {
    const g = this.gfx[w];
    const r = this.radius;
    const colour = T.ink[poly.ink];
    const n = poly.pts.length / 2;

    if (n === 1) {
      g.fillStyle(colour, 1);
      g.fillCircle(poly.pts[0] * r, poly.pts[1] * r, this.lineWidth / 2);
      return;
    }
    g.lineStyle(this.lineWidth, colour, 1);
    g.fillStyle(colour, 1);
    for (let i = Math.max(0, fromIndex); i + 1 < n; i++) {
      const x0 = poly.pts[i * 2] * r;
      const y0 = poly.pts[i * 2 + 1] * r;
      const x1 = poly.pts[i * 2 + 2] * r;
      const y1 = poly.pts[i * 2 + 3] * r;
      g.lineBetween(x0, y0, x1, y1);
      // Round the joint so fast strokes do not show mitre notches.
      g.fillCircle(x1, y1, this.lineWidth / 2);
    }
  }

  /** Redraw every retained polyline (after a resize). */
  private rebuild(): void {
    for (let i = 0; i < INK_WEDGES; i++) {
      this.gfx[i].clear();
      for (const p of this.polys[i]) this.drawPoly(i, p, 0);
    }
  }
}

/**
 * The drawer's re-tracing guide (GDD §3): a faint, never-erased copy of every
 * stroke so lines can be laid back down on top of themselves. Drawer-only — it
 * is never part of a recording, so guessers never see it.
 */
export class GhostLayer {
  private g: Phaser.GameObjects.Graphics;
  private polys: Poly[] = [];
  private open: Poly | null = null;
  private radius = 1;
  private lineWidth = 4;

  constructor(scene: Phaser.Scene, depth: number) {
    this.g = scene.add.graphics().setDepth(depth).setAlpha(DRAWER_GHOST_ALPHA);
  }

  setGeometry(cx: number, cy: number, radius: number): void {
    this.radius = radius;
    this.lineWidth = Math.max(3.5, radius * 0.048);
    this.g.setPosition(cx, cy);
    this.g.clear();
    for (const p of this.polys) this.draw(p, 0);
  }

  addPoint(x: number, y: number, ink: InkIndex, stroke: number): void {
    if (this.open && this.open.stroke === stroke) {
      this.open.pts.push(x, y);
      this.draw(this.open, this.open.pts.length / 2 - 2);
      return;
    }
    this.open = { ink, pts: [x, y], stroke };
    this.polys.push(this.open);
    this.draw(this.open, 0);
  }

  endStroke(): void {
    this.open = null;
  }

  clearAll(): void {
    this.polys.length = 0;
    this.open = null;
    this.g.clear();
  }

  setVisible(v: boolean): void {
    this.g.setVisible(v);
  }

  destroy(): void {
    this.g.destroy();
    this.polys.length = 0;
  }

  private draw(poly: Poly, fromIndex: number): void {
    const r = this.radius;
    const colour = T.ink[poly.ink];
    const n = poly.pts.length / 2;
    if (n === 1) {
      this.g.fillStyle(colour, 1);
      this.g.fillCircle(poly.pts[0] * r, poly.pts[1] * r, this.lineWidth / 2);
      return;
    }
    this.g.lineStyle(this.lineWidth, colour, 1);
    for (let i = Math.max(0, fromIndex); i + 1 < n; i++) {
      this.g.lineBetween(
        poly.pts[i * 2] * r,
        poly.pts[i * 2 + 1] * r,
        poly.pts[i * 2 + 2] * r,
        poly.pts[i * 2 + 3] * r,
      );
    }
  }
}
