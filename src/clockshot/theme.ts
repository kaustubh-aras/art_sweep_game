/**
 * Clockshot's design system: a dark instrument panel, cyan for the rope, and
 * gold for time itself.
 *
 * Every colour, size, gap and duration the game draws comes from here, so the
 * whole thing reads as one object rather than a pile of separate scenes. The
 * rule is that no screen invents a number: it names one.
 *
 * The palette is checked rather than eyeballed. Every colour below that carries
 * text clears WCAG AA (4.5:1) against `bg` and `panel`, which is why `faint` is
 * lighter than it looks like it wants to be — at its old value it measured
 * 2.7:1, which is unreadable for anyone who is not looking at a good screen in
 * a dark room.
 */

export const C = {
  /** Deep navy, almost black — the arena void. */
  bg: 0x070b16,
  panel: 0x0d1426,
  panelEdge: 0x1d2a44,
  grid: 0x121c33,

  /** Primary text. 16.7:1 on bg. */
  ink: 0xe6edf8,
  /** Secondary text. 8.9:1 on bg, 5.0:1 on the brightest glass. */
  dim: 0x9db0cd,
  /**
   * Tertiary text — labels, captions, timestamps. 8.1:1 on bg, 4.5:1 on glass.
   *
   * Deliberately not dimmer. This is the smallest type in the game, and small
   * type is exactly where contrast cannot be spent on atmosphere. Glass costs
   * contrast, so the two secondary tones sit closer together than they would on
   * a solid panel; size and weight carry the hierarchy that lightness no longer
   * can.
   */
  faint: 0x93a8c9,

  /** Time itself. Collectibles, the run clock, anything that counts. */
  gold: 0xffc63d,
  goldDeep: 0x6d4d00,

  /** The grapple rope and anchors. */
  cyan: 0x3df0ff,
  cyanDeep: 0x0d5a66,

  danger: 0xff5a3d,
  good: 0x3dffa0,

  /** The goal. The one thing in the arena that ends the run. */
  goal: 0x3dffa0,
  goalDeep: 0x0b4a2c,

  /** Checkpoints: dim until touched, then lit in the goal's own green. */
  checkpoint: 0x2a3a5c,
  checkpointLit: 0x3dffa0,

  platform: 0x27395c,
  platformTop: 0x3a557f,
} as const;

/**
 * The spacing rhythm, in design pixels.
 *
 * A 4-point scale, because arbitrary gaps are what make a careful layout read
 * as sloppy: the eye cannot name the problem, but it can see that nothing lines
 * up with anything else.
 */
export const S = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  h1: 32,
  h2: 40,
  h3: 48,
} as const;

/**
 * The type scale, in design pixels.
 *
 * Sizes step by a consistent ratio rather than landing wherever a screen needed
 * them, so headings on one screen match headings on the next. Nothing smaller
 * than `micro` exists, and `micro` is only ever used for a label beside the
 * thing it labels — never for something a player has to read on its own.
 */
export const T = {
  display: 32,
  title: 24,
  heading: 19,
  subhead: 15,
  body: 13,
  label: 11,
  micro: 10,
} as const;

/** Corner radii. Bigger surfaces get bigger corners, so nothing looks pasted on. */
export const R = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/**
 * The glass material, as the numbers that make it.
 *
 * These are the skill's glassmorphism figures adapted to a dark interface:
 * translucent white in the 10-30% band, a 1px rim at 20%, and a light source
 * above. `base` is the addition a dark theme needs — a dark underlay beneath
 * the white, without which text on glass sits over whatever colour happens to
 * be drifting behind it and loses its contrast the moment the field brightens.
 */
export const GLASS = {
  /**
   * The dark underlay that guarantees the surface a floor.
   *
   * Solved rather than chosen. At the vibrant end of the backdrop, a lighter
   * underlay drags secondary text under 4.5:1 no matter what else is tuned —
   * this is the value at which every text colour still clears its floor over
   * the brightest field the backdrop can produce.
   */
  base: 0.84,
  /**
   * Translucent white over it, at the bottom of the 0.1-0.3 band.
   *
   * 0.09 is the measured ceiling: above it, secondary text on the brightest
   * part of the backdrop drops under 4.5:1.
   */
  fill: 0.09,
  /**
   * The pane used by surfaces carrying a lot of small text.
   *
   * *Less* white, not more — which is the opposite of what "solid" suggests,
   * and the reason it is not called that. On a dark interface a denser pane
   * means more of the dark underlay and less of the sheen, because every point
   * of white spent here is contrast taken away from the type sitting on it.
   */
  fillDense: 0.06,
  /** The specular falloff from the top edge. */
  sheen: 0.04,
  /** Rim width in design pixels, and its opacity. */
  rim: 1.25,
  rimAlpha: 0.2,
  /** The lit hairline along the top edge, where the light actually lands. */
  rimTop: 0.42,
  /** Backdrop blur for the DOM card, which can do the real thing. */
  blurPx: 16,
} as const;

/**
 * Motion, in milliseconds.
 *
 * Feedback has to land inside 100ms or a control feels dead, so `tap` is well
 * under it. Exits run at about two thirds of their entrance: leaving quickly
 * reads as responsive, while arriving quickly reads as abrupt.
 */
export const M = {
  tap: 90,
  fast: 140,
  base: 200,
  slow: 300,
  /** Screen fade in, and the faster fade out that answers it. */
  enter: 220,
  exit: 150,
} as const;

/**
 * Whether the player has asked their system for less movement.
 *
 * Honoured by the shared transitions rather than by each screen, so a screen
 * cannot forget. Read live rather than cached: the setting can change while the
 * game is open, and a post that was opened yesterday is still running.
 */
export function reducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Scales a duration to nothing when the player has asked for less motion. */
export function duration(ms: number): number {
  return reducedMotion() ? 0 : ms;
}

export const CSS = {
  bg: '#070b16',
  ink: '#e6edf8',
  dim: '#8497b5',
  faint: '#6f88ba',
  gold: '#ffc63d',
  cyan: '#3df0ff',
} as const;

export const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Hex string form, for Phaser text styles which take CSS colours. */
export function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}
