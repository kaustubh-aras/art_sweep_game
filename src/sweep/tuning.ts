/**
 * SWEEP tuning table (GDD §13). Every number a playtest would touch lives here.
 * Values are the GDD defaults; the commented range is the safe playtest band.
 */

// ---- The sweep itself (§3) ----
export const SWEEP_PERIOD = 10_000; // ms per rotation      (range 8000–15000)
export const AFTERGLOW_FLOOR = 0.25; // alpha just before the hand returns (0.15–0.4)
export const DRAWER_GHOST_ALPHA = 0.08; // erased-stroke guide, drawer only (0–0.15)

/** Angular buckets the ink is stamped into. Higher = smoother afterglow ramp,
 *  more Graphics objects. 60 = 6° per wedge, which is under the brush width at
 *  the rim, so the erase edge reads as a clean line. */
export const INK_WEDGES = 60;

// ---- Draw session (§6) ----
export const DRAW_SWEEPS = 6; // hard stop                  (range 4–8)
export const DRAW_MIN_SWEEPS = 2; // Done unlocks here
export const MAX_STROKE_POINTS = 5000; // server-side cap in the GDD; enforced locally

// ---- Guessing and scoring (§6) ----
export const POINTS_MAX = 100;
export const POINTS_MIN = 10;
export const POINTS_WINDOW = 60_000; // ms for the 100 -> 10 slide (45000–90000)
export const GUESS_CAP = 10; // guesses per link           (range 10–30)
export const LOCKOUT_SWEEPS = 1; // per wrong guess
export const LOCKOUT_SWEEPS_HARSH = 2; // from the 3rd wrong guess
export const LOCKOUT_ESCALATE_AFTER = 3; // wrong guesses before the harsh lockout
export const FUZZY_MIN_LEN = 6; // edit distance <= 1 accepted at this length

// ---- Bounty (§6) ----
export const BOUNTY_PER_HOUR = 10;
export const BOUNTY_CAP = 500;

// ---- Heat grid (§6) ----
export const HEAT_GRID = 24; // 24 x 24                     (range 16–32)

// ---- Chain run (§4) — one session is a chain of links ----
export const CHAIN_TARGET = 5; // links to solve for a complete chain
export const BATON_WINDOW = 600_000; // 10 min offer window (5–15 min)

// ---- Stroke encoding (§6) ----
export const QUANT = 1000; // coordinates quantized to 0..1000 inside the unit circle
export const CENTER_DEADZONE = 0.05; // r < this uses theta = 0 (§3)
