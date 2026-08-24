import Phaser from 'phaser';
import { C, FONT, hex } from './theme';
import { sfx } from './sfx';
import { readInsets, type Insets } from '../ui/layout';
import { dpr } from '../ui/viewport';

/**
 * The shared furniture every Clockshot screen is built from.
 *
 * Screens describe what they want; this decides how big it is. Sizes come from
 * a single `ui` scale derived from the viewport, so one phone-sized layout
 * stretches sensibly to a tablet without any screen doing its own arithmetic.
 */

export interface Layout {
  /** Canvas size in game units. */
  w: number;
  h: number;
  safe: Insets;
  /** Usable rectangle in game units, inside notches and home indicators. */
  x: number;
  y: number;
  iw: number;
  ih: number;
  /**
   * Design-pixels to game-units. Multiply *every* literal size by this.
   *
   * The canvas backing store runs at the device pixel ratio, so one game unit
   * is a device pixel, not a CSS pixel. Folding the ratio in here is what keeps
   * a "44" touch target 44 CSS pixels on a 3x phone instead of 15.
   */
  ui: number;
  /** The device pixel ratio in force, for anything that needs it directly. */
  dpr: number;
  cx: number;
}

export function layoutOf(scene: Phaser.Scene): Layout {
  const w = scene.scale.width;
  const h = scene.scale.height;
  const safe = readInsets();
  const d = dpr();

  // Everything below is reasoned about in CSS pixels, then converted once.
  const cssW = w / d;
  const cssH = h / d;

  // Scale with the narrow edge so type never overwhelms a small phone and
  // never looks lost on a tablet.
  const fit = Phaser.Math.Clamp(Math.min(cssW, cssH * 0.62) / 360, 0.85, 1.45);
  const ui = fit * d;

  const x = safe.left + 14 * ui;
  const y = safe.top + 12 * ui;
  const iw = Math.max(200, w - x - safe.right - 14 * ui);
  const ih = Math.max(240, h - y - safe.bottom - 12 * ui);

  return { w, h, safe, x, y, iw, ih, ui, dpr: d, cx: x + iw / 2 };
}

/** Minimum comfortable touch target, in design pixels. */
export const TOUCH_MIN = 46;

export function text(
  scene: Phaser.Scene,
  x: number,
  y: number,
  content: string,
  size: number,
  color: number = C.ink,
  align: 'left' | 'center' | 'right' = 'center',
): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, content, {
      fontFamily: FONT,
      fontSize: `${Math.round(size)}px`,
      color: hex(color),
      align,
    })
    .setOrigin(align === 'center' ? 0.5 : align === 'left' ? 0 : 1, 0.5);
}

export interface ButtonOptions {
  width: number;
  height?: number;
  color?: number;
  /** Filled buttons read as the primary action; outlined ones as secondary. */
  filled?: boolean;
  fontSize?: number;
  enabled?: boolean;
}

export class Button {
  readonly container: Phaser.GameObjects.Container;
  private gfx: Phaser.GameObjects.Graphics;
  private label: Phaser.GameObjects.Text;
  private zone: Phaser.GameObjects.Zone;
  private w: number;
  private h: number;
  private color: number;
  private filled: boolean;
  private enabled: boolean;
  private down = false;

  private readonly scene: Phaser.Scene;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    caption: string,
    opts: ButtonOptions,
    private readonly onClick: () => void,
  ) {
    this.scene = scene;
    this.w = opts.width;
    // Never smaller than a comfortable touch target, whatever the caller asks.
    // The floor is in design pixels, so it is scaled like everything else.
    this.h = Math.max(opts.height ?? 52, TOUCH_MIN * layoutOf(scene).ui);
    this.color = opts.color ?? C.cyan;
    this.filled = opts.filled ?? false;
    this.enabled = opts.enabled ?? true;

    this.gfx = scene.add.graphics();
    this.label = scene.add
      .text(0, 0, caption, {
        fontFamily: FONT,
        fontSize: `${Math.round(opts.fontSize ?? 17)}px`,
        color: hex(C.ink),
      })
      .setOrigin(0.5);

    this.zone = scene.add
      .zone(0, 0, this.w, this.h)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.zone.on('pointerdown', () => this.setPressed(true));
    this.zone.on('pointerup', () => {
      this.setPressed(false);
      this.click();
    });
    this.zone.on('pointerout', () => this.setPressed(false));

    this.container = scene.add.container(x, y, [this.gfx, this.label, this.zone]);
    this.redraw();
  }

  private redraw(): void {
    const g = this.gfx;
    const hw = this.w / 2;
    const hh = this.h / 2;
    g.clear();

    const alpha = this.enabled ? 1 : 0.35;
    const press = this.down ? 0.22 : 0;

    if (this.filled) {
      g.fillStyle(this.color, (0.24 + press) * alpha);
      g.fillRoundedRect(-hw, -hh, this.w, this.h, 12);
    } else {
      g.fillStyle(C.panel, (0.85 + press) * alpha);
      g.fillRoundedRect(-hw, -hh, this.w, this.h, 12);
    }
    g.lineStyle(2, this.color, (this.filled ? 0.95 : 0.55) * alpha);
    g.strokeRoundedRect(-hw, -hh, this.w, this.h, 12);

    this.label.setAlpha(alpha);
  }

  /**
   * Presses or releases the button without a pointer of Phaser's own.
   *
   * A tap can arrive from outside Phaser — see `attachTapProxy` in
   * `immersive.ts` — and a button that does not visibly respond to a press
   * reads as broken.
   */
  setPressed(on: boolean): this {
    const next = on && this.enabled;
    if (next === this.down) return this;
    this.down = next;
    this.redraw();
    return this;
  }

  /** Fires the button's action, exactly as a tap on it would. */
  click(): this {
    if (!this.enabled) return this;
    sfx.uiSelect();
    this.onClick();
    return this;
  }

  /**
   * The button's rectangle in game units.
   *
   * Screens add their buttons straight to the scene and never scroll or zoom
   * the camera they are drawn by, so the container's position is already the
   * position on screen.
   */
  bounds(): { x: number; y: number; w: number; h: number } {
    return {
      x: this.container.x - this.w / 2,
      y: this.container.y - this.h / 2,
      w: this.w,
      h: this.h,
    };
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isVisible(): boolean {
    return this.container.visible;
  }

  get caption(): string {
    return this.label.text;
  }

  setEnabled(on: boolean): this {
    this.enabled = on;
    this.zone.input && (this.zone.input.enabled = on);
    this.redraw();
    return this;
  }

  setCaption(s: string): this {
    this.label.setText(s);
    return this;
  }

  /**
   * Resizes the button in place.
   *
   * Scaling the container would work, but it would stretch the label with it;
   * a button that has to fit a narrow phone needs to get wider, not distorted.
   */
  setSize(w: number, h?: number): this {
    this.w = w;
    this.h = Math.max(h ?? this.h, TOUCH_MIN * layoutOf(this.scene).ui);
    this.zone.setSize(this.w, this.h);
    if (this.zone.input) {
      this.zone.input.hitArea.setTo(0, 0, this.w, this.h);
    }
    this.redraw();
    return this;
  }

  setFontSize(px: number): this {
    this.label.setFontSize(Math.round(px));
    return this;
  }

  setPosition(x: number, y: number): this {
    this.container.setPosition(x, y);
    return this;
  }

  setVisible(v: boolean): this {
    this.container.setVisible(v);
    return this;
  }

  destroy(): void {
    this.container.destroy();
  }
}

/** A rounded panel, the background for every block of information. */
export function panel(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  accent: number = C.panelEdge,
  fillAlpha = 0.9,
): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  g.fillStyle(C.panel, fillAlpha);
  g.fillRoundedRect(x, y, w, h, 14);
  g.lineStyle(1.5, accent, 0.5);
  g.strokeRoundedRect(x, y, w, h, 14);
  return g;
}

/**
 * The two-team clock bar.
 *
 * One bar rather than two numbers, because the thing a player actually wants to
 * know is who is ahead and by how much — and a proportional bar answers that
 * before the numbers are even read.
 */
export function drawTeamBar(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  red: number,
  blue: number,
): void {
  g.clear();
  const total = Math.max(1, red + blue);
  const redW = Math.round((w * red) / total);

  g.fillStyle(C.redDeep, 1);
  g.fillRoundedRect(x, y, w, h, h / 2);
  g.fillStyle(C.blueDeep, 1);
  g.fillRoundedRect(x + redW, y, Math.max(0, w - redW), h, h / 2);

  g.fillStyle(C.red, 1);
  g.fillRoundedRect(x, y, Math.max(h, redW), h, h / 2);
  g.fillStyle(C.blue, 1);
  g.fillRoundedRect(x + redW, y, Math.max(h, w - redW), h, h / 2);

  // A seam at the boundary, so a near-tie still reads as two teams.
  g.lineStyle(2, C.bg, 0.9);
  g.lineBetween(x + redW, y - 2, x + redW, y + h + 2);
}

/** Fades the scene in, so no screen ever snaps into existence. */
export function fadeIn(scene: Phaser.Scene, ms = 220): void {
  scene.cameras.main.fadeIn(ms, 7, 11, 22);
}

/** Runs `fn` after fading out, for a clean handover between screens. */
export function fadeTo(scene: Phaser.Scene, fn: () => void, ms = 180): void {
  scene.cameras.main.fadeOut(ms, 7, 11, 22);
  scene.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, fn);
}
