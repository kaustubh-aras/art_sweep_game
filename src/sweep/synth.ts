import { ART, type Glyph } from './art';
import { angleOf } from './clock';
import { SWEEP_PERIOD, DRAW_SWEEPS, MAX_STROKE_POINTS } from './tuning';
import { clampToCircle, toQuant, type Recording, type Stroke } from './strokes';

/** Deterministic RNG so a link always replays identically for everyone. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Max unit-space length of one resampled segment. */
const STEP = 0.055;
/** How far behind the hand the synthetic drawer lays ink down (ms). */
const LAG = 130;

/** Walk a polyline and emit evenly spaced points along it. */
function resample(pts: number[]): number[] {
  const out: number[] = [];
  if (pts.length < 4) return pts.slice();
  out.push(pts[0], pts[1]);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i];
    const y0 = pts[i + 1];
    const x1 = pts[i + 2];
    const y1 = pts[i + 3];
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(d / STEP));
    for (let k = 1; k <= n; k++) {
      out.push(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
    }
  }
  return out;
}

/**
 * Turn a vector glyph into a stroke recording that plays the sweep the way a
 * good drawer does (GDD §3): every segment is laid down just *after* the hand
 * passes its angle, so it survives almost a full rotation, and the whole
 * picture is re-traced once per sweep.
 *
 * The result is ordinary `[x, y, t]` stroke data — indistinguishable in the
 * replayer from something a human thumb produced.
 */
export function synthesize(glyph: Glyph, seed: number, sweeps = DRAW_SWEEPS): Recording {
  const rand = mulberry32(seed);
  const strokes: Stroke[] = [];
  let budget = MAX_STROKE_POINTS;

  const resampled = glyph.map((s) => ({ ink: s.ink, pts: resample(s.pts) }));

  for (let pass = 0; pass < sweeps && budget > 2; pass++) {
    // A human drawer wobbles and does not re-trace everything on every pass.
    const wobbleX = (rand() - 0.5) * 0.026;
    const wobbleY = (rand() - 0.5) * 0.026;

    for (const src of resampled) {
      if (pass >= 2 && rand() < 0.14) continue; // skipped this time round
      const p = src.pts;
      for (let i = 0; i + 3 < p.length && budget > 2; i += 2) {
        const jx = (rand() - 0.5) * 0.012;
        const jy = (rand() - 0.5) * 0.012;
        const a = clampToCircle(p[i] + wobbleX + jx, p[i + 1] + wobbleY + jy);
        const b = clampToCircle(p[i + 2] + wobbleX + jx, p[i + 3] + wobbleY + jy);

        // Time this segment to the moment the hand clears its midpoint.
        const midDeg = angleOf((a.x + b.x) / 2, (a.y + b.y) / 2);
        const t = pass * SWEEP_PERIOD + (midDeg / 360) * SWEEP_PERIOD + LAG;

        strokes.push({
          ink: src.ink,
          pts: [toQuant(a.x), toQuant(a.y), Math.round(t), toQuant(b.x), toQuant(b.y), Math.round(t)],
        });
        budget -= 2;
      }
    }
  }

  return { length: sweeps * SWEEP_PERIOD, strokes };
}

/** Synthesize the community drawing for a word, or `null` if we have no art. */
export function synthesizeWord(word: string, seed: number, sweeps = DRAW_SWEEPS): Recording | null {
  const glyph = ART[word];
  if (!glyph) return null;
  return synthesize(glyph, seed, sweeps);
}

export function hasGlyph(word: string): boolean {
  return word in ART;
}
