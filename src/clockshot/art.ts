import type Phaser from 'phaser';
import playerUrl from '@/assets/player.png';
import anchorUrl from '@/assets/anchor.png';
import clockUrl from '@/assets/clock.png';
import hazardUrl from '@/assets/hazard.png';
import enemySheetUrl from '@/assets/enemy-sheet.png';
import anchorLitUrl from '@/assets/anchor-lit.png';
import platform1Url from '@/assets/platform-1.png';
import platform2Url from '@/assets/platform-2.png';
import platform3Url from '@/assets/platform-3.png';
import { TEX } from './textures';
import { COMBAT, PLAYER_SIZE } from './tuning';

/**
 * The illustrated artwork, and how it gets into the game.
 *
 * Clockshot drew every sprite procedurally so that nothing could fail to load
 * inside a Reddit web view. That property is worth keeping even now there is
 * real art, so the two systems are layered rather than swapped: these images
 * are loaded under the *same texture keys* the generator uses, and `bake()` in
 * `textures.ts` already skips any key that exists. Art wins when it arrives;
 * the drawn version is still there, automatically, when it does not.
 *
 * The files are imported rather than dropped in `public/`, so Vite fingerprints
 * them and emits them into the webroot Devvit uploads. Nothing is referenced by
 * a bare path that could rot.
 */

/** Textures that stand in for a generated one, keyed the same way. */
const REPLACEMENTS: readonly (readonly [string, string])[] = [
  [TEX.player, playerUrl],
  [TEX.anchor, anchorUrl],
  [TEX.clock, clockUrl],
];

/** Artwork with no generated equivalent, for things drawn as shapes before. */
/**
 * The enemy's sheet, described once.
 *
 * The frame size and the count live next to the file they belong to, because
 * they are properties of the artwork rather than of the scene that plays it —
 * a re-export at a different size should only have to change these numbers.
 */
export const ENEMY_ANIM = {
  key: 'cs-art-enemy',
  frameWidth: 128,
  frameHeight: 128,
  frames: 48,
  /** Above the source's own 25fps: it should look like it is straining. */
  frameRate: 34,
} as const;

export const ART = {
  /** The grapple point while it is lit — see `TEX.anchor` for its dim state. */
  anchorLit: 'cs-art-anchor-lit',
  hazard: 'cs-art-hazard',
  /**
   * Three interchangeable stone tiles.
   *
   * Kept as separate textures rather than one strip, because they are chosen
   * per cell — a tile is picked from this list by where it sits, so a wall of
   * stone is not the same block printed forty times.
   */
  platform: ['cs-art-platform-1', 'cs-art-platform-2', 'cs-art-platform-3'],
} as const;

const ADDITIONS: readonly (readonly [string, string])[] = [
  [ART.anchorLit, anchorLitUrl],
  [ART.hazard, hazardUrl],
  [ART.platform[0], platform1Url],
  [ART.platform[1], platform2Url],
  [ART.platform[2], platform3Url],
];

/**
 * Queues every image. Call from a scene's `preload`.
 *
 * A failure here is deliberately not fatal: Phaser reports it, the key never
 * appears, and everything downstream falls back to the drawn shape it replaced.
 * A post that cannot reach a CDN should still be playable.
 */
export function loadArt(scene: Phaser.Scene): void {
  for (const [key, url] of [...REPLACEMENTS, ...ADDITIONS]) {
    if (scene.textures.exists(key)) continue;
    scene.load.image(key, url);
  }

  // The enemy is a sheet rather than a still, so it is loaded as one: Phaser
  // has to be told the frame size up front or it cannot cut it.
  if (!scene.textures.exists(ENEMY_ANIM.key)) {
    scene.load.spritesheet(ENEMY_ANIM.key, enemySheetUrl, {
      frameWidth: ENEMY_ANIM.frameWidth,
      frameHeight: ENEMY_ANIM.frameHeight,
    });
  }
}

/** Whether a piece of artwork actually arrived. */
export function hasArt(scene: Phaser.Scene, key: string): boolean {
  return scene.textures.exists(key);
}

/**
 * The size each texture is meant to occupy in the world, in game units.
 *
 * The generated sprites were baked at exactly these dimensions, so they need no
 * adjustment. The illustrations are 128px-tall source art and would otherwise
 * render four times too large, which is the one way a drop-in replacement can
 * go loudly wrong. Naming the intended size here — rather than a scale factor —
 * means the artwork can be re-exported at any resolution without touching the
 * game.
 */
export const FIT: Readonly<Record<string, { w: number; h: number }>> = {
  [TEX.player]: { w: PLAYER_SIZE.w + 12, h: PLAYER_SIZE.h + 12 },
  [TEX.anchor]: { w: 34, h: 34 },
  [TEX.clock]: { w: 30, h: 30 },
  [ART.anchorLit]: { w: 34, h: 34 },
  /**
   * Drawn half again as large as the body that can actually hurt you.
   *
   * The overhang is the forgiving direction: a player who thinks they were
   * clipped by a thrashing limb and was not will believe they got away with
   * something, where the reverse — a hitbox reaching past the art — is the kind
   * of unfairness people quit over.
   */
  [ENEMY_ANIM.key]: {
    w: (COMBAT.enemyRadius * 2 + 12) * 1.5,
    h: (COMBAT.enemyRadius * 2 + 12) * 1.5,
  },
};

/**
 * Sizes a sprite to the space its texture is supposed to fill.
 *
 * Aspect is preserved: the delivered art is not the same shape as the box it
 * replaces, and stretching a pocket watch into a square is worse than letting
 * it be slightly short. Returns the scale it applied, for callers that animate
 * scale afterwards and need to know what "unscaled" means.
 */
export function fitArt(
  obj: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite,
  key: string,
): number {
  const want = FIT[key];
  if (!want) return obj.scaleX;

  const scale = Math.min(want.w / obj.width, want.h / obj.height);
  obj.setScale(scale);
  return scale;
}
