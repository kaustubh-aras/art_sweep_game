import { describe, expect, it } from 'vitest';
import { ARENA_COUNT, arenaIndexAt } from '../src/shared/config';
import { ARENAS, arenaAt, buildLayout, rng } from '../src/clockshot/arena';
import { GRAPPLE } from '../src/clockshot/tuning';

/**
 * The arena layer is pure data plus one pure function, which makes the things
 * that would actually ruin a run — an unreachable spawn, a pit with no rope
 * over it, a layout that changes under the player — cheap to assert.
 */

describe('arena selection', () => {
  it('is a pure function of the round index', () => {
    for (const round of [0, 1, 7, 100, 2_979_171]) {
      expect(arenaIndexAt(round)).toBe(arenaIndexAt(round));
    }
  });

  it('always lands inside the shipped set', () => {
    for (let r = 0; r < 500; r++) {
      const i = arenaIndexAt(r);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(ARENA_COUNT);
    }
  });

  it('does not simply cycle 0, 1, 2', () => {
    const first = [0, 1, 2, 3, 4, 5].map(arenaIndexAt);
    expect(first).not.toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('uses every arena over a day of rounds', () => {
    // 144 rounds is 24h at ROUND_MS. Every arena should show up in that.
    const seen = new Set(Array.from({ length: 144 }, (_, r) => arenaIndexAt(r)));
    expect(seen.size).toBe(ARENA_COUNT);
  });

  it('ships exactly the number of arenas the server thinks it does', () => {
    expect(ARENAS.length).toBe(ARENA_COUNT);
  });

  it('survives a nonsense index rather than crashing a run', () => {
    expect(arenaAt(-1)).toBeTruthy();
    expect(arenaAt(999)).toBeTruthy();
    expect(arenaAt(NaN)).toBe(ARENAS[0]);
  });
});

describe('every arena is playable', () => {
  for (const arena of ARENAS) {
    describe(arena.name, () => {
      it('spawns the player above solid ground', () => {
        const under = arena.platforms.some(
          (p) =>
            arena.spawn.x >= p.x &&
            arena.spawn.x <= p.x + p.w &&
            p.y >= arena.spawn.y &&
            p.y - arena.spawn.y < 200,
        );
        expect(under).toBe(true);
      });

      it('does not spawn the player inside a spike strip', () => {
        const inSpikes = arena.hazards.some(
          (h) =>
            arena.spawn.x >= h.x - 20 &&
            arena.spawn.x <= h.x + h.w + 20 &&
            Math.abs(h.y - arena.spawn.y) < 80,
        );
        expect(inSpikes).toBe(false);
      });

      it('puts an anchor in reach of the spawn, above the player', () => {
        // Without this the grapple is unusable until the player has already
        // climbed something, which is exactly backwards for the one mechanic
        // the whole game is built on.
        const reachable = arena.anchors.filter((a) => {
          if (a.y > arena.spawn.y - 30) return false;
          return Math.hypot(a.x - arena.spawn.x, a.y - arena.spawn.y) <= GRAPPLE.range;
        });
        expect(reachable.length).toBeGreaterThan(0);
      });

      it('puts an anchor in reach of every respawn', () => {
        for (const r of arena.respawns) {
          const reachable = arena.anchors.some(
            (a) => a.y <= r.y - 30 && Math.hypot(a.x - r.x, a.y - r.y) <= GRAPPLE.range,
          );
          expect(reachable, `respawn ${r.x},${r.y} has no rope`).toBe(true);
        }
      });

      it('keeps every anchor inside the world', () => {
        for (const a of arena.anchors) {
          expect(a.x).toBeGreaterThanOrEqual(0);
          expect(a.x).toBeLessThanOrEqual(arena.world.width);
          expect(a.y).toBeGreaterThanOrEqual(0);
          expect(a.y).toBeLessThanOrEqual(arena.world.height);
        }
      });

      it('leaves no anchor stranded out of reach of the whole arena', () => {
        // Reachability, not a ladder: the player grabs an anchor either from
        // somewhere they can stand, or while already hanging from another one.
        // An earlier version of this test assumed a strictly vertical chain and
        // failed the horizontal low rows, which are reached from the ground.
        const standable: { x: number; y: number }[] = [arena.spawn, ...arena.respawns];
        for (const p of arena.platforms) {
          for (let x = p.x; x <= p.x + p.w; x += 40) standable.push({ x, y: p.y - 20 });
        }

        const inRange = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
          Math.hypot(a.x - b.x, a.y - b.y) <= GRAPPLE.range;

        // Seed with everything grabbable from a standing start (must be above).
        const reached = new Set<number>();
        arena.anchors.forEach((a, i) => {
          if (standable.some((s) => a.y <= s.y - 30 && inRange(a, s))) reached.add(i);
        });
        expect(reached.size, `${arena.id}: nothing grabbable from the ground`).toBeGreaterThan(0);

        // Then spread: hanging from a reached anchor puts the next in range.
        for (let changed = true; changed; ) {
          changed = false;
          arena.anchors.forEach((a, i) => {
            if (reached.has(i)) return;
            for (const j of reached) {
              if (inRange(a, arena.anchors[j]!)) {
                reached.add(i);
                changed = true;
                return;
              }
            }
          });
        }

        const stranded = arena.anchors
          .map((a, i) => (reached.has(i) ? null : `${a.x},${a.y}`))
          .filter(Boolean);
        expect(stranded, `${arena.id}: unreachable anchors`).toEqual([]);
      });

      it('keeps hazards resting on something solid', () => {
        for (const h of arena.hazards) {
          const onPlatform = arena.platforms.some(
            (p) => Math.abs(p.y - (h.y + h.h)) < 2 && h.x >= p.x - 1 && h.x + h.w <= p.x + p.w + 1,
          );
          expect(onPlatform, `hazard at ${h.x},${h.y} floats`).toBe(true);
        }
      });

      it('offers somewhere to put the golden clock', () => {
        expect(arena.golden.length).toBeGreaterThan(0);
      });

      it('puts the goal a long way from the spawn', () => {
        // The run *is* the journey between these two points. A goal near the
        // spawn would make the whole arena optional.
        const d = Math.hypot(arena.goal.x - arena.spawn.x, arena.goal.y - arena.spawn.y);
        expect(d).toBeGreaterThan(900);
      });

      it('keeps the goal inside the world and off the spikes', () => {
        expect(arena.goal.x).toBeGreaterThanOrEqual(0);
        expect(arena.goal.x).toBeLessThanOrEqual(arena.world.width);
        expect(arena.goal.y).toBeGreaterThanOrEqual(0);
        expect(arena.goal.y).toBeLessThanOrEqual(arena.world.height);
        const inSpikes = arena.hazards.some(
          (h) =>
            arena.goal.x >= h.x - 40 &&
            arena.goal.x <= h.x + h.w + 40 &&
            Math.abs(h.y - arena.goal.y) < 80,
        );
        expect(inSpikes).toBe(false);
      });

      it('lays checkpoints between the spawn and the goal', () => {
        expect(arena.checkpoints.length).toBeGreaterThan(0);
        const toGoal = Math.hypot(
          arena.goal.x - arena.spawn.x,
          arena.goal.y - arena.spawn.y,
        );
        for (const c of arena.checkpoints) {
          // A checkpoint behind the spawn or past the goal is not a safety net.
          const fromSpawn = Math.hypot(c.x - arena.spawn.x, c.y - arena.spawn.y);
          expect(fromSpawn, `checkpoint ${c.x},${c.y} is on top of the spawn`).toBeGreaterThan(200);
          expect(fromSpawn, `checkpoint ${c.x},${c.y} is past the goal`).toBeLessThan(toGoal + 400);
        }
      });

      it('never puts a checkpoint inside a spike strip', () => {
        // Restarting into a hazard would take the clock straight back off you.
        for (const c of arena.checkpoints) {
          const inSpikes = arena.hazards.some(
            (h) => c.x >= h.x - 30 && c.x <= h.x + h.w + 30 && Math.abs(h.y - c.y) < 70,
          );
          expect(inSpikes, `checkpoint ${c.x},${c.y} sits in spikes`).toBe(false);
        }
      });

      it('puts an anchor within reach of every checkpoint', () => {
        // You restart standing here, so the rope has to be usable from it.
        for (const c of arena.checkpoints) {
          const reachable = arena.anchors.some(
            (a) => a.y <= c.y - 30 && Math.hypot(a.x - c.x, a.y - c.y) <= GRAPPLE.range,
          );
          expect(reachable, `checkpoint ${c.x},${c.y} has no rope`).toBe(true);
        }
      });

      it('puts an anchor within reach of the goal', () => {
        // You have to be able to *arrive*. A goal with no rope near it can only
        // be reached by a lucky fall.
        const reachable = arena.anchors.some(
          (a) => Math.hypot(a.x - arena.goal.x, a.y - arena.goal.y) <= GRAPPLE.range,
        );
        expect(reachable).toBe(true);
      });
    });
  }
});

describe('seeded layout', () => {
  it('rebuilds identically from the same seed', () => {
    // This is what lets a player refresh mid-run and find the same arena.
    for (const arena of ARENAS) {
      const a = buildLayout(arena, 12345);
      const b = buildLayout(arena, 12345);
      expect(a).toEqual(b);
    }
  });

  it('varies between seeds', () => {
    const a = buildLayout(ARENAS[0]!, 1);
    const b = buildLayout(ARENAS[0]!, 999_999);
    expect(a).not.toEqual(b);
  });

  it('always places exactly one golden clock', () => {
    for (const arena of ARENAS) {
      for (const seed of [1, 2, 3, 77, 1234, 999_999]) {
        const { pickups } = buildLayout(arena, seed);
        expect(pickups.filter((p) => p.kind === 'golden').length).toBe(1);
      }
    }
  });

  it('never exceeds the caps the server validates against', () => {
    // If a legitimate run could out-collect RUN_CAPS, an honest player would be
    // silently marked as adjusted.
    for (const arena of ARENAS) {
      for (const seed of [1, 42, 1234, 999_999]) {
        const { pickups } = buildLayout(arena, seed);
        expect(pickups.filter((p) => p.kind === 'clock').length).toBeLessThanOrEqual(80);
        expect(pickups.filter((p) => p.kind === 'golden').length).toBeLessThanOrEqual(6);
      }
    }
  });

  it('does not drop a pickup on top of a spike strip', () => {
    for (const arena of ARENAS) {
      for (const seed of [1, 42, 1234]) {
        const { pickups } = buildLayout(arena, seed);
        for (const p of pickups) {
          const inSpikes = arena.hazards.some(
            (h) => p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y - 24 && p.y <= h.y + h.h,
          );
          expect(inSpikes, `${arena.id}: pickup at ${p.x},${p.y} sits in spikes`).toBe(false);
        }
      }
    }
  });
});

describe('rng', () => {
  it('is deterministic and stays in [0, 1)', () => {
    const a = rng(7);
    const b = rng(7);
    for (let i = 0; i < 200; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('does not collapse on a zero seed', () => {
    const r = rng(0);
    const vals = new Set(Array.from({ length: 20 }, () => r()));
    expect(vals.size).toBeGreaterThan(15);
  });
});
