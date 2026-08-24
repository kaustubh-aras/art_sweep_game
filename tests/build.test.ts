import { describe, expect, it } from 'vitest';
import {
  BUDGET_TOTAL,
  CELL,
  COLS,
  PIECES,
  ROWS,
  WORLD,
  budgetOf,
  cloneLevel,
  countKind,
  reviveLevel,
  starterLevel,
  toArena,
  validate,
  type BuildLevel,
  type BuildPiece,
} from '../src/clockshot/build';
import { buildLayout, killYOf } from '../src/clockshot/arena';

/**
 * The editor's grid is a format nobody plays: `toArena` is what turns it into
 * one. Everything a built level could get wrong that the player would feel —
 * a floor with seams in it, a patrol walking off its ledge, a layout the run
 * loop cannot load — is decided by the pure functions asserted here.
 */

function level(pieces: BuildPiece[], over: Partial<BuildLevel> = {}): BuildLevel {
  return {
    v: 1,
    id: 'lvl_test',
    name: 'TEST',
    spawn: { x: 1, y: 10 },
    goal: { x: 20, y: 10 },
    pieces,
    updatedAt: 0,
    verifiedMs: null,
    ...over,
  };
}

const floor = (y: number, x0: number, x1: number): BuildPiece[] =>
  Array.from({ length: x1 - x0 + 1 }, (_, i) => ({ x: x0 + i, y, kind: 'block' as const }));

describe('the starter level', () => {
  it('is something a new builder can immediately play', () => {
    expect(validate(starterLevel())).toBeNull();
  });

  it('leaves room to build on top of it', () => {
    expect(budgetOf(starterLevel())).toBeLessThan(BUDGET_TOTAL / 2);
  });

  it('has a different id every time, so two are two levels', () => {
    expect(starterLevel().id).not.toBe(starterLevel().id);
  });
});

describe('grid to arena', () => {
  it('merges a run of blocks into one platform rather than a row of seams', () => {
    const arena = toArena(level(floor(20, 3, 9)));
    expect(arena.platforms).toHaveLength(1);
    expect(arena.platforms[0]).toEqual({ x: 3 * CELL, y: 20 * CELL, w: 7 * CELL, h: CELL });
  });

  it('keeps a gap in the floor as a gap', () => {
    const arena = toArena(level([...floor(20, 0, 3), ...floor(20, 8, 11)]));
    expect(arena.platforms).toHaveLength(2);
    expect(arena.platforms[0]!.x + arena.platforms[0]!.w).toBeLessThan(arena.platforms[1]!.x);
  });

  it('puts a spike strip on the floor of its cell, never filling it', () => {
    const arena = toArena(level([{ x: 4, y: 12, kind: 'spike' }]));
    const [strip] = arena.hazards;
    expect(strip).toBeDefined();
    expect(strip!.y + strip!.h).toBeCloseTo(13 * CELL);
    expect(strip!.h).toBeLessThan(CELL);
  });

  it('walks an enemy to the ends of the ledge it stands on, and no further', () => {
    const arena = toArena(
      level([...floor(15, 5, 9), { x: 7, y: 14, kind: 'enemy' }]),
    );
    const [patrol] = arena.patrols;
    expect(patrol).toBeDefined();
    expect(patrol!.from).toBeCloseTo(5.5 * CELL);
    expect(patrol!.to).toBeCloseTo(9.5 * CELL);
  });

  it('gives a floating enemy a beat to pace rather than a broken patrol', () => {
    const arena = toArena(level([{ x: 7, y: 3, kind: 'enemy' }]));
    const [patrol] = arena.patrols;
    expect(patrol!.from).toBeLessThan(patrol!.to);
  });

  it('always leaves somewhere to come back to after a fall', () => {
    // `PlayScene.onFall` reads respawns[0] without checking. An arena with none
    // would crash the moment anybody went over the edge.
    const arena = toArena(level(floor(20, 0, 4)));
    expect(arena.respawns.length).toBeGreaterThan(0);
    expect(arena.respawns[0]).toEqual(arena.spawn);
  });

  it('places every clock the builder placed, and no others', () => {
    const built = level([
      ...floor(20, 0, 4),
      { x: 2, y: 18, kind: 'clock' },
      { x: 3, y: 18, kind: 'clock' },
    ]);
    const layout = buildLayout(toArena(built), 1234);
    expect(layout.pickups.filter((p) => p.kind === 'clock')).toHaveLength(2);
  });

  it('loads a level with no golden clock instead of throwing', () => {
    const arena = toArena(level(floor(20, 0, 4)));
    expect(arena.golden).toHaveLength(0);
    expect(() => buildLayout(arena, 7)).not.toThrow();
    expect(buildLayout(arena, 7).pickups.some((p) => p.kind === 'golden')).toBe(false);
  });

  it('gives the same layout on every run of the same level', () => {
    const arena = toArena(starterLevel());
    expect(buildLayout(arena, 1)).toEqual(buildLayout(arena, 999));
  });

  it('keeps everything inside a world the run loop can bound', () => {
    const arena = toArena(level([...floor(ROWS - 1, 0, COLS - 1), { x: 0, y: 0, kind: 'anchor' }]));
    expect(arena.world).toEqual({ width: WORLD.width, height: WORLD.height });
    for (const p of arena.platforms) {
      expect(p.x + p.w).toBeLessThanOrEqual(WORLD.width);
      expect(p.y + p.h).toBeLessThanOrEqual(WORLD.height);
    }
    expect(killYOf(arena)).toBeGreaterThan(WORLD.height);
  });
});

describe('the budget', () => {
  it('charges what the palette says it charges', () => {
    const built = level([
      { x: 0, y: 0, kind: 'block' },
      { x: 1, y: 0, kind: 'anchor' },
      { x: 2, y: 0, kind: 'golden' },
    ]);
    expect(budgetOf(built)).toBe(PIECES.block.cost + PIECES.anchor.cost + PIECES.golden.cost);
  });

  it('counts by kind', () => {
    const built = level([...floor(20, 0, 5), { x: 2, y: 19, kind: 'clock' }]);
    expect(countKind(built, 'block')).toBe(6);
    expect(countKind(built, 'clock')).toBe(1);
  });
});

describe('validation', () => {
  it('refuses a level with nothing in it', () => {
    expect(validate(level([]))).not.toBeNull();
  });

  it('refuses a level with no ground', () => {
    expect(validate(level([{ x: 4, y: 4, kind: 'anchor' }]))).not.toBeNull();
  });

  it('refuses a spawn sitting on the goal', () => {
    const built = level(floor(20, 0, 4), { spawn: { x: 5, y: 5 }, goal: { x: 5, y: 5 } });
    expect(validate(built)).not.toBeNull();
  });

  it('refuses a level that has overrun the budget', () => {
    const pieces = Array.from({ length: BUDGET_TOTAL + 1 }, (_, i) => ({
      x: i % COLS,
      y: Math.floor(i / COLS),
      kind: 'block' as const,
    }));
    expect(validate(level(pieces))).toBe('Over budget');
  });
});

describe('reading storage back', () => {
  it('survives a round trip through JSON', () => {
    const built = starterLevel('KEEP ME');
    const back = reviveLevel(JSON.parse(JSON.stringify(built)) as unknown);
    expect(back).toEqual(built);
  });

  it('rejects anything that is not a level', () => {
    expect(reviveLevel(null)).toBeNull();
    expect(reviveLevel('hello')).toBeNull();
    expect(reviveLevel({ v: 2, id: 'x', name: 'y' })).toBeNull();
    expect(reviveLevel({ v: 1, id: 'x', name: 'y' })).toBeNull();
  });

  it('drops junk pieces instead of the whole level', () => {
    const back = reviveLevel({
      v: 1,
      id: 'x',
      name: 'y',
      spawn: { x: 1, y: 1 },
      goal: { x: 2, y: 2 },
      pieces: [{ x: 1, y: 1, kind: 'block' }, { x: 2, y: 2, kind: 'wormhole' }, 'nope'],
      updatedAt: 0,
      verifiedMs: null,
    });
    expect(back?.pieces).toEqual([{ x: 1, y: 1, kind: 'block' }]);
  });

  it('drags a piece from outside the grid back into it', () => {
    const back = reviveLevel({
      v: 1,
      id: 'x',
      name: 'y',
      spawn: { x: -5, y: 999 },
      goal: { x: 2, y: 2 },
      pieces: [{ x: COLS + 40, y: 3, kind: 'block' }],
      updatedAt: 0,
      verifiedMs: null,
    });
    expect(back?.spawn).toEqual({ x: 0, y: ROWS - 1 });
    expect(back?.pieces[0]).toEqual({ x: COLS - 1, y: 3, kind: 'block' });
  });

  it('clones deeply, so undo cannot be edited by the level it came from', () => {
    const built = starterLevel();
    const copy = cloneLevel(built);
    built.pieces.push({ x: 0, y: 0, kind: 'spike' });
    built.spawn.x = 99;
    expect(copy.pieces).toHaveLength(built.pieces.length - 1);
    expect(copy.spawn.x).not.toBe(99);
  });
});
