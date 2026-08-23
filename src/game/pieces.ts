import Phaser from 'phaser';
import { TILE, Colors, SIM_DT, SAW_RADIUS } from './constants';

/** Number of visual stages a crumble block shows before it collapses. */
export const CRUMBLE_STAGES = 3;

/** Extra per-piece config carried in the level JSON's `params` object.
 *  Currently only the saw uses it (a patrol path + speed). */
export interface PieceParams {
  path?: [number, number][];
  speed?: number;
  spike?: boolean; // ghost block: reveal a spike (deadly) instead of vanishing
}

/**
 * A Piece is one placeable thing on the grid. Every piece knows:
 *   - where it sits, as a grid coordinate (x, y) in tile units
 *   - how it behaves (solid? lethal? the goal?)
 *   - how to draw itself
 *
 * Placing one is just `new Block(3, 11)` — give it a coordinate and you're done.
 * This is also the in-memory form of the §5.5 level JSON.
 */
export type PieceType =
  | 'block'
  | 'spike'
  | 'exit'
  | 'key'
  | 'crumble'
  | 'spring'
  | 'defuser'
  | 'saw'
  | 'ghost';

/** Which way a directional piece faces. For a spike it's where the point aims;
 *  for a spring it's the direction it launches the player. */
export type Dir4 = 'up' | 'down' | 'left' | 'right';

/** The four 45° diagonals (springs only). */
export type DiagDir = 'up-left' | 'up-right' | 'down-left' | 'down-right';

/** Any of the eight facings a spring can have. */
export type Dir8 = Dir4 | DiagDir;

const INV_SQRT2 = 0.70710678; // 1/√2 — keeps diagonal vectors unit-length

/** Unit vector for each direction (screen coords: +y is down). */
const DIR_VEC: Record<Dir8, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  'up-left': { x: -INV_SQRT2, y: -INV_SQRT2 },
  'up-right': { x: INV_SQRT2, y: -INV_SQRT2 },
  'down-left': { x: -INV_SQRT2, y: INV_SQRT2 },
  'down-right': { x: INV_SQRT2, y: INV_SQRT2 },
};

export abstract class Piece {
  constructor(
    public x: number,
    public y: number,
  ) {}

  abstract readonly type: PieceType;

  /** Behavior flags — the sim reads these, never instanceof checks. */
  readonly solid: boolean = false; // blocks movement
  readonly lethal: boolean = false; // kills on touch
  readonly goal: boolean = false; // clears the level on touch
  readonly collectible: boolean = false; // picked up on touch (keys)

  /** Dynamic pieces change/hide at runtime, so RaidScene draws them into their
   *  own Graphics object rather than the shared static layer. */
  readonly dynamic: boolean = false;

  abstract draw(g: Phaser.GameObjects.Graphics): void;

  /** Pixel position of this tile's top-left corner. */
  protected get px(): number {
    return this.x * TILE;
  }
  protected get py(): number {
    return this.y * TILE;
  }

  /** Serialize to the level-JSON shape (§5.5). */
  toJSON(): { type: PieceType; x: number; y: number } {
    return { type: this.type, x: this.x, y: this.y };
  }
}

/** Shared block face — reused by Block AND Ghost so they're pixel-identical. */
function drawBlockFace(g: Phaser.GameObjects.Graphics, px: number, py: number): void {
  g.fillStyle(Colors.block, 1);
  g.fillRect(px, py, TILE, TILE);
  // Inset edge so blocks read as bricks, not one flat slab.
  g.lineStyle(1, Colors.blockEdge, 1);
  g.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
}

/** Shared directional spike triangle — reused by Spike and by a spike-Ghost. */
function drawSpikeShape(g: Phaser.GameObjects.Graphics, px: number, py: number, dir: Dir4): void {
  const s = TILE;
  g.fillStyle(Colors.spike, 1);
  switch (dir) {
    case 'up':
      g.fillTriangle(px, py + s, px + s / 2, py, px + s, py + s);
      break;
    case 'down':
      g.fillTriangle(px, py, px + s / 2, py + s, px + s, py);
      break;
    case 'left':
      g.fillTriangle(px + s, py, px, py + s / 2, px + s, py + s);
      break;
    case 'right':
      g.fillTriangle(px, py, px + s, py + s / 2, px, py + s);
      break;
  }
}

/** Revealed kill-block face — the distinct texture a spike-Ghost shows once
 *  triggered: a dark crimson block with a row of teeth on its facing side.
 *  Deliberately unlike both a normal block and a plain spike. */
function drawKillBlock(g: Phaser.GameObjects.Graphics, px: number, py: number, dir: Dir4): void {
  const s = TILE;
  g.fillStyle(Colors.kill, 1);
  g.fillRect(px, py, s, s);
  g.lineStyle(1, Colors.killEdge, 1);
  g.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);

  // A row of bright teeth biting out of the facing edge.
  g.fillStyle(Colors.spike, 1);
  const n = 4;
  const w = s / n;
  for (let i = 0; i < n; i++) {
    const o = i * w;
    switch (dir) {
      case 'up':
        g.fillTriangle(px + o, py + w, px + o + w / 2, py + 2, px + o + w, py + w);
        break;
      case 'down':
        g.fillTriangle(px + o, py + s - w, px + o + w / 2, py + s - 2, px + o + w, py + s - w);
        break;
      case 'left':
        g.fillTriangle(px + w, py + o, px + 2, py + o + w / 2, px + w, py + o + w);
        break;
      case 'right':
        g.fillTriangle(px + s - w, py + o, px + s - 2, py + o + w / 2, px + s - w, py + o + w);
        break;
    }
  }
}

/** Grey brick — static terrain, the floors and walls. */
export class Block extends Piece {
  readonly type = 'block' as const;
  readonly solid = true;

  draw(g: Phaser.GameObjects.Graphics): void {
    drawBlockFace(g, this.px, this.py);
  }
}

/** Death triangle — one-hit kill on contact. `dir` is the way the point aims
 *  (which surface it's mounted on); it's cosmetic — a spike is lethal on any
 *  contact regardless of facing. Defaults to 'up' (floor spike). */
export class Spike extends Piece {
  readonly type = 'spike' as const;
  readonly lethal = true;

  constructor(x: number, y: number, public dir: Dir4 = 'up') {
    super(x, y);
  }

  draw(g: Phaser.GameObjects.Graphics): void {
    drawSpikeShape(g, this.px, this.py, this.dir);
  }

  toJSON(): { type: PieceType; x: number; y: number; dir: Dir4 } {
    return { type: this.type, x: this.x, y: this.y, dir: this.dir };
  }
}

/** End box — the exit door. Locked (purple) until every key is collected,
 *  then unlocked (green). `locked` is runtime state, not serialized. */
export class Exit extends Piece {
  readonly type = 'exit' as const;
  readonly goal = true;
  readonly dynamic = true;

  locked = false;

  draw(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(this.locked ? Colors.exitLocked : Colors.exit, 1);
    g.fillRect(this.px + 4, this.py, TILE - 8, TILE);
    g.lineStyle(2, 0xffffff, 0.35);
    g.strokeRect(this.px + 4, this.py + 1, TILE - 8, TILE - 2);
    if (this.locked) {
      // Keyhole so "locked" reads instantly.
      g.fillStyle(0x000000, 0.45);
      g.fillCircle(this.px + TILE / 2, this.py + TILE / 2 - 2, 3);
      g.fillRect(this.px + TILE / 2 - 1, this.py + TILE / 2 - 1, 2, 6);
    }
  }
}

/** Key — collect every key in the level to unlock the exit. */
export class Key extends Piece {
  readonly type = 'key' as const;
  readonly collectible = true;
  readonly dynamic = true;

  draw(g: Phaser.GameObjects.Graphics): void {
    const cx = this.px + TILE / 2;
    const cy = this.py + TILE / 2;
    g.fillStyle(Colors.key, 1);
    g.fillCircle(cx - 3, cy - 3, 5); // bow (ring)
    g.fillStyle(Colors.bg, 1);
    g.fillCircle(cx - 3, cy - 3, 2); // ring hole
    g.fillStyle(Colors.key, 1);
    g.fillRect(cx - 1, cy - 3, 3, 10); // shaft
    g.fillRect(cx + 2, cy + 4, 4, 2); // tooth
    g.fillRect(cx + 2, cy + 1, 3, 2); // tooth
  }
}

/**
 * Crumble block — solid terrain that collapses 0.5s after being stood on,
 * cracking through CRUMBLE_STAGES visual stages first, then dropping away.
 * Rebuilds on player death (§5.4). `stage` is runtime render state.
 */
export class CrumbleBlock extends Piece {
  readonly type = 'crumble' as const;
  readonly solid = true;
  readonly dynamic = true;

  stage = 0; // 0 = intact ... CRUMBLE_STAGES-1 = about to drop

  draw(g: Phaser.GameObjects.Graphics): void {
    // As it cracks, the block fades and gaps open up.
    const alpha = 1 - this.stage * 0.18;
    g.fillStyle(Colors.crumble, alpha);
    g.fillRect(this.px, this.py, TILE, TILE);
    g.lineStyle(1, Colors.crumbleEdge, 1);
    g.strokeRect(this.px + 0.5, this.py + 0.5, TILE - 1, TILE - 1);

    // Progressive cracks — more appear at each stage.
    g.lineStyle(2, 0x2a1a0a, 0.55);
    const cx = this.px + TILE / 2;
    const cy = this.py + TILE / 2;
    if (this.stage >= 1) {
      g.lineBetween(cx, this.py + 3, cx - 5, cy);
      g.lineBetween(cx - 5, cy, cx + 3, this.py + TILE - 3);
    }
    if (this.stage >= 2) {
      g.lineBetween(this.px + 3, this.py + 6, cx, cy);
      g.lineBetween(cx, cy, this.px + TILE - 3, this.py + TILE - 6);
    }
  }
}

/**
 * Spring — solid pad that launches the player to a FIXED height when they land
 * on top of it, no matter how the jump button is held (§5.4). The bounce height
 * is set by SPRING_APEX_TILES, not by the player's jump. `squash` is runtime
 * render state: it pops to 1 on trigger and eases back to 0 for a coil-compress
 * animation. Solid, so you can also wall it off — but you approach from above.
 */
export class Spring extends Piece {
  readonly type = 'spring' as const;
  readonly solid = true;
  readonly dynamic = true;

  squash = 0; // 0 = at rest ... 1 = fully compressed

  constructor(x: number, y: number, public dir: Dir8 = 'up') {
    super(x, y);
  }

  draw(g: Phaser.GameObjects.Graphics): void {
    const v = DIR_VEC[this.dir];
    const cx = this.px + TILE / 2;
    const cy = this.py + TILE / 2;
    // Perpendicular to the launch axis (the coil's zigzag width).
    const px = -v.y;
    const py = v.x;
    const half = TILE / 2 - 6; // coil half-width
    const baseReach = TILE / 2 - 3; // base plate sits against the mounting wall
    const restReach = TILE / 2 - 7; // launch plate at rest
    const padReach = restReach - this.squash * 9; // compresses toward the base

    // Base plate (against the wall the spring is mounted on).
    const bx = cx - v.x * baseReach;
    const by = cy - v.y * baseReach;
    g.lineStyle(5, Colors.springEdge, 1);
    g.lineBetween(bx - px * half, by - py * half, bx + px * half, by + py * half);

    // Launch plate (the face the player hits).
    const dx = cx + v.x * padReach;
    const dy = cy + v.y * padReach;

    // Zigzag coil between base and launch plate.
    g.lineStyle(2, Colors.spring, 1);
    let prevX = bx - px * half;
    let prevY = by - py * half;
    const rungs = 4;
    for (let i = 1; i <= rungs; i++) {
      const t = i / rungs;
      const mx = bx + (dx - bx) * t;
      const my = by + (dy - by) * t;
      const sgn = i % 2 === 0 ? -1 : 1;
      const nx = mx + px * half * sgn;
      const ny = my + py * half * sgn;
      g.lineBetween(prevX, prevY, nx, ny);
      prevX = nx;
      prevY = ny;
    }
    g.lineBetween(prevX, prevY, dx, dy);

    g.lineStyle(5, Colors.spring, 1);
    g.lineBetween(dx - px * half, dy - py * half, dx + px * half, dy + py * half);
  }

  toJSON(): { type: PieceType; x: number; y: number; dir: Dir8 } {
    return { type: this.type, x: this.x, y: this.y, dir: this.dir };
  }
}

/**
 * Defusal kit — collect it to stop the level's countdown timer for the rest of
 * that run (§5.4). Like a key, it resets and must be re-collected on every death.
 * Harmless on timer-less levels. Collectible; never solid or lethal.
 */
export class Defuser extends Piece {
  readonly type = 'defuser' as const;
  readonly collectible = true;
  readonly dynamic = true;

  draw(g: Phaser.GameObjects.Graphics): void {
    const x = this.px;
    const y = this.py;
    // Case body.
    g.fillStyle(Colors.defuser, 1);
    g.fillRect(x + 6, y + 12, TILE - 12, TILE - 16);
    g.lineStyle(2, Colors.defuserEdge, 1);
    g.strokeRect(x + 6, y + 12, TILE - 12, TILE - 16);
    // Handle.
    g.lineStyle(2, Colors.defuserEdge, 1);
    g.strokeRect(x + 11, y + 8, TILE - 22, 5);
    // Red wire being snipped — reads as "defuse".
    g.lineStyle(2, Colors.spike, 1);
    g.lineBetween(x + 8, y + 24, x + TILE - 8, y + 18);
    // Latch highlight.
    g.fillStyle(0xffffff, 0.85);
    g.fillRect(x + TILE / 2 - 1, y + 14, 2, 3);
  }
}

/**
 * Saw blade — patrols a builder-drawn 2-point line at a constant speed,
 * ping-ponging between the endpoints. Its position is a PURE FUNCTION of the
 * attempt tick (§9.1), so the route is identical on every device and every
 * run — essential for Creator Verified. Kills on touch via a circular hitbox;
 * it is not solid and not tile-lethal (RaidScene does the circle test).
 */
export class Saw extends Piece {
  readonly type = 'saw' as const;
  readonly dynamic = true;

  constructor(
    x: number,
    y: number,
    public path: [number, number][] = [
      [x, y],
      [x, y],
    ],
    public speed = 3,
  ) {
    super(x, y);
  }

  /** Blade center, in TILE coords, at the given attempt tick. Deterministic. */
  centerAt(tick: number): { x: number; y: number } {
    const a = this.path[0];
    const b = this.path[1] ?? a;
    const ax = a[0] + 0.5;
    const ay = a[1] + 0.5;
    const bx = b[0] + 0.5;
    const by = b[1] + 0.5;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: ax, y: ay };
    const traveled = this.speed * tick * SIM_DT; // tiles along the line
    const phase = traveled % (2 * len); // one full there-and-back
    const t = phase <= len ? phase / len : (2 * len - phase) / len; // ping-pong 0..1
    return { x: ax + dx * t, y: ay + dy * t };
  }

  /** Static blade art, drawn once centered at local (0,0); RaidScene spins it. */
  draw(g: Phaser.GameObjects.Graphics): void {
    const R = SAW_RADIUS * TILE;
    g.fillStyle(Colors.saw, 1);
    g.fillCircle(0, 0, R * 0.78);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.fillTriangle(
        Math.cos(a) * R, Math.sin(a) * R, // tooth tip
        Math.cos(a - 0.22) * R * 0.78, Math.sin(a - 0.22) * R * 0.78,
        Math.cos(a + 0.22) * R * 0.78, Math.sin(a + 0.22) * R * 0.78,
      );
    }
    g.fillStyle(Colors.sawEdge, 1);
    g.fillCircle(0, 0, R * 0.3); // hub
    g.fillStyle(Colors.bg, 1);
    g.fillCircle(0, 0, R * 0.1); // bore
  }

  toJSON(): {
    type: PieceType;
    x: number;
    y: number;
    params: { path: [number, number][]; speed: number };
  } {
    return { type: this.type, x: this.x, y: this.y, params: { path: this.path, speed: this.speed } };
  }
}

/**
 * Ghost block — renders IDENTICALLY to a normal block but has NO collision
 * (§5.4 #9). There is no visual tell. The instant the player overlaps it, it
 * triggers: a plain ghost simply vanishes (it was a fake platform), while a
 * `becomesSpike` ghost reveals a directional spike and kills — a disguised
 * trap. Resets on death so each attempt is a fresh guess. Never solid.
 */
export class Ghost extends Piece {
  readonly type = 'ghost' as const;
  readonly dynamic = true;

  triggered = false; // runtime: has the player revealed it this attempt?

  constructor(
    x: number,
    y: number,
    public becomesSpike = false,
    public dir: Dir4 = 'up',
  ) {
    super(x, y);
  }

  draw(g: Phaser.GameObjects.Graphics): void {
    if (this.becomesSpike) {
      // Kill block: always shows its distinct texture — a telegraphed hazard.
      drawKillBlock(g, this.px, this.py, this.dir);
      return;
    }
    // Harmless ghost: mimics a real block until touched, then vanishes.
    if (!this.triggered) drawBlockFace(g, this.px, this.py);
  }

  toJSON(): {
    type: PieceType;
    x: number;
    y: number;
    dir: Dir4;
    params: { spike: boolean };
  } {
    return {
      type: this.type,
      x: this.x,
      y: this.y,
      dir: this.dir,
      params: { spike: this.becomesSpike },
    };
  }
}

/** Build a piece from its type + coordinate (used when loading JSON).
 *  `dir` is honored by the directional pieces (spike, spring, ghost-spike);
 *  `params` carries the saw's path/speed and the ghost's spike flag. */
export function createPiece(
  type: PieceType,
  x: number,
  y: number,
  dir?: Dir8,
  params?: PieceParams,
): Piece {
  switch (type) {
    case 'block':
      return new Block(x, y);
    case 'spike':
      // Spikes only face orthogonally; a diagonal value falls back to 'up'.
      return new Spike(x, y, dir as Dir4 | undefined);
    case 'exit':
      return new Exit(x, y);
    case 'key':
      return new Key(x, y);
    case 'crumble':
      return new CrumbleBlock(x, y);
    case 'spring':
      return new Spring(x, y, dir);
    case 'defuser':
      return new Defuser(x, y);
    case 'saw':
      return new Saw(x, y, params?.path, params?.speed);
    case 'ghost':
      return new Ghost(x, y, params?.spike ?? false, dir as Dir4 | undefined);
  }
}
