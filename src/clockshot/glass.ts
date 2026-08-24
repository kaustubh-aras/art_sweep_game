import Phaser from 'phaser';
import { C, GLASS, R } from './theme';

/**
 * Frosted glass, the way Apple does it.
 *
 * Glass is not a fill — it is a *relationship*. A translucent white panel over
 * a flat dark background is just a lighter grey rectangle; what makes it read
 * as glass is colour moving behind it, a light source above it, and an edge
 * that catches that light. So this module owns two halves that only work
 * together:
 *
 * - `bakeBackdrop` / `addBackdrop` put something vibrant *behind* the UI. This
 *   is the part people skip, and it is the reason most glassmorphism looks like
 *   grey boxes.
 * - `drawGlass` paints the panel itself: a shadow it casts, a translucent body,
 *   a specular sheen falling off from the top, and a rim that is brightest
 *   where the light hits it.
 *
 * There is deliberately no runtime blur. A real `backdrop-filter` has no Phaser
 * equivalent that is cheap enough for a game loop — but blur only matters when
 * there is detail to destroy, and the backdrop below is baked as broad soft
 * gradients with no high-frequency detail in the first place. Blurring it would
 * change nothing a player could see, at a cost they would feel.
 */

export const GLASS_TEX = 'cs-backdrop';

/**
 * The core opacity of each field.
 *
 * Capped where it is because the glass over it still has to hold small text:
 * a brighter field lifts the composed surface past the point where secondary
 * type can reach 4.5:1. Vibrance is spent around the panels, not through them.
 */
const BLOB_CORE = 0.34;

/** The colour fields that drift behind the glass, as [hex, x, y, radius]. */
const BLOBS: readonly [number, number, number, number][] = [
  [0x3df0ff, 0.18, 0.12, 0.55], // cyan, top left — the rope's colour
  [0xffc63d, 0.86, 0.22, 0.5], // gold, top right — time
  [0x7b5cff, 0.72, 0.72, 0.62], // violet, lower right — depth
  [0x3dffa0, 0.16, 0.85, 0.45], // green, lower left — the goal
];

/**
 * Bakes the vibrant field the glass sits on.
 *
 * Drawn once into an offscreen canvas rather than composed per frame: it never
 * changes, and a stack of large additive radial gradients is not something to
 * repaint sixty times a second. The canvas blur is a nicety — where a browser
 * does not support `filter` on a 2D context the gradients are already soft
 * enough that nothing looks wrong.
 */
export function bakeBackdrop(scene: Phaser.Scene): void {
  if (scene.textures.exists(GLASS_TEX)) return;

  const size = 512;
  const canvas = scene.textures.createCanvas(GLASS_TEX, size, size);
  if (!canvas) return;
  const ctx = canvas.getContext();

  ctx.fillStyle = css(C.bg);
  ctx.fillRect(0, 0, size, size);

  try {
    ctx.filter = 'blur(48px)';
  } catch {
    // Older canvas implementations simply paint unblurred, which is fine.
  }

  // Additive, so where two fields overlap the result brightens rather than
  // muddying — the same way coloured light behaves.
  ctx.globalCompositeOperation = 'lighter';
  for (const [colour, cx, cy, radius] of BLOBS) {
    const r = size * radius;
    const grad = ctx.createRadialGradient(size * cx, size * cy, 0, size * cx, size * cy, r);
    grad.addColorStop(0, rgba(colour, BLOB_CORE));
    grad.addColorStop(0.45, rgba(colour, BLOB_CORE * 0.32));
    grad.addColorStop(1, rgba(colour, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(size * cx - r, size * cy - r, r * 2, r * 2);
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  canvas.refresh();
}

/**
 * Puts the backdrop behind a screen and keeps it there through resizes.
 *
 * Returned so the caller can hand it to a camera to ignore — the play scene
 * renders its interface on a second camera, and a backdrop that appeared on
 * both would be drawn twice at two different scales.
 */
export function addBackdrop(scene: Phaser.Scene): Phaser.GameObjects.Image {
  bakeBackdrop(scene);

  const img = scene.add.image(0, 0, GLASS_TEX).setDepth(-1000).setScrollFactor(0);
  const fit = (): void => {
    const w = scene.scale.width;
    const h = scene.scale.height;
    img.setPosition(w / 2, h / 2);
    // Cover rather than stretch: the fields are abstract, but a squashed
    // gradient still reads as a squashed gradient.
    const scale = Math.max(w, h) / 512;
    img.setScale(scale * 1.08);
  };

  fit();
  scene.scale.on(Phaser.Scale.Events.RESIZE, fit);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    scene.scale.off(Phaser.Scale.Events.RESIZE, fit);
  });

  // A very slow drift, so the light behind the glass is alive without ever
  // being something the eye has to track.
  scene.tweens.add({
    targets: img,
    angle: { from: -2.5, to: 2.5 },
    duration: 42_000,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  });

  return img;
}

export interface GlassOptions {
  /** Body opacity. Defaults to the token; raise it for surfaces that hold text. */
  fill?: number;
  /** Skip the cast shadow for glass that sits flush on another surface. */
  raised?: boolean;
  /** Tints the body, for glass that has to mean something. */
  tint?: number;
}

/**
 * Paints one pane of glass.
 *
 * The order is the physics: what it casts, what it is made of, what the light
 * does to it, and where its edges are. Reordering any of these is what makes
 * glass look like a flat translucent rectangle.
 */
export function drawGlass(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  u: number,
  opts: GlassOptions = {},
): void {
  const fill = opts.fill ?? GLASS.fill;
  const line = Math.max(1, GLASS.rim * u);

  // 1. The shadow it casts. Two offset passes rather than one, so the falloff
  //    is soft instead of a hard second rectangle.
  if (opts.raised !== false) {
    g.fillStyle(C.bg, 0.28);
    g.fillRoundedRect(x, y + 6 * u, w, h, radius);
    g.fillStyle(C.bg, 0.2);
    g.fillRoundedRect(x, y + 2 * u, w, h, radius);
  }

  // 2. The body. A dark base keeps text legible over a bright field, then the
  //    translucent white on top is what actually reads as glass.
  g.fillStyle(C.panel, GLASS.base);
  g.fillRoundedRect(x, y, w, h, radius);
  g.fillStyle(opts.tint ?? 0xffffff, fill);
  g.fillRoundedRect(x, y, w, h, radius);

  // 3. The sheen. Light comes from above, so the top of the pane is brighter;
  //    three shrinking bands approximate the falloff a gradient would give.
  const sheen = Math.min(h * 0.5, 64 * u);
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    g.fillStyle(0xffffff, GLASS.sheen * (1 - t));
    g.fillRoundedRect(x, y, w, sheen * (1 - t * 0.55), radius);
  }

  // 4. The rim, and the lit edge along the top of it. The bright hairline is
  //    the single detail that sells the material.
  g.lineStyle(line, 0xffffff, GLASS.rimAlpha);
  g.strokeRoundedRect(x, y, w, h, radius);
  g.lineStyle(line, 0xffffff, GLASS.rimTop);
  g.lineBetween(x + radius * 0.7, y + line / 2, x + w - radius * 0.7, y + line / 2);
}

/** A pane drawn straight onto its own Graphics, for callers that want one. */
export function glassPanel(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  u: number,
  opts: GlassOptions = {},
): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  drawGlass(g, x, y, w, h, R.lg * u, u, opts);
  return g;
}

function css(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function rgba(n: number, a: number): string {
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
