/**
 * The editor's glyphs.
 *
 * One drawing per piece, sized by a radius, used at two very different scales:
 * tiny on a palette chip and full size on the grid. Keeping both in one
 * function is what stops the palette from quietly disagreeing with the canvas
 * about what a checkpoint looks like.
 *
 * These are deliberately close cousins of the baked textures in `textures.ts`
 * rather than the textures themselves — the editor draws everything into one
 * `Graphics` so that panning a grid of two hundred cells costs one redraw and
 * no sprites at all.
 */

import Phaser from 'phaser';
import { C } from './theme';
import type { Tool } from './build';

export function drawPieceIcon(
  g: Phaser.GameObjects.Graphics,
  tool: Tool,
  cx: number,
  cy: number,
  r: number,
): void {
  switch (tool) {
    case 'block':
      return block(g, cx, cy, r);
    case 'anchor':
      return anchor(g, cx, cy, r);
    case 'clock':
      return clock(g, cx, cy, r, false);
    case 'golden':
      return clock(g, cx, cy, r, true);
    case 'checkpoint':
      return checkpoint(g, cx, cy, r);
    case 'spike':
      return spike(g, cx, cy, r);
    case 'enemy':
      return enemy(g, cx, cy, r);
    case 'spawn':
      return spawn(g, cx, cy, r);
    case 'goal':
      return goal(g, cx, cy, r);
    default:
      return;
  }
}

function block(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
  g.fillStyle(C.platform, 1);
  g.fillRoundedRect(cx - r, cy - r, r * 2, r * 2, r * 0.28);
  g.fillStyle(C.platformTop, 1);
  g.fillRect(cx - r + r * 0.15, cy - r, r * 1.7, Math.max(1.2, r * 0.22));
}

/** A ring with a bite out of it, which is how an anchor reads in play too. */
function anchor(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
  g.lineStyle(Math.max(1.2, r * 0.24), C.cyan, 0.95);
  g.strokeCircle(cx, cy, r * 0.78);
  g.fillStyle(C.cyan, 1);
  g.fillCircle(cx, cy, r * 0.24);
}

function clock(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  r: number,
  golden: boolean,
): void {
  const R = golden ? r : r * 0.86;
  g.fillStyle(golden ? C.gold : C.goldDeep, golden ? 0.9 : 0.75);
  g.fillCircle(cx, cy, R);
  g.lineStyle(Math.max(1, R * 0.18), C.gold, 1);
  g.strokeCircle(cx, cy, R);

  // Hands at ten past two: an unmistakable clock at any size.
  g.lineStyle(Math.max(1, R * 0.16), golden ? C.bg : C.gold, 1);
  g.lineBetween(cx, cy, cx, cy - R * 0.55);
  g.lineBetween(cx, cy, cx + R * 0.45, cy + R * 0.2);

  if (golden) {
    g.lineStyle(Math.max(1, R * 0.1), C.gold, 0.55);
    g.strokeCircle(cx, cy, R * 1.35);
  }
}

/** A flag on a pole. Dim green until it is touched, exactly as in play. */
function checkpoint(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
  g.lineStyle(Math.max(1, r * 0.2), C.checkpoint, 1);
  g.lineBetween(cx - r * 0.5, cy - r, cx - r * 0.5, cy + r);
  g.fillStyle(C.goal, 0.85);
  g.fillTriangle(cx - r * 0.5, cy - r, cx + r * 0.85, cy - r * 0.35, cx - r * 0.5, cy + r * 0.3);
}

function spike(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
  g.fillStyle(C.danger, 0.95);
  const w = (r * 2) / 3;
  for (let i = 0; i < 3; i++) {
    const x = cx - r + i * w;
    g.fillTriangle(x, cy + r * 0.7, x + w / 2, cy - r * 0.7, x + w, cy + r * 0.7);
  }
}

function enemy(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
  g.fillStyle(C.danger, 0.9);
  g.fillTriangle(cx, cy - r, cx + r, cy, cx, cy + r);
  g.fillTriangle(cx, cy - r, cx - r, cy, cx, cy + r);
  g.fillStyle(C.bg, 1);
  g.fillCircle(cx - r * 0.22, cy - r * 0.08, Math.max(0.8, r * 0.14));
  g.fillCircle(cx + r * 0.22, cy - r * 0.08, Math.max(0.8, r * 0.14));
}

function spawn(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
  g.fillStyle(C.cyan, 0.9);
  g.fillCircle(cx, cy, r);
  g.fillStyle(C.bg, 1);
  g.fillTriangle(cx - r * 0.35, cy - r * 0.45, cx - r * 0.35, cy + r * 0.45, cx + r * 0.5, cy);
}

function goal(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number): void {
  g.lineStyle(Math.max(1.2, r * 0.22), C.goal, 1);
  g.strokeCircle(cx, cy, r * 0.9);
  g.fillStyle(C.goal, 0.9);
  g.fillCircle(cx, cy, r * 0.4);
  g.lineStyle(Math.max(1, r * 0.12), C.goal, 0.4);
  g.strokeCircle(cx, cy, r * 1.3);
}
