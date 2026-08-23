import { Colors } from './constants';

/** The full v1 piece vocabulary (GDD §5.4) plus our custom key/defuser. */
export type EditorPieceType =
  | 'block'
  | 'spike'
  | 'crumble'
  | 'coin'
  | 'saw'
  | 'dart'
  | 'spring'
  | 'plate'
  | 'door'
  | 'ghost'
  | 'magnet'
  | 'key'
  | 'defuser';

export interface PieceMeta {
  type: EditorPieceType;
  label: string;
  cost: number; // budget points (GDD §5.4)
  cap?: number; // max instances per level
  directional?: boolean; // has a face/dir the editor can cycle
  /** Not yet simulatable by RaidScene — greyed out in the palette so Test/Publish
   *  can never emit a piece the sim would choke on. */
  locked?: boolean;
  color: number; // palette icon tint
}

/**
 * THE source of budget costs and caps. The editor must read from here and never
 * hardcode a cost (spec requirement). Costs/caps are straight from GDD §5.4/§6.
 */
export const PIECE_REGISTRY: Record<EditorPieceType, PieceMeta> = {
  block: { type: 'block', label: 'Block', cost: 1, color: Colors.block },
  spike: { type: 'spike', label: 'Spike', cost: 3, directional: true, color: Colors.spike },
  crumble: { type: 'crumble', label: 'Crumble', cost: 4, color: Colors.crumble },
  coin: { type: 'coin', label: 'Coin', cost: 0, cap: 3, locked: true, color: Colors.coin },
  saw: { type: 'saw', label: 'Saw', cost: 6, color: Colors.saw },
  dart: { type: 'dart', label: 'Dart', cost: 5, directional: true, locked: true, color: 0xb0b6c0 },
  spring: { type: 'spring', label: 'Spring', cost: 3, directional: true, color: Colors.spring },
  plate: { type: 'plate', label: 'Plate', cost: 7, locked: true, color: 0x8ad0ff },
  door: { type: 'door', label: 'Door', cost: 0, locked: true, color: 0x8ad0ff },
  ghost: { type: 'ghost', label: 'Ghost', cost: 5, cap: 3, color: Colors.block },
  magnet: { type: 'magnet', label: 'Magnet', cost: 8, directional: true, locked: true, color: 0xc79bff },
  key: { type: 'key', label: 'Key', cost: 2, cap: 3, color: Colors.key },
  defuser: { type: 'defuser', label: 'Defuser', cost: 3, color: Colors.defuser },
};

/** Palette display order (Mario-Maker-style dock). */
export const PALETTE_ORDER: EditorPieceType[] = [
  'block',
  'spike',
  'crumble',
  'ghost',
  'spring',
  'saw',
  'key',
  'defuser',
  'coin',
  'dart',
  'plate',
  'door',
  'magnet',
];

export function pieceCost(type: EditorPieceType): number {
  return PIECE_REGISTRY[type].cost;
}
