import { QUANT } from './tuning';

/** The three inks (GDD §6). Index into `INK_KEYS` / theme colours. */
export type InkIndex = 0 | 1 | 2;

/**
 * A recorded stroke. Points are stored flat as `[qx, qy, t, ...]`:
 *  - `qx`, `qy` are quantized 0..1000 across the unit circle's bounding box
 *  - `t` is ms from session start
 * This is exactly the payload shape the GDD's `/api/draw/submit` expects, so
 * the local chain store and a future server speak the same language.
 */
export interface Stroke {
  ink: InkIndex;
  pts: number[];
}

/** A complete drawing session: strokes plus how long the session ran. */
export interface Recording {
  /** ms; the replay loops on this length. */
  length: number;
  strokes: Stroke[];
}

/** Quantized (0..1000) -> unit circle space (-1..1). */
export function toUnit(q: number): number {
  return (q / QUANT) * 2 - 1;
}

/** Unit circle space (-1..1) -> quantized 0..1000, clamped. */
export function toQuant(u: number): number {
  const q = Math.round(((u + 1) / 2) * QUANT);
  return q < 0 ? 0 : q > QUANT ? QUANT : q;
}

/** Total recorded points across every stroke (the §6 5,000 cap applies here). */
export function pointCount(rec: Recording): number {
  let n = 0;
  for (const s of rec.strokes) n += s.pts.length / 3;
  return n;
}

/** A drawable piece of a stroke in unit space, with the time it was laid down. */
export interface InkPoint {
  x: number;
  y: number;
  t: number;
  ink: InkIndex;
  /** Index of the stroke this point belongs to — a break in this value is a pen-up. */
  stroke: number;
  /** Position within its stroke; keeps the time sort stable for co-timed points. */
  seq: number;
}

/** Flatten a recording into a time-sorted point list ready for replay. */
export function flatten(rec: Recording): InkPoint[] {
  const out: InkPoint[] = [];
  rec.strokes.forEach((s, si) => {
    for (let i = 0; i + 2 < s.pts.length; i += 3) {
      out.push({
        x: toUnit(s.pts[i]),
        y: toUnit(s.pts[i + 1]),
        t: s.pts[i + 2],
        ink: s.ink,
        stroke: si,
        seq: i / 3,
      });
    }
  });
  // Stable by construction: co-timed points keep stroke order, so a stroke
  // never has a foreign point spliced into the middle of it.
  out.sort((a, b) => a.t - b.t || a.stroke - b.stroke || a.seq - b.seq);
  return out;
}

/** Clamp a unit-space point back inside the circle (the GDD validates this
 *  server-side; we enforce it at capture time so bad data never exists). */
export function clampToCircle(x: number, y: number): { x: number; y: number } {
  const r = Math.hypot(x, y);
  if (r <= 1) return { x, y };
  return { x: x / r, y: y / r };
}
