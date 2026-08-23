import { dpr } from './viewport';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Frame {
  /** Canvas size in game units (RESIZE mode: 1 unit = 1 CSS px). */
  w: number;
  h: number;
  portrait: boolean;
  safe: Insets;
  /** Usable rectangle once display cutouts and home indicators are excluded. */
  x: number;
  y: number;
  iw: number;
  ih: number;
  /** UI scale factor. 1.0 is a typical phone; clamped so nothing gets tiny or silly. */
  ui: number;
  topBarH: number;
  clock: { cx: number; cy: number; r: number };
  /** Where the HUD, letter row and controls live. */
  panel: { x: number; y: number; w: number; h: number };
}

let probe: HTMLElement | null = null;

/**
 * Read the device's safe-area insets.
 *
 * `env(safe-area-inset-*)` is only readable from CSS, so a zero-size probe
 * element carries the values into JS. Notches, rounded corners, Android nav
 * bars and the iPhone home indicator all land here, and every screen lays out
 * inside the rectangle they leave behind.
 */
export function readInsets(): Insets {
  if (typeof document === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 };
  if (!probe) {
    probe = document.getElementById('safe-probe');
  }
  if (!probe) return { top: 0, right: 0, bottom: 0, left: 0 };
  const cs = getComputedStyle(probe);
  const n = (v: string): number => {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : 0;
  };
  // CSS pixels -> game units.
  const s = dpr();
  return {
    top: n(cs.paddingTop) * s,
    right: n(cs.paddingRight) * s,
    bottom: n(cs.paddingBottom) * s,
    left: n(cs.paddingLeft) * s,
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * The single source of truth for where everything goes.
 *
 * Portrait puts the dial on top with the controls underneath; landscape puts
 * the dial on the left with the controls beside it — the two layouts the GDD
 * §8 asks for. Nothing ever leaves the frame, so no screen can scroll.
 */
export function computeFrame(w: number, h: number): Frame {
  const raw = readInsets();
  const s = dpr();
  // A little breathing room everywhere, on top of the hardware insets.
  const pad = 8 * s;
  const safe: Insets = {
    top: raw.top + pad,
    right: raw.right + pad,
    bottom: raw.bottom + pad,
    left: raw.left + pad,
  };

  const x = safe.left;
  const y = safe.top;
  const iw = Math.max(120 * s, w - safe.left - safe.right);
  const ih = Math.max(160 * s, h - safe.top - safe.bottom);
  const portrait = ih >= iw;

  // "ui" folds in the device ratio, so "44 * ui" is always a comfortable
  // 44 CSS-pixel tap target no matter the screen density.
  const ui = clamp(Math.min(iw, ih) / (380 * s), 0.74, 1.45) * s;
  const topBarH = Math.round(clamp(42 * ui, 34 * s, 62 * s));

  let clock: Frame['clock'];
  let panel: Frame['panel'];

  if (portrait) {
    // Controls need room for the letter row, the points bar and 3 key rows.
    const wantPanel = clamp(196 * ui, 150 * s, ih * 0.5);
    const panelH = Math.min(wantPanel, Math.max(120 * s, ih - topBarH - 140 * s));
    const stageH = ih - topBarH - panelH;
    const r = Math.max(50 * s, Math.min(iw * 0.5, stageH * 0.5) - 6 * s);
    clock = { cx: x + iw / 2, cy: y + topBarH + stageH / 2, r };
    panel = { x, y: y + ih - panelH, w: iw, h: panelH };
  } else {
    const stageH = ih - topBarH;
    // Dial takes the left third-and-a-bit; controls get the rest.
    const r = Math.max(46 * s, Math.min(stageH * 0.5 - 4 * s, iw * 0.31));
    const cx = x + Math.max(r + 4 * s, iw * 0.26);
    clock = { cx, cy: y + topBarH + stageH / 2, r };
    const px = cx + r + Math.round(14 * ui);
    panel = { x: px, y: y + topBarH, w: Math.max(120 * s, x + iw - px), h: stageH };
  }

  return { w, h, portrait, safe, x, y, iw, ih, ui, topBarH, clock, panel };
}
