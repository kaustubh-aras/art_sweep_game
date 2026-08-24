import type Phaser from 'phaser';
import playerUrl from '@/assets/player.png';
import anchorUrl from '@/assets/anchor.png';
import clockUrl from '@/assets/clock.png';
import hazardUrl from '@/assets/hazard.png';
import enemyUrl from '@/assets/enemy.png';
import platformUrl from '@/assets/platform.png';
import backdropUrl from '@/assets/backdrop.jpg';
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
  [TEX.enemy, enemyUrl],
];

/** Artwork with no generated equivalent, for things drawn as shapes before. */
export const ART = {
  hazard: 'cs-art-hazard',
  platform: 'cs-art-platform',
  backdrop: 'cs-art-backdrop',
} as const;

const ADDITIONS: readonly (readonly [string, string])[] = [
  [ART.hazard, hazardUrl],
  [ART.platform, platformUrl],
  [ART.backdrop, backdropUrl],
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
  [TEX.enemy]: { w: COMBAT.enemyRadius * 2 + 12, h: COMBAT.enemyRadius * 2 + 12 },
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
