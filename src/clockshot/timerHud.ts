import Phaser from 'phaser';
import { WARNING_MS } from './tuning';
import { mountForScene, type UiScreen } from './uiLayer';
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
 * Built on the DOM layer, like every other surface in the game. The concern
 * with putting a per-frame readout in the DOM is cost, and it is the wrong way
 * round: a `Graphics` redraw throws away and rebuilds the whole geometry, where
 * setting `textContent` or a percentage width touches exactly what changed. The
 * change-gating below is kept anyway — the digits are compared as a string and
 * the bar is quantised — so a frame in which nothing moved writes nothing at
 * all. The dial is an SVG hand moved with a transform, which the compositor
 * handles without touching layout.
 *
 * It also brings the readout the things canvas could not give it: real text
 * that scales with the reader's own settings, and a live region, so a screen
 * reader announces the last few seconds instead of silence.
 */

/** The tank the bar is drawn against, so a topped-up clock still reads full. */
const BAR_TICK_MS = 5_000;

export class TimerHud {
  private ui: UiScreen;
  private root: HTMLElement;
  private digits: HTMLElement;
  private fill: HTMLElement;
  private hand: HTMLElement;
  private anchors: HTMLElement;

  /** Last text painted, so a clock that has not moved is not re-laid out. */
  private shown = '';
  /** Whole second last beaten, for the pulse under the warning line. */
  private beat = -1;
  /** Fraction last drawn, quantised: the bar only moves in visible steps. */
  private drawnStep = -1;
  private drawnUrgent = false;
  private shownAnchors = -1;

  constructor(
    scene: Phaser.Scene,
    /** The full tank, in milliseconds — what a full bar means. */
    private readonly capacityMs: number,
  ) {
    this.ui = mountForScene(scene, this.markup());
    this.root = this.ui.find('.cs-hud');
    this.digits = this.ui.find('.cs-hud-digits');
    this.fill = this.ui.find('.cs-hud-fill');
    this.hand = this.ui.find('.cs-hud-hand');
    this.anchors = this.ui.find('.cs-hud-anchors');
  }

  private markup(): string {
    // The tick marks are static, so they are written once here rather than
    // redrawn with the bar every time it moves.
    const ticks = [];
    for (let t = BAR_TICK_MS; t < this.capacityMs; t += BAR_TICK_MS) {
      ticks.push(`<i style="left:${((t / this.capacityMs) * 100).toFixed(3)}%"></i>`);
    }

    return `
      <div class="cs-hud">
        <div class="cs-hud-clock cs-glass cs-glass-dense">
          <div class="cs-hud-face">
            <svg class="cs-hud-dial" viewBox="0 0 32 32" aria-hidden="true">
              <circle cx="16" cy="16" r="14" />
              <line class="cs-hud-hand" x1="16" y1="16" x2="16" y2="6" />
              <circle class="cs-hud-pin" cx="16" cy="16" r="1.6" />
            </svg>
            <div class="cs-hud-read">
              <b class="cs-hud-digits" role="timer" aria-live="off">0.0</b>
              <span class="cs-hud-caption">SECONDS LEFT</span>
            </div>
          </div>
          <div class="cs-hud-bar">
            <i class="cs-hud-fill"></i>
            ${ticks.join('')}
          </div>
        </div>
        <p class="cs-hud-anchors"></p>
      </div>`;
  }

  /**
   * Kept for the scene's camera split, which has nothing left to divide.
   *
   * The readout is no longer on the canvas, so there is nothing for the world
   * camera to be told to ignore.
   */
  objects(): Phaser.GameObjects.GameObject[] {
    return [];
  }

  /** CSS owns the geometry now; the layout is here only to answer the caller. */
  layout(_L: Layout): void {
    /* nothing to place */
  }

  /**
   * Paints the clock for this frame.
   *
   * Every write below is gated on the value actually having changed, so a
   * steady frame costs a handful of comparisons and no DOM work at all.
   */
  update(remainingMs: number): void {
    const label = (Math.max(0, remainingMs) / 1000).toFixed(1);
    const urgent = remainingMs <= WARNING_MS;
    const frac = Phaser.Math.Clamp(remainingMs / this.capacityMs, 0, 1);
    const step = Math.round(frac * 240);

    if (label !== this.shown) {
      this.shown = label;
      this.digits.textContent = label;
    }
    if (step !== this.drawnStep) {
      this.drawnStep = step;
      this.fill.style.width = `${(frac * 100).toFixed(2)}%`;
      // A full tank is noon, and the hand sweeps a whole turn as it drains.
      this.hand.style.transform = `rotate(${(frac * 360).toFixed(1)}deg)`;
    }
    if (urgent !== this.drawnUrgent) {
      this.drawnUrgent = urgent;
      this.root.dataset.urgent = String(urgent);
      // Silent until it matters. A readout that announced every tenth of a
      // second would make the whole run unusable with a screen reader on.
      this.digits.setAttribute('aria-live', urgent ? 'assertive' : 'off');
    }

    this.pulseOnTheSecond(remainingMs, urgent);
  }

  /** The anchors used so far — part of the readout, not a separate label. */
  setAnchors(n: number): void {
    if (n === this.shownAnchors) return;
    this.shownAnchors = n;
    this.anchors.textContent = n === 1 ? '1 anchor' : `${n} anchors`;
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

    // Restarting a CSS animation means taking the class off, forcing the style
    // to be recomputed, and putting it back. Without the reflow the browser
    // coalesces both writes into no change at all and the beat never plays.
    this.digits.classList.remove('cs-hud-beat');
    void this.digits.offsetWidth;
    this.digits.classList.add('cs-hud-beat');
  }

  destroy(): void {
    this.ui.destroy();
  }
}
