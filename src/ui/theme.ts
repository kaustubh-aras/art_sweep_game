/**
 * SWEEP design tokens (GDD §8) — radar phosphor.
 *
 * One palette for every screen: near-black navy field, thin ring grid, a green
 * hand, and three inks that stay distinguishable for colourblind players
 * (green / amber / white differ in luminance as well as hue).
 */
export const T = {
  // Field
  bg: 0x04070d,
  field: 0x081019,
  fieldEdge: 0x0d2b22,
  ring: 0x123528,
  ringBright: 0x1a5340,
  tick: 0x2a7a5c,

  // The hand
  hand: 0x3dffa0,
  handCore: 0xd8ffe9,
  wedge: 0x3dffa0,

  // Inks (§6)
  ink: [0x3dffa0, 0xffb020, 0xe8f2ff] as const,

  // Signal colours
  gold: 0xffd24a,
  warn: 0xff4d5e,
  cool: 0x6ee7ff,
  violet: 0xb14aff,

  // Surfaces
  panel: 0x0a141f,
  panelEdge: 0x143142,
  key: 0x122334,
  keyDown: 0x1d4a5e,
  keyEdge: 0x1c4356,
} as const;

/** Hex strings for Phaser text styles. */
export const TX = {
  text: '#dfe9f5',
  dim: '#7d93a8',
  faint: '#4d6274',
  green: '#3dffa0',
  amber: '#ffb020',
  gold: '#ffd24a',
  warn: '#ff4d5e',
  white: '#ffffff',
} as const;

/** Monospace everywhere: it is the radar-readout voice, ships with every OS,
 *  and keeps the letter-pattern row perfectly aligned. */
export const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const INK_NAMES = ['GREEN', 'AMBER', 'WHITE'] as const;

/** `0x3dffa0` -> `'#3dffa0'` for text styles and CSS. */
export function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}
