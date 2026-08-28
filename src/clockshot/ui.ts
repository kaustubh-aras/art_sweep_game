import Phaser from 'phaser';
import { C, FONT, GLASS, M, R, T, duration, hex } from './theme';
import { drawGlass } from './glass';
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

/**
 * Minimum touch target, in design pixels.
 *
 * 48 rather than 44: it satisfies both the iOS and the Android floor, and this
 * is a game played with a thumb while something is moving on screen. The
 * matching rule — that targets are never closer together than `S.sm` — is kept
 * by the screens, which stack buttons with a token gap.
 */
export const TOUCH_MIN = 48;

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

/**
 * Shrinks a label until it fits the width it has been given.
 *
 * Most labels are literals and can be sized by hand. These are not: a rank, a
 * player count, an arena name or a server message is only as long as it turns
 * out to be, and a line that overruns the panel it sits in reads as a bug —
 * where the same line a point or two smaller reads as designed.
 */
export function fitText(
  t: Phaser.GameObjects.Text,
  size: number,
  maxWidth: number,
  floor = 0.72,
): void {
  const min = Math.max(9, Math.round(size * floor));
  let f = Math.max(min, Math.round(size));
  t.setFontSize(f);
  while (t.width > maxWidth && f > min) {
    f -= 1;
    t.setFontSize(f);
  }
}

/**
 * What a button is *for*, rather than what colour it is.
 *
 * Naming the job instead of the paint is what keeps "one primary action per
 * screen" enforceable: a screen with two `primary` buttons is now obviously
 * wrong when you read it, where two gold ones were just a colour choice.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface VariantStyle {
  /** The accent: the rim, and the body of a solid face. */
  accent: number;
  /** How strongly the face is filled. Weight is the hierarchy, not hue. */
  fill: number;
  border: number;
  label: number;
  /** Solid controls are opaque material; the rest are panes of glass. */
  solid?: boolean;
}

const VARIANTS: Record<ButtonVariant, VariantStyle> = {
  // The one thing the screen wants you to do. Solid, warm, unmissable.
  primary: { accent: C.gold, fill: 0.95, border: 1, label: C.bg, solid: true },
  // A real alternative, but subordinate: a pane with a lit rim.
  secondary: { accent: C.cyan, fill: 0.1, border: 0.7, label: C.ink },
  // Available, not advertised. Back, cancel, menu.
  ghost: { accent: 0xffffff, fill: 0.1, border: 0.22, label: C.dim },
  danger: { accent: C.danger, fill: 0.1, border: 0.8, label: C.ink },
};

export interface ButtonOptions {
  width: number;
  height?: number;
  variant?: ButtonVariant;
  /** Overrides the variant's accent, for the few buttons that carry a meaning. */
  color?: number;
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
  private style: VariantStyle;
  private enabled: boolean;
  private down = false;
  /** The radius the face is drawn with, scaled with everything else. */
  private radius: number = R.md;

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
    const ui = layoutOf(scene).ui;
    this.w = opts.width;
    // Never smaller than a comfortable touch target, whatever the caller asks.
    // The floor is in design pixels, so it is scaled like everything else.
    this.h = Math.max(opts.height ?? TOUCH_MIN * ui, TOUCH_MIN * ui);
    this.radius = R.md * ui;

    const base = VARIANTS[opts.variant ?? 'secondary'];
    // A caller may recolour a variant without giving up its weight — the green
    // BUILD button is a secondary action that happens to mean something.
    this.style = opts.color ? { ...base, accent: opts.color } : base;
    this.enabled = opts.enabled ?? true;

    this.gfx = scene.add.graphics();
    this.label = scene.add
      .text(0, 0, caption, {
        fontFamily: FONT,
        fontSize: `${Math.round(opts.fontSize ?? T.subhead * ui)}px`,
        color: hex(this.style.label),
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

  /**
   * Paints the face for its current state.
   *
   * A press deepens the fill and tightens the border rather than moving the
   * button: nudging it down by a pixel is the classic way to make a stack of
   * buttons jitter, and jitter under a thumb reads as a misfire.
   *
   * Disabled is carried by opacity *and* by the zone being switched off, so it
   * is never merely a colour that a player might try to tap anyway.
   */
  private redraw(): void {
    const g = this.gfx;
    const hw = this.w / 2;
    const hh = this.h / 2;
    const st = this.style;
    const u = this.radius / R.md;
    g.clear();

    const alpha = this.enabled ? 1 : 0.38;
    const press = this.down ? 0.14 : 0;

    if (st.solid) {
      // The one prominent control on a screen is a solid material, not glass.
      // Apple does the same: glass is the surface things sit *on*, and the
      // action you are meant to take is the thing sitting on it.
      g.fillStyle(C.bg, 0.3 * alpha);
      g.fillRoundedRect(-hw, -hh + 4 * u, this.w, this.h, this.radius);
      g.fillStyle(st.accent, (st.fill - press) * alpha);
      g.fillRoundedRect(-hw, -hh, this.w, this.h, this.radius);
      g.lineStyle(Math.max(1, u), 0xffffff, 0.3 * alpha);
      g.lineBetween(-hw + this.radius * 0.7, -hh + u, hw - this.radius * 0.7, -hh + u);
    } else {
      // Everything else is a pane of the same glass the panels are made of,
      // with its accent carried by the rim rather than by a wash of colour.
      drawGlass(g, -hw, -hh, this.w, this.h, this.radius, u, {
        fill: (GLASS.fill + press) * alpha,
        raised: false,
      });
      g.lineStyle(Math.max(1, 1.25 * u), st.accent, st.border * alpha);
      g.strokeRoundedRect(-hw, -hh, this.w, this.h, this.radius);
    }

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
    const ui = layoutOf(this.scene).ui;
    this.w = w;
    this.h = Math.max(h ?? this.h, TOUCH_MIN * ui);
    this.radius = R.md * ui;
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
  const ui = layoutOf(scene).ui;
  const g = scene.add.graphics();
  drawGlass(g, x, y, w, h, R.lg * ui, ui, { fill: fillAlpha * GLASS.fill });
  if (accent !== C.panelEdge) {
    g.lineStyle(Math.max(1, 1.25 * ui), accent, 0.45);
    g.strokeRoundedRect(x, y, w, h, R.lg * ui);
  }
  return g;
}

/**
 * Fades the scene in, so no screen ever snaps into existence.
 *
 * Every transition in the game goes through here or `fadeTo`, which is what
 * makes honouring `prefers-reduced-motion` a single decision rather than one
 * each screen has to remember. At zero duration Phaser still fires the
 * completion event, so the handover below stays intact.
 */
export function fadeIn(scene: Phaser.Scene, ms = M.enter): void {
  scene.cameras.main.fadeIn(duration(ms), 7, 11, 22);
}

/**
 * Scenes that have committed to leaving.
 *
 * A scene is not torn down until the fade finishes and the next one starts, so
 * for the length of the fade the old screen is still mounted, still drawing and
 * still listening. That is long enough to press a second button, and two
 * `fadeTo` calls meant two queued `FADE_OUT_COMPLETE` handlers and two
 * `scene.start` calls racing each other into different scenes.
 *
 * Weak, so a scene that goes away takes its entry with it.
 */
const LEAVING = new WeakSet<Phaser.Scene>();

/**
 * Runs `fn` after fading out, for a clean handover between screens.
 *
 * Shorter than the fade in by default: leaving quickly reads as responsive,
 * where arriving quickly reads as abrupt.
 *
 * Committing is one-way. The first call wins, input is closed immediately
 * rather than when the fade ends, and later calls are dropped — a screen on its
 * way out has stopped being a screen you can use, and the alternative is a
 * handover whose destination depends on timing.
 */
export function fadeTo(scene: Phaser.Scene, fn: () => void, ms = M.exit): void {
  if (LEAVING.has(scene)) return;
  LEAVING.add(scene);

  // Canvas controls stop responding here. DOM overlays are not Phaser input, so
  // anything holding one destroys it on SHUTDOWN; see `TapProxy`.
  scene.input.enabled = false;
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => LEAVING.delete(scene));

  scene.cameras.main.fadeOut(duration(ms), 7, 11, 22);
  scene.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, fn);
}

/**
 * The empty state for any list: says why it is empty, and what to do about it.
 *
 * A blank rectangle is the one thing a list must never be — it reads as broken
 * where a sentence reads as "nothing here yet, and here is how that changes".
 */
export function emptyState(
  scene: Phaser.Scene,
  x: number,
  y: number,
  message: string,
  width: number,
): Phaser.GameObjects.Text {
  const ui = layoutOf(scene).ui;
  const t = text(scene, x, y, message, T.body * ui, C.dim);
  t.setAlign('center').setWordWrapWidth(width).setLineSpacing(4 * ui);
  return t;
}
