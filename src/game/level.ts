import Phaser from 'phaser';
import { KEY_MAX, GHOST_MAX } from './constants';
import {
  Piece,
  Key,
  Exit,
  CrumbleBlock,
  Spring,
  Defuser,
  Saw,
  Ghost,
  createPiece,
  type PieceType,
  type Dir8,
  type PieceParams,
} from './pieces';

export interface Point {
  x: number;
  y: number;
}

/** One placed piece in the level JSON (§5.5). `dir` is optional and only
 *  meaningful for directional pieces (spike, spring); omit it for the default. */
export interface PieceData {
  type: PieceType;
  x: number;
  y: number;
  dir?: Dir8;
  params?: PieceParams; // e.g. the saw's { path, speed }
}

/** Optional per-level countdown. Starts on the player's first move; if it
 *  hits zero the player dies. */
export interface TimerConfig {
  enabled: boolean;
  seconds: number;
}

/** The on-disk / over-the-wire level format. */
export interface LevelData {
  meta?: { title?: string; canvas?: string };
  spawn: Point; // player start location
  timer?: TimerConfig; // optional; omitted or enabled:false = no timer
  grid: PieceData[];
}

/**
 * A Level is an ordered list of Pieces plus a spawn point.
 *
 * Pieces are the source of truth (great for the editor and serialization),
 * but the sim needs fast "is there a solid at (x,y)?" checks — so on every
 * add() we also index the tile into O(1) lookup sets. Authoring stays
 * object-oriented; collision stays cheap.
 */
export class Level {
  readonly pieces: Piece[] = [];
  spawn: Point = { x: 1, y: 1 };
  timer: TimerConfig = { enabled: false, seconds: 0 };

  private readonly solidSet = new Set<string>();
  private readonly lethalSet = new Set<string>();
  private readonly goalSet = new Set<string>();
  private readonly springSet = new Set<string>();
  private keyCount = 0;
  private ghostCount = 0;

  private static key(x: number, y: number): string {
    return `${x},${y}`;
  }

  /** Place a piece. Returns `this` so calls can be chained.
   *  Keys past KEY_MAX are rejected (systemic cap, like the ghost-block limit). */
  add(piece: Piece): this {
    if (piece instanceof Key) {
      if (this.keyCount >= KEY_MAX) {
        console.warn(`Level: ignoring key beyond the ${KEY_MAX}-key limit`);
        return this;
      }
      this.keyCount++;
    }
    if (piece instanceof Ghost) {
      if (this.ghostCount >= GHOST_MAX) {
        console.warn(`Level: ignoring ghost block beyond the ${GHOST_MAX} limit`);
        return this;
      }
      this.ghostCount++;
    }
    this.pieces.push(piece);
    const k = Level.key(piece.x, piece.y);
    if (piece.solid) this.solidSet.add(k);
    if (piece.lethal) this.lethalSet.add(k);
    if (piece.goal) this.goalSet.add(k);
    if (piece instanceof Spring) this.springSet.add(k);
    return this;
  }

  /** All key pieces in placement order. */
  keyPieces(): Key[] {
    return this.pieces.filter((p): p is Key => p instanceof Key);
  }

  /** The exit door, if one has been placed. */
  exitPiece(): Exit | undefined {
    return this.pieces.find((p): p is Exit => p instanceof Exit);
  }

  /** All crumble blocks in placement order. */
  crumblePieces(): CrumbleBlock[] {
    return this.pieces.filter((p): p is CrumbleBlock => p instanceof CrumbleBlock);
  }

  /** All springs in placement order. */
  springPieces(): Spring[] {
    return this.pieces.filter((p): p is Spring => p instanceof Spring);
  }

  /** All defusal kits in placement order. */
  defuserPieces(): Defuser[] {
    return this.pieces.filter((p): p is Defuser => p instanceof Defuser);
  }

  /** All saw blades in placement order. */
  sawPieces(): Saw[] {
    return this.pieces.filter((p): p is Saw => p instanceof Saw);
  }

  /** All ghost blocks in placement order. */
  ghostPieces(): Ghost[] {
    return this.pieces.filter((p): p is Ghost => p instanceof Ghost);
  }

  /** Toggle a tile's solidity at runtime (used when a crumble block drops). */
  setSolid(x: number, y: number, solid: boolean): void {
    const k = Level.key(x, y);
    if (solid) this.solidSet.add(k);
    else this.solidSet.delete(k);
  }

  setSpawn(x: number, y: number): this {
    this.spawn = { x, y };
    return this;
  }

  isSolid(x: number, y: number): boolean {
    return this.solidSet.has(Level.key(x, y));
  }
  isLethal(x: number, y: number): boolean {
    return this.lethalSet.has(Level.key(x, y));
  }
  isGoal(x: number, y: number): boolean {
    return this.goalSet.has(Level.key(x, y));
  }
  isSpring(x: number, y: number): boolean {
    return this.springSet.has(Level.key(x, y));
  }

  /** Draw the static pieces (blocks, spikes) into one Graphics object.
   *  Dynamic pieces (keys, exit) are drawn separately by RaidScene so they
   *  can be hidden/recolored at runtime. */
  draw(g: Phaser.GameObjects.Graphics): void {
    for (const piece of this.pieces) if (!piece.dynamic) piece.draw(g);
  }

  // ---- Serialization (§5.5) ---------------------------------------------

  toJSON(): LevelData {
    return {
      spawn: this.spawn,
      timer: this.timer.enabled ? { ...this.timer } : undefined,
      grid: this.pieces.map((p) => p.toJSON()),
    };
  }

  static fromJSON(data: LevelData): Level {
    const level = new Level();
    level.setSpawn(data.spawn.x, data.spawn.y);
    if (data.timer) {
      level.timer = { enabled: !!data.timer.enabled, seconds: data.timer.seconds ?? 0 };
    }
    for (const g of data.grid) level.add(createPiece(g.type, g.x, g.y, g.dir, g.params));
    return level;
  }
}
