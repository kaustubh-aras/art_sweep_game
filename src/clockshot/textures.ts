import Phaser from 'phaser';
import { C } from './theme';
import { COMBAT, PLAYER_SIZE } from './tuning';

/**
 * Every sprite in Clockshot is drawn here at boot.
 *
 * Nothing is loaded over the network, which removes a whole category of
 * failure inside a Reddit web view — there is no asset request to be slow,
 * blocked, or 404. It also keeps the shapes crisp at any device pixel ratio,
 * because they are baked at the ratio the device actually reports.
 */

export const TEX = {
  player: 'cs-player',
  enemy: 'cs-enemy',
  clock: 'cs-clock',
  golden: 'cs-golden',
  goal: 'cs-goal',
  checkpoint: 'cs-cp',
  checkpointLit: 'cs-cp-lit',
  anchor: 'cs-anchor',
  spark: 'cs-spark',
} as const;

/** Draws into an offscreen canvas and registers it as a texture. */
function bake(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  draw: (g: Phaser.GameObjects.Graphics) => void,
): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  draw(g);
  g.generateTexture(key, w, h);
  g.destroy();
}

/** A soft round glow, used behind anything that should read as energy. */
function glow(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number, color: number): void {
  for (let i = 6; i >= 1; i--) {
    g.fillStyle(color, 0.055 * i);
    g.fillCircle(cx, cy, (r * i) / 6 + 2);
  }
}

function clockFace(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  r: number,
  body: number,
  hands: number,
): void {
  g.fillStyle(body, 1);
  g.fillCircle(cx, cy, r);
  g.lineStyle(2, hands, 0.9);
  g.strokeCircle(cx, cy, r);
  // Two hands, so even a 10px pickup reads as a clock rather than a dot.
  g.lineBetween(cx, cy, cx, cy - r * 0.62);
  g.lineBetween(cx, cy, cx + r * 0.46, cy + r * 0.2);
}

function playerBody(g: Phaser.GameObjects.Graphics, accent: number): void {
  const { w, h } = PLAYER_SIZE;
  const pad = 6;
  glow(g, pad + w / 2, pad + h / 2, w * 0.9, accent);

  // A hard-edged capsule: strong silhouette at small sizes.
  g.fillStyle(C.ink, 1);
  g.fillRoundedRect(pad, pad, w, h, 8);
  g.fillStyle(accent, 1);
  g.fillRoundedRect(pad, pad, w, h * 0.42, { tl: 8, tr: 8, bl: 0, br: 0 });

  // Visor, which also tells the player which way is up at a glance.
  g.fillStyle(C.bg, 1);
  g.fillRoundedRect(pad + 5, pad + h * 0.46, w - 10, h * 0.2, 3);
  g.fillStyle(accent, 0.85);
  g.fillRect(pad + 7, pad + h * 0.5, w - 14, 3);
}

export function bakeTextures(scene: Phaser.Scene): void {
  const { w, h } = PLAYER_SIZE;
  const pw = w + 12;
  const ph = h + 12;

  bake(scene, TEX.player, pw, ph, (g) => playerBody(g, C.cyan));

  // Enemy: a hostile clock. Same visual family as the collectibles, opposite
  // colour, so the player never has to learn two unrelated languages.
  const er = COMBAT.enemyRadius;
  bake(scene, TEX.enemy, er * 2 + 12, er * 2 + 12, (g) => {
    const c = er + 6;
    glow(g, c, c, er * 1.1, C.danger);
    g.fillStyle(C.danger, 1);
    g.fillCircle(c, c, er);
    g.fillStyle(0x2a0d0d, 1);
    g.fillCircle(c, c, er - 5);
    g.lineStyle(2.5, C.ink, 0.95);
    g.lineBetween(c, c, c, c - er * 0.6);
    g.lineBetween(c, c, c - er * 0.5, c + er * 0.28);
    // Teeth around the rim read as a gear even in motion.
    g.fillStyle(C.danger, 1);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.fillRect(c + Math.cos(a) * er - 2.5, c + Math.sin(a) * er - 2.5, 5, 5);
    }
  });

  bake(scene, TEX.clock, 30, 30, (g) => {
    glow(g, 15, 15, 9, C.gold);
    clockFace(g, 15, 15, 7, C.gold, 0x3d2a00);
  });

  bake(scene, TEX.golden, 60, 60, (g) => {
    glow(g, 30, 30, 22, C.gold);
    g.fillStyle(C.ink, 0.9);
    g.fillCircle(30, 30, 19);
    clockFace(g, 30, 30, 16, C.gold, 0x3d2a00);
    // A crown of rays, so the golden clock is unmistakable across the arena.
    g.lineStyle(2.5, C.gold, 0.9);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.lineBetween(
        30 + Math.cos(a) * 21,
        30 + Math.sin(a) * 21,
        30 + Math.cos(a) * 27,
        30 + Math.sin(a) * 27,
      );
    }
  });

  // The goal: a ring big enough to spot from across the arena, in the one
  // colour nothing else in the game uses.
  bake(scene, TEX.goal, 96, 96, (g) => {
    const c = 48;
    glow(g, c, c, 34, C.goal);
    g.fillStyle(C.goalDeep, 0.9);
    g.fillCircle(c, c, 30);
    g.lineStyle(4, C.goal, 1);
    g.strokeCircle(c, c, 30);
    g.lineStyle(2, C.goal, 0.6);
    g.strokeCircle(c, c, 40);
    // A chequered inner ring, so it reads as a finish line and not a pickup.
    g.fillStyle(C.goal, 1);
    for (let i = 0; i < 12; i += 2) {
      const a0 = (i / 12) * Math.PI * 2;
      const a1 = ((i + 1) / 12) * Math.PI * 2;
      g.beginPath();
      g.arc(c, c, 22, a0, a1, false);
      g.arc(c, c, 13, a1, a0, true);
      g.closePath();
      g.fillPath();
    }
  });

  // A flag on a post. Two versions, because "have I got this one?" has to be
  // answerable from across the arena at a glance.
  const flag = (g: Phaser.GameObjects.Graphics, color: number, lit: boolean): void => {
    if (lit) glow(g, 26, 30, 20, color);
    g.lineStyle(4, color, 1);
    g.lineBetween(16, 12, 16, 56);
    g.fillStyle(color, lit ? 1 : 0.55);
    g.fillTriangle(18, 14, 46, 24, 18, 34);
    g.fillStyle(color, 1);
    g.fillCircle(16, 58, 5);
  };
  bake(scene, TEX.checkpoint, 56, 66, (g) => flag(g, C.checkpoint, false));
  bake(scene, TEX.checkpointLit, 56, 66, (g) => flag(g, C.checkpointLit, true));

  bake(scene, TEX.anchor, 34, 34, (g) => {
    glow(g, 17, 17, 10, C.cyan);
    g.lineStyle(2.5, C.cyan, 0.95);
    g.strokeCircle(17, 17, 8);
    g.fillStyle(C.cyan, 1);
    g.fillCircle(17, 17, 3.5);
  });

  bake(scene, TEX.spark, 14, 14, (g) => {
    g.fillStyle(0xffffff, 1);
    g.fillCircle(7, 7, 3.2);
  });
}
