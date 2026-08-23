import Phaser from 'phaser';
import { T } from '@/ui/theme';
import { HEAT_GRID } from './tuning';

/** Degrees of trailing wedge behind the hand. */
const WEDGE_SPAN = 46;
/** Slices used to fake the wedge's alpha gradient (cheap: 8 fills a frame). */
const WEDGE_SLICES = 8;

/**
 * The clock face: the dial the ink lives on and the hand that erases it.
 *
 * The dial is static geometry, redrawn only on resize. The hand is the one
 * thing rebuilt every frame, and it is a handful of primitives — so the whole
 * radar costs a few draw calls regardless of how much ink is on screen.
 */
export class ClockFace {
  private dial: Phaser.GameObjects.Graphics;
  private heat: Phaser.GameObjects.Graphics;
  private hand: Phaser.GameObjects.Graphics;

  private cx = 0;
  private cy = 0;
  private radius = 1;

  constructor(scene: Phaser.Scene, depthDial: number, depthHeat: number, depthHand: number) {
    this.dial = scene.add.graphics().setDepth(depthDial);
    this.heat = scene.add.graphics().setDepth(depthHeat).setVisible(false);
    this.hand = scene.add.graphics().setDepth(depthHand);
  }

  setGeometry(cx: number, cy: number, radius: number): void {
    this.cx = cx;
    this.cy = cy;
    this.radius = radius;
    this.dial.setPosition(cx, cy);
    this.heat.setPosition(cx, cy);
    this.hand.setPosition(cx, cy);
    this.drawDial();
  }

  get center(): { x: number; y: number; r: number } {
    return { x: this.cx, y: this.cy, r: this.radius };
  }

  /** Screen point -> unit-circle coords. */
  toUnit(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.cx) / this.radius, y: (py - this.cy) / this.radius };
  }

  /** Unit-circle coords -> screen point. */
  toScreen(ux: number, uy: number): { x: number; y: number } {
    return { x: this.cx + ux * this.radius, y: this.cy + uy * this.radius };
  }

  /** True if a screen point is inside the dial. */
  contains(px: number, py: number): boolean {
    const dx = px - this.cx;
    const dy = py - this.cy;
    return dx * dx + dy * dy <= this.radius * this.radius;
  }

  /** Redraw the hand for the given angle (degrees clockwise from 12). */
  update(handDeg: number, intensity = 1): void {
    const g = this.hand;
    const r = this.radius;
    g.clear();

    // Trailing wedge — the "already erased, still glowing" arc behind the hand.
    const start = handDeg - WEDGE_SPAN;
    for (let i = 0; i < WEDGE_SLICES; i++) {
      const a0 = start + (WEDGE_SPAN * i) / WEDGE_SLICES;
      const a1 = start + (WEDGE_SPAN * (i + 1)) / WEDGE_SLICES;
      const alpha = 0.03 + 0.1 * ((i + 1) / WEDGE_SLICES) * intensity;
      g.fillStyle(T.wedge, alpha);
      g.slice(0, 0, r, phaserRad(a0), phaserRad(a1), false);
      g.fillPath();
    }

    // The hand itself: a soft outer line with a bright core.
    const tip = polar(handDeg, r);
    g.lineStyle(Math.max(4, r * 0.03), T.hand, 0.28 * intensity);
    g.lineBetween(0, 0, tip.x, tip.y);
    g.lineStyle(Math.max(1.5, r * 0.008), T.handCore, 0.95 * intensity);
    g.lineBetween(0, 0, tip.x, tip.y);

    // Hub.
    g.fillStyle(T.handCore, 0.9 * intensity);
    g.fillCircle(0, 0, Math.max(2.5, r * 0.018));
    // Tip bead, so the erase edge is easy to track with your eye.
    g.fillStyle(T.hand, 0.85 * intensity);
    g.fillCircle(tip.x, tip.y, Math.max(3, r * 0.022));
  }

  /** Draw the heat overlay from a 24x24 tap-count grid (GDD §6). */
  showHeat(cells: Map<number, number>): void {
    const g = this.heat;
    g.clear();
    if (cells.size === 0) {
      g.setVisible(false);
      return;
    }
    let max = 1;
    for (const v of cells.values()) max = Math.max(max, v);
    const cell = (this.radius * 2) / HEAT_GRID;
    for (const [key, v] of cells) {
      const gx = key % HEAT_GRID;
      const gy = Math.floor(key / HEAT_GRID);
      const x = -this.radius + gx * cell;
      const y = -this.radius + gy * cell;
      // Keep the overlay inside the dial.
      const cxu = (x + cell / 2) / this.radius;
      const cyu = (y + cell / 2) / this.radius;
      if (cxu * cxu + cyu * cyu > 1) continue;
      g.fillStyle(T.gold, 0.08 + 0.32 * (v / max));
      g.fillRect(x + 1, y + 1, cell - 2, cell - 2);
    }
    g.setVisible(true);
  }

  hideHeat(): void {
    this.heat.setVisible(false);
  }

  heatVisible(): boolean {
    return this.heat.visible;
  }

  destroy(): void {
    this.dial.destroy();
    this.heat.destroy();
    this.hand.destroy();
  }

  // ---- static dial -------------------------------------------------------

  private drawDial(): void {
    const g = this.dial;
    const r = this.radius;
    g.clear();

    // Field.
    g.fillStyle(T.field, 1);
    g.fillCircle(0, 0, r);

    // Concentric ring grid.
    for (let i = 1; i <= 4; i++) {
      g.lineStyle(1, T.ring, i === 4 ? 0.9 : 0.55);
      g.strokeCircle(0, 0, (r * i) / 4);
    }

    // 12 tick marks; the quarter hours read heavier.
    for (let i = 0; i < 12; i++) {
      const deg = i * 30;
      const major = i % 3 === 0;
      const inner = polar(deg, r * (major ? 0.86 : 0.92));
      const outer = polar(deg, r * 0.985);
      g.lineStyle(major ? 2.5 : 1.5, major ? T.tick : T.ring, major ? 0.95 : 0.7);
      g.lineBetween(inner.x, inner.y, outer.x, outer.y);
    }

    // Cross hairs, faint.
    g.lineStyle(1, T.ring, 0.35);
    g.lineBetween(-r, 0, r, 0);
    g.lineBetween(0, -r, 0, r);

    // Rim.
    g.lineStyle(Math.max(2, r * 0.014), T.fieldEdge, 1);
    g.strokeCircle(0, 0, r);
  }
}

/** Degrees clockwise from 12 o'clock -> a local-space point at radius `r`. */
export function polar(deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: Math.cos(rad) * r, y: Math.sin(rad) * r };
}

/** Degrees clockwise from 12 o'clock -> the radian convention Phaser arcs use. */
function phaserRad(deg: number): number {
  return ((deg - 90) * Math.PI) / 180;
}

/** Unit-space point -> heat grid cell index (GDD §6, 24 x 24). */
export function heatCell(ux: number, uy: number): number {
  const gx = Math.min(HEAT_GRID - 1, Math.max(0, Math.floor(((ux + 1) / 2) * HEAT_GRID)));
  const gy = Math.min(HEAT_GRID - 1, Math.max(0, Math.floor(((uy + 1) / 2) * HEAT_GRID)));
  return gy * HEAT_GRID + gx;
}
