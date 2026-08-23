import { COLS, ROWS } from './constants';
import { PIECE_REGISTRY, type EditorPieceType } from './pieceRegistry';
import type { LevelData, PieceData } from './level';
import type { Dir4, Dir8, PieceType } from './pieces';

/** The editor's single source of truth (spec contract). */
export interface StructPiece {
  x: number;
  y: number;
  type: EditorPieceType;
  params?: {
    face?: Dir4; // spike mount / dart direction
    path?: [[number, number], [number, number]]; // saw patrol line
    speed?: number; // saw tiles/sec
    interval?: number; // dart seconds
    linkId?: string; // plate <-> door
    mode?: 'hold' | 'toggle';
    dir?: Dir8; // spring (8-way) / magnet
    strength?: number;
  };
}

export interface LevelStruct {
  meta: {
    author: string;
    title: string;
    canvas: 'classic';
    budgetUsed: number;
    verifiedTime: number | null;
  };
  grid: StructPiece[];
  spawn: { x: number; y: number };
  exit: { x: number; y: number } | null;
}

export function emptyStruct(author: string): LevelStruct {
  return {
    meta: { author, title: 'Untitled', canvas: 'classic', budgetUsed: 0, verifiedTime: null },
    grid: [],
    spawn: { x: 1, y: ROWS - 2 },
    exit: null,
  };
}

export function cloneStruct(s: LevelStruct): LevelStruct {
  return {
    meta: { ...s.meta },
    grid: s.grid.map((p) => ({ x: p.x, y: p.y, type: p.type, params: p.params ? { ...p.params } : undefined })),
    spawn: { ...s.spawn },
    exit: s.exit ? { ...s.exit } : null,
  };
}

/** Recompute budget from the registry — never trust a UI-supplied number. */
export function computeBudget(s: LevelStruct): number {
  return s.grid.reduce((sum, p) => sum + PIECE_REGISTRY[p.type].cost, 0);
}

export function countType(s: LevelStruct, type: EditorPieceType): number {
  return s.grid.reduce((n, p) => n + (p.type === type ? 1 : 0), 0);
}

export function pieceAt(s: LevelStruct, x: number, y: number): StructPiece | undefined {
  return s.grid.find((p) => p.x === x && p.y === y);
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < COLS && y >= 0 && y < ROWS;
}

/** Publish-gate validation (client side; the server re-validates too). */
export function validate(s: LevelStruct): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!s.exit) errors.push('Place an exit');
  if (s.meta.title.trim().length < 1 || s.meta.title.length > 32) errors.push('Title must be 1–32 chars');
  if (computeBudget(s) > 100) errors.push('Over budget');
  for (const type of Object.keys(PIECE_REGISTRY) as EditorPieceType[]) {
    const cap = PIECE_REGISTRY[type].cap;
    if (cap != null && countType(s, type) > cap) errors.push(`Too many ${type} (max ${cap})`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Convert the editor struct into the LevelData that RaidScene loads. Maps the
 * spec's `params` shape onto our piece model (face/dir -> dir, saw path/speed).
 * Locked/unsimulated types are skipped defensively.
 */
export function toLevelData(s: LevelStruct): LevelData {
  const SIMULATABLE: EditorPieceType[] = ['block', 'spike', 'crumble', 'spring', 'saw', 'ghost', 'key', 'defuser'];
  const grid: PieceData[] = [];

  for (const p of s.grid) {
    if (!SIMULATABLE.includes(p.type)) continue;
    const out: PieceData = { type: p.type as PieceType, x: p.x, y: p.y };
    if (p.type === 'spike' && p.params?.face) out.dir = p.params.face;
    if (p.type === 'spring' && p.params?.dir) out.dir = p.params.dir;
    if (p.type === 'saw') {
      out.params = { path: p.params?.path ?? [[p.x, p.y], [p.x, p.y]], speed: p.params?.speed ?? 3 };
    }
    if (p.type === 'ghost') out.params = { spike: false };
    grid.push(out);
  }

  if (s.exit) grid.push({ type: 'exit' as PieceType, x: s.exit.x, y: s.exit.y });

  return {
    meta: { title: s.meta.title, canvas: 'classic' },
    spawn: { ...s.spawn },
    grid,
  };
}
