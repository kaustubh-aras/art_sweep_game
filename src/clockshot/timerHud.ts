import Phaser from 'phaser';
import { C, FONT, hex } from './theme';
import { WARNING_MS } from './tuning';
import type { Layout } from './ui';

/**
 * The run clock.
 *
 * The clock *is* the game — it is the score, the health bar and the fail state
 * at once — so it gets a readout rather than a number floating over the arena.
 * A thin ring around a figure, which is what this replaces, asks the player to
 * read an arc while they are mid-swing; what they actually need to know is one
 * of three things, and each has its own channel here:
 *
 * - **How long is left**, exactly: the figures, big enough to catch out of the
 *   corner of an eye.
 * - **How long is left, as a shape**: the drain bar, so "nearly out" lands
 *   without reading a digit at all. It is ticked every five seconds because a
 *   bare bar has no scale, and a bar with a scale can be compared to the one
 *   from the last run.
 * - **Whether that is a problem**: colour, and a beat on the last few seconds.
 *   Nothing else on screen is red, so red means exactly one thing.
 *
 * Gains and losses are shown here too rather than over the player, because this
 * is where the number they change lives, and a `+2.0s` that flies up out of the
 * clock explains itself.
 */

/** The tank the bar is drawn against, so a topped-up clock still reads full. */
const BAR_TICK_MS = 5_000;

export class TimerHud {
  private gfx: Phaser.GameObjects.Graphics;
  private digits: Phaser.GameObjects.Text;
  private caption: Phaser.GameObjects.Text;

  private x = 0;
  private y = 0;
  private w = 0;
  private h = 0;
  private ui = 1;

  /** Last text painted, so a clock that has not moved is not re-laid out. */
  private shown = '';
  /** Whole second last beaten, for the pulse under the warning line. */
  private beat = -1;
  /** Fraction last drawn, quantised: the bar only moves in visible steps. */
  private drawnStep = -1;
  private drawnUrgent = false;

  constructor(
    private readonly scene: Phaser.Scene,
    /** The full tank, in milliseconds — what a full bar means. */
    private readonly capacityMs: number,
  ) {
    this.gfx = scene.add.graphics().setScrollFactor(0).setDepth(880);

    this.digits = scene.add
      .text(0, 0, '0.0', { fontFamily: FONT, fontSize: '46px', color: hex(C.gold) })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(882);

    this.caption = scene.add
      .text(0, 0, 'SECONDS LEFT', { fontFamily: FONT, fontSize: '9px', color: hex(C.dim) })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(882);
  }

  /** Every object the HUD owns, for the scene to put on its interface camera. */
  objects(): Phaser.GameObjects.GameObject[] {
    return [this.gfx, this.digits, this.caption];
  }

  layout(L: Layout): void {
    this.ui = L.ui;
    // The clock is the game — it is the fuel, the health bar and the score at
    // once — so it is sized like the most important thing on screen rather than
    // like a status line.
    this.w = Math.min(L.iw, 268 * L.ui);
    this.h = 88 * L.ui;
    this.x = L.cx - this.w / 2;
    this.y = L.y + 2 * L.ui;

    this.digits.setPosition(L.cx, this.y + 34 * L.ui).setFontSize(Math.round(46 * L.ui));
    this.caption.setPosition(L.cx, this.y + 62 * L.ui).setFontSize(Math.round(9.5 * L.ui));

    // A resize has to repaint even if the clock has not moved.
    this.drawnStep = -1;
    this.shown = '';
  }

  /**
   * Paints the clock for this frame.
   *
   * Both halves are change-gated. The figures are a string comparison, and the
   * bar is quantised to a few hundred steps — a redraw invalidates the whole
   * Graphics, and this is the one object that would otherwise rebuild its
   * geometry sixty times a second for a difference of a third of a pixel.
   */
  update(remainingMs: number): void {
    const label = (Math.max(0, remainingMs) / 1000).toFixed(1);
    const urgent = remainingMs <= WARNING_MS;
    const frac = Phaser.Math.Clamp(remainingMs / this.capacityMs, 0, 1);
    const step = Math.round(frac * 240);

    if (label !== this.shown) {
      this.shown = label;
      this.digits.setText(label);
    }
    if (step !== this.drawnStep || urgent !== this.drawnUrgent) {
      this.drawnStep = step;
      this.drawnUrgent = urgent;
      this.draw(frac, urgent);
    }

    this.pulseOnTheSecond(remainingMs, urgent);
  }

  /**
   * A beat on each of the last few seconds.
   *
   * The tick already has a sound, and a sound is no use to a player who has
   * muted the post — which, in a feed, is most of them.
   */
  private pulseOnTheSecond(remainingMs: number, urgent: boolean): void {
    if (!urgent || remainingMs <= 0) {
      this.beat = -1;
      return;
    }
    const second = Math.ceil(remainingMs / 1000);
    if (second === this.beat) return;
    this.beat = second;

    this.digits.setScale(1.16);
    this.scene.tweens.add({
      targets: this.digits,
      scale: 1,
      duration: 260,
      ease: 'Quad.out',
    });
  }

  private draw(frac: number, urgent: boolean): void {
    const ui = this.ui;
    const g = this.gfx;
    const colour = urgent ? C.danger : C.gold;
    g.clear();

    // The housing.
    g.fillStyle(C.panel, 0.92);
    g.fillRoundedRect(this.x, this.y, this.w, this.h, 18 * ui);
    g.lineStyle(Math.max(1.5, 2 * ui), urgent ? C.danger : C.panelEdge, urgent ? 0.9 : 0.7);
    g.strokeRoundedRect(this.x, this.y, this.w, this.h, 18 * ui);

    this.drawDial(g, this.x + 26 * ui, this.y + 34 * ui, 15 * ui, frac, colour);

    // The drain bar, and the empty channel behind it.
    const bx = this.x + 16 * ui;
    const bw = this.w - 32 * ui;
    const by = this.y + this.h - 18 * ui;
    const bh = 9 * ui;
    g.fillStyle(C.grid, 1);
    g.fillRoundedRect(bx, by, bw, bh, bh / 2);
    if (frac > 0) {
      g.fillStyle(colour, 0.95);
      g.fillRoundedRect(bx, by, Math.max(bh, bw * frac), bh, bh / 2);
    }

    // Five-second marks, so the bar has a scale to be read against.
    g.lineStyle(Math.max(1, 1.2 * ui), C.bg, 0.85);
    for (let t = BAR_TICK_MS; t < this.capacityMs; t += BAR_TICK_MS) {
      const tx = bx + bw * (t / this.capacityMs);
      g.lineBetween(tx, by, tx, by + bh);
    }
  }

  /** A clock face that actually runs, on the left of the readout. */
  private drawDial(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    r: number,
    frac: number,
    colour: number,
  ): void {
    g.lineStyle(Math.max(1, 1.4 * this.ui), C.faint, 0.8);
    g.strokeCircle(cx, cy, r);

    // The hand sweeps backwards as the clock drains: a full tank is noon.
    const a = -Math.PI / 2 + frac * Math.PI * 2;
    g.lineStyle(Math.max(1.5, 2 * this.ui), colour, 0.95);
    g.lineBetween(cx, cy, cx + Math.cos(a) * r * 0.72, cy + Math.sin(a) * r * 0.72);
    g.fillStyle(colour, 1);
    g.fillCircle(cx, cy, Math.max(1.2, 1.6 * this.ui));
  }

  /**
   * Floats a change to the clock up out of the readout.
   *
   * Owned here rather than by the caller so it always starts on the number it
   * is changing, however the HUD is laid out.
   */
  pop(label: string, colour: number): Phaser.GameObjects.Text {
    const t = this.scene.add
      .text(this.x + this.w - 16 * this.ui, this.y + 26 * this.ui, label, {
        fontFamily: FONT,
        fontSize: `${Math.round(17 * this.ui)}px`,
        color: hex(colour),
      })
      .setOrigin(1, 0.5)
      .setScrollFactor(0)
      .setDepth(884);

    this.scene.tweens.add({
      targets: t,
      y: t.y - 34 * this.ui,
      alpha: 0,
      duration: 900,
      ease: 'Cubic.out',
      onComplete: () => t.destroy(),
    });
    return t;
  }

  destroy(): void {
    this.gfx.destroy();
    this.digits.destroy();
    this.caption.destroy();
  }
}
