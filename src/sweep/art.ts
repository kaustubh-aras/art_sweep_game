import type { InkIndex } from './strokes';

/** A polyline in unit-circle space (-1..1), flat: [x, y, x, y, ...]. */
export interface ArtStroke {
  ink: InkIndex;
  pts: number[];
}

export type Glyph = ArtStroke[];

// ---- tiny path builders --------------------------------------------------

function pts(...v: number[]): number[] {
  return v;
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 20): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

function ring(cx: number, cy: number, r: number, n = 28): number[] {
  return arc(cx, cy, r, 0, 360, n);
}

function box(x0: number, y0: number, x1: number, y1: number): number[] {
  return pts(x0, y0, x1, y0, x1, y1, x0, y1, x0, y0);
}

const G = 0 as InkIndex; // phosphor green
const A = 1 as InkIndex; // amber
const W = 2 as InkIndex; // white

/**
 * Bold, low-detail vector drawings for the seeded community links.
 *
 * These are deliberately the kind of picture the sweep rewards (GDD §3): a
 * handful of strong shapes that survive being redrawn six times. They are fed
 * through `synth.ts`, which turns them into stroke recordings timed to chase
 * the hand — the same data a human drawer produces.
 */
export const ART: Record<string, Glyph> = {
  clock: [
    { ink: G, pts: ring(0, 0, 0.66) },
    { ink: G, pts: ring(0, 0, 0.58, 24) },
    { ink: W, pts: pts(0, 0, 0, -0.36) },
    { ink: A, pts: pts(0, 0, 0.42, 0.12) },
    { ink: W, pts: pts(0, -0.66, 0, -0.54) },
    { ink: W, pts: pts(0.66, 0, 0.54, 0) },
    { ink: W, pts: pts(0, 0.66, 0, 0.54) },
    { ink: W, pts: pts(-0.66, 0, -0.54, 0) },
  ],

  alarm: [
    { ink: G, pts: ring(0, 0.08, 0.52) },
    { ink: G, pts: arc(-0.38, -0.34, 0.2, 120, 350) },
    { ink: G, pts: arc(0.38, -0.34, 0.2, 190, 60) },
    { ink: G, pts: pts(-0.34, -0.2, -0.2, -0.06) },
    { ink: G, pts: pts(0.34, -0.2, 0.2, -0.06) },
    { ink: W, pts: pts(0, 0.08, 0, -0.2) },
    { ink: A, pts: pts(0, 0.08, 0.3, 0.26) },
    { ink: G, pts: pts(-0.32, 0.5, -0.5, 0.72) },
    { ink: G, pts: pts(0.32, 0.5, 0.5, 0.72) },
  ],

  candle: [
    { ink: W, pts: box(-0.2, -0.1, 0.2, 0.66) },
    { ink: W, pts: pts(-0.2, -0.1, -0.1, -0.02, 0.02, -0.12, 0.12, -0.02, 0.2, -0.1) },
    { ink: A, pts: pts(0, -0.1, 0, -0.24) },
    { ink: A, pts: pts(0, -0.24, -0.13, -0.42, 0, -0.66, 0.13, -0.42, 0, -0.24) },
    { ink: A, pts: pts(0, -0.3, -0.05, -0.42, 0, -0.52) },
    { ink: W, pts: pts(-0.2, 0.16, -0.28, 0.3, -0.2, 0.4) },
    { ink: G, pts: pts(-0.44, 0.7, 0.44, 0.7) },
  ],

  sunrise: [
    { ink: G, pts: pts(-0.82, 0.3, 0.82, 0.3) },
    { ink: A, pts: arc(0, 0.3, 0.34, 180, 360) },
    { ink: A, pts: pts(0, -0.16, 0, -0.42) },
    { ink: A, pts: pts(-0.34, -0.06, -0.54, -0.28) },
    { ink: A, pts: pts(0.34, -0.06, 0.54, -0.28) },
    { ink: A, pts: pts(-0.48, 0.16, -0.72, 0.06) },
    { ink: A, pts: pts(0.48, 0.16, 0.72, 0.06) },
    { ink: G, pts: pts(-0.6, 0.52, -0.1, 0.52) },
    { ink: G, pts: pts(0.14, 0.66, 0.66, 0.66) },
  ],

  sunset: [
    { ink: G, pts: pts(-0.82, 0.16, 0.82, 0.16) },
    { ink: A, pts: arc(0, 0.16, 0.36, 180, 360) },
    { ink: A, pts: pts(-0.62, 0.4, 0.62, 0.4) },
    { ink: A, pts: pts(-0.5, 0.56, 0.5, 0.56) },
    { ink: A, pts: pts(-0.3, 0.72, 0.3, 0.72) },
    { ink: W, pts: pts(-0.7, -0.2, -0.7, -0.44) },
    { ink: W, pts: pts(0.7, -0.2, 0.7, -0.44) },
  ],

  moon: [
    { ink: W, pts: arc(0.1, 0, 0.66, 40, 320, 26) },
    { ink: W, pts: arc(-0.26, 0, 0.72, 46, 314, 26) },
    { ink: A, pts: pts(0.42, -0.56, 0.5, -0.56) },
    { ink: A, pts: pts(0.46, -0.6, 0.46, -0.52) },
    { ink: A, pts: pts(-0.5, 0.5, -0.42, 0.5) },
    { ink: A, pts: pts(-0.46, 0.54, -0.46, 0.46) },
  ],

  calendar: [
    { ink: G, pts: box(-0.6, -0.4, 0.6, 0.6) },
    { ink: G, pts: pts(-0.6, -0.14, 0.6, -0.14) },
    { ink: W, pts: pts(-0.3, -0.4, -0.3, -0.6) },
    { ink: W, pts: pts(0.3, -0.4, 0.3, -0.6) },
    { ink: A, pts: pts(-0.6, 0.12, 0.6, 0.12) },
    { ink: A, pts: pts(-0.6, 0.38, 0.6, 0.38) },
    { ink: A, pts: pts(-0.2, -0.14, -0.2, 0.6) },
    { ink: A, pts: pts(0.2, -0.14, 0.2, 0.6) },
    { ink: W, pts: ring(0.4, 0.25, 0.11, 16) },
  ],

  hourglass: [
    { ink: G, pts: pts(-0.46, -0.62, 0.46, -0.62) },
    { ink: G, pts: pts(-0.46, 0.62, 0.46, 0.62) },
    { ink: W, pts: pts(-0.38, -0.56, 0.38, -0.56, 0, 0, -0.38, -0.56) },
    { ink: W, pts: pts(-0.38, 0.56, 0.38, 0.56, 0, 0, -0.38, 0.56) },
    { ink: A, pts: pts(0, -0.04, 0, 0.34) },
    { ink: A, pts: pts(-0.22, 0.56, 0.22, 0.56, 0, 0.3, -0.22, 0.56) },
    { ink: A, pts: pts(-0.3, -0.42, 0.3, -0.42) },
    { ink: G, pts: pts(-0.46, -0.62, -0.46, -0.52) },
    { ink: G, pts: pts(0.46, 0.62, 0.46, 0.52) },
  ],

  stopwatch: [
    { ink: G, pts: ring(0, 0.1, 0.58) },
    { ink: G, pts: ring(0, 0.1, 0.5, 24) },
    { ink: W, pts: box(-0.12, -0.62, 0.12, -0.46) },
    { ink: W, pts: pts(-0.12, -0.46, 0.12, -0.46) },
    { ink: W, pts: pts(-0.44, -0.36, -0.28, -0.2) },
    { ink: A, pts: pts(0, 0.1, 0.3, -0.22) },
    { ink: W, pts: pts(0, -0.4, 0, -0.3) },
    { ink: W, pts: pts(0.58, 0.1, 0.48, 0.1) },
  ],

  snooze: [
    { ink: G, pts: pts(-0.72, 0.5, -0.72, 0.06, -0.5, 0.06) },
    { ink: G, pts: pts(-0.72, 0.24, 0.6, 0.24, 0.6, 0.5) },
    { ink: G, pts: pts(-0.72, 0.5, 0.6, 0.5) },
    { ink: W, pts: pts(-0.58, 0.24, -0.58, 0.1, -0.3, 0.1, -0.3, 0.24) },
    { ink: A, pts: pts(-0.06, -0.14, 0.16, -0.14, -0.06, 0.08, 0.16, 0.08) },
    { ink: A, pts: pts(0.24, -0.44, 0.44, -0.44, 0.24, -0.24, 0.44, -0.24) },
    { ink: A, pts: pts(0.5, -0.7, 0.66, -0.7, 0.5, -0.54, 0.66, -0.54) },
  ],

  eclipse: [
    { ink: A, pts: ring(0, 0, 0.44) },
    { ink: W, pts: ring(-0.16, -0.06, 0.44) },
    { ink: A, pts: pts(0, -0.56, 0, -0.78) },
    { ink: A, pts: pts(0.42, -0.42, 0.6, -0.6) },
    { ink: A, pts: pts(0.56, 0, 0.8, 0) },
    { ink: A, pts: pts(0.42, 0.42, 0.6, 0.6) },
    { ink: A, pts: pts(0, 0.56, 0, 0.78) },
    { ink: A, pts: pts(-0.42, 0.42, -0.6, 0.6) },
  ],

  lighthouse: [
    { ink: W, pts: pts(-0.22, 0.66, -0.12, -0.2, 0.12, -0.2, 0.22, 0.66) },
    { ink: W, pts: pts(-0.22, 0.66, 0.22, 0.66) },
    { ink: G, pts: box(-0.16, -0.36, 0.16, -0.2) },
    { ink: G, pts: pts(-0.2, -0.36, 0.2, -0.36) },
    { ink: G, pts: pts(-0.14, -0.5, 0, -0.36, 0.14, -0.5) },
    { ink: A, pts: pts(-0.2, -0.32, -0.72, -0.5) },
    { ink: A, pts: pts(-0.2, -0.24, -0.74, -0.14) },
    { ink: A, pts: pts(0.2, -0.32, 0.72, -0.5) },
    { ink: A, pts: pts(0.2, -0.24, 0.74, -0.14) },
    { ink: G, pts: pts(-0.78, 0.72, -0.5, 0.62, -0.24, 0.72) },
    { ink: G, pts: pts(0.26, 0.72, 0.52, 0.62, 0.78, 0.72) },
  ],

  metronome: [
    { ink: G, pts: pts(-0.4, 0.62, -0.12, -0.6, 0.12, -0.6, 0.4, 0.62, -0.4, 0.62) },
    { ink: G, pts: pts(-0.3, 0.24, 0.3, 0.24) },
    { ink: W, pts: pts(0, 0.56, 0.16, -0.5) },
    { ink: A, pts: box(-0.08, 0.02, 0.1, 0.16) },
    { ink: A, pts: arc(0, 0.56, 0.62, -78, -46, 8) },
    { ink: W, pts: pts(-0.16, -0.5, 0.16, -0.5) },
  ],

  sundial: [
    { ink: G, pts: arc(0, 0.34, 0.66, 180, 360) },
    { ink: G, pts: pts(-0.66, 0.34, 0.66, 0.34) },
    { ink: W, pts: pts(-0.1, 0.34, 0.1, 0.34, 0.1, -0.3, -0.1, 0.34) },
    { ink: A, pts: pts(0.1, 0.32, 0.56, 0.1) },
    { ink: G, pts: pts(-0.56, 0.1, -0.62, 0.02) },
    { ink: G, pts: pts(-0.34, -0.1, -0.38, -0.2) },
    { ink: G, pts: pts(0, -0.16, 0, -0.28) },
    { ink: G, pts: pts(0.34, -0.1, 0.38, -0.2) },
    { ink: G, pts: pts(0.56, 0.1, 0.62, 0.02) },
  ],

  pendulum: [
    { ink: G, pts: pts(-0.34, -0.66, 0.34, -0.66) },
    { ink: G, pts: pts(-0.34, -0.66, -0.34, 0.7) },
    { ink: G, pts: pts(0.34, -0.66, 0.34, 0.7) },
    { ink: G, pts: pts(-0.34, 0.7, 0.34, 0.7) },
    { ink: W, pts: pts(0, -0.62, 0.22, 0.38) },
    { ink: A, pts: ring(0.24, 0.46, 0.16, 18) },
    { ink: A, pts: arc(0, -0.62, 1.12, 62, 80, 8) },
    { ink: W, pts: ring(0, -0.62, 0.04, 10) },
  ],
};

export function hasArt(word: string): boolean {
  return word in ART;
}

export const ART_WORDS = Object.keys(ART);
