/**
 * Core constants. Values sourced directly from the GDD (§4.1, §4.3, §5.1).
 * Everything spatial is expressed in TILES; multiply by TILE to get pixels.
 */

// ---- Canvas: Classic format (§4.1) ----
export const TILE = 32; // logical px per tile
export const COLS = 20;
export const ROWS = 12;
export const GAME_W = COLS * TILE; // 640
export const GAME_H = ROWS * TILE; // 384

// ---- Simulation (§4.3, §9.1) ----
// Fixed-timestep, deterministic. NEVER delta-scale gameplay movement.
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ; // seconds per fixed step

// ---- Movement feel (§4.3) — tuning targets, in tiles/sec & seconds ----
export const RUN_SPEED = 8; // tiles/sec
export const JUMP_APEX_TILES = 3.5; // peak jump height
export const JUMP_RANGE_TILES = 4; // horizontal range at full run
export const COYOTE_TIME = 0.08; // 80 ms
export const JUMP_BUFFER = 0.1; // 100 ms
export const JUMP_CUT_MULT = 0.4; // release early -> velocity cut to ~40%
export const MAX_FALL_SPEED = 24; // tiles/sec cap (anti-tunnel)
export const SPRING_APEX_TILES = 5.5; // fixed bounce height off a spring (tiles), independent of jump
export const SPRING_LAUNCH_SPEED = 20; // sideways spring launch speed (tiles/sec)
export const SPRING_LAUNCH_DECAY = 32; // how fast a sideways launch fades back to normal control (tiles/sec^2)

// ---- Editor / rules (§5.1, §5.2) ----
export const BUDGET_TOTAL = 100;
export const KEY_MAX = 3; // a level may hold at most 3 keys
export const GHOST_MAX = 3; // cap ghost blocks so levels can't be pure guessing (§5.4 #9)
export const CRUMBLE_TIME = 0.5; // seconds a crumble block lasts once stood on (§5.4)
export const SAW_RADIUS = 0.5; // tiles — circular kill radius of a saw blade (§5.4 #5)

// Palette (§5.4). Cost/tier metadata lives with the editor; this is the enum.
export enum PieceType {
  Block = 'block',
  Spike = 'spike',
  Crumble = 'crumble',
  Coin = 'coin',
  Saw = 'saw',
  Dart = 'dart',
  Spring = 'spring',
  Plate = 'plate',
  Door = 'door',
  Ghost = 'ghost',
  Magnet = 'magnet',
}

// ---- Scene keys ----
export const Scenes = {
  Boot: 'BootScene',
  Menu: 'MenuScene',
  Results: 'ResultsScene',
  // ---- SWEEP scenes ----
  Tutorial: 'TutorialScene',
  Guess: 'GuessScene',
  Draw: 'DrawScene',
  Post: 'PostScene',
  Pause: 'PauseScene',
  // ---- legacy Trapmaker scenes (files kept on disk, not registered) ----
  Raid: 'RaidScene',
  Editor: 'EditorScene',
} as const;

// ---- Palette colors (flat, high-contrast, thumbnail-readable) (§10) ----
export const Colors = {
  bg: 0x14151a,
  block: 0x3a4256,
  blockEdge: 0x5a6480,
  crumble: 0xc0894f, // crumble block (tan, distinct from grey terrain)
  crumbleEdge: 0x8a5f33,
  spike: 0xff5964,
  kill: 0x7a1226, // revealed kill-block base (dark crimson)
  killEdge: 0xc01530,
  saw: 0xd0d4dc, // saw blade (steel)
  sawEdge: 0x6a6f7a,
  player: 0x6ee7ff,
  exit: 0x9dff6e, // door unlocked (green)
  exitLocked: 0xb14aff, // door locked (purple)
  coin: 0xffd24a,
  key: 0xffe14d, // collectible key (gold)
  spring: 0xff9f43, // spring coil (orange, distinct from tan crumble)
  springEdge: 0xcc7a2e,
  defuser: 0x38e0b0, // defusal kit (teal)
  defuserEdge: 0x1f9e7c,
  text: '#e6e8ef',
} as const;
