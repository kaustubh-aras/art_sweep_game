import type { Team } from '../shared/config';

/**
 * Clockshot's visual identity: a dark instrument panel, two team signals, and
 * gold for time itself. Every colour the game draws comes from here so the
 * whole thing reads as one object rather than a pile of separate scenes.
 */

export const C = {
  /** Deep navy, almost black — the arena void. */
  bg: 0x070b16,
  panel: 0x0d1426,
  panelEdge: 0x1d2a44,
  grid: 0x121c33,

  ink: 0xe6edf8,
  dim: 0x8497b5,
  faint: 0x475777,

  red: 0xff3b5c,
  redDeep: 0x7a1428,
  blue: 0x2fa3ff,
  blueDeep: 0x0d3f6b,

  /** Time itself. Collectibles, the run clock, anything that counts. */
  gold: 0xffc63d,
  goldDeep: 0x6d4d00,

  /** The grapple rope and anchors. */
  cyan: 0x3df0ff,
  cyanDeep: 0x0d5a66,

  danger: 0xff5a3d,
  good: 0x3dffa0,

  platform: 0x27395c,
  platformTop: 0x3a557f,
} as const;

export const CSS = {
  bg: '#070b16',
  ink: '#e6edf8',
  dim: '#8497b5',
  gold: '#ffc63d',
  cyan: '#3df0ff',
  red: '#ff3b5c',
  blue: '#2fa3ff',
} as const;

export const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Hex string form, for Phaser text styles which take CSS colours. */
export function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

export function teamColor(team: Team): number {
  return team === 'red' ? C.red : C.blue;
}

export function teamDeep(team: Team): number {
  return team === 'red' ? C.redDeep : C.blueDeep;
}

export function teamName(team: Team): string {
  return team === 'red' ? 'RED' : 'BLUE';
}
