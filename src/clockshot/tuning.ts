/**
 * Movement, grapple and combat feel.
 *
 * These are the numbers that were actually played with. The grapple values in
 * particular are chosen for predictability over realism: a rope that behaves
 * the same way every time is worth more in a 30-second run than one that
 * simulates rope.
 */

/* -------------------------------------------------------------------------- */
/* Jump: state the shape you want, derive the physics                          */
/* -------------------------------------------------------------------------- */

/**
 * Tune these three. Everything below them is arithmetic.
 *
 * Gravity and jump velocity are not independent knobs — they are two views of
 * the same arc, and picking them by hand means every retune is a guess followed
 * by a playtest. Saying "the jump clears 128px and covers 264px at run speed"
 * describes something you can actually look at on screen and check against the
 * arena, and the numbers that produce it fall out.
 *
 * All distances are world pixels, which is what the arena in `arena.ts` is
 * authored in. For reference: the player is 38px tall and a platform is 24-28px.
 */
const RUN_SPEED = 320;
/** Peak height of a full-hold jump. Roughly three and a bit player-heights. */
const JUMP_APEX = 128;
/** Horizontal distance covered across the whole arc while running flat out. */
const JUMP_RANGE = 264;

/** Time from leaving the ground to the top of the arc. */
const T_APEX = JUMP_RANGE / 2 / RUN_SPEED;

/**
 * Downward acceleration, in px/s^2.
 *
 * Also handed to Arcade Physics in `game.ts`, so it is the gravity for
 * everything in the world, not just the player.
 */
export const GRAVITY = (2 * JUMP_APEX) / (T_APEX * T_APEX);

/** Upward launch speed that reaches exactly `JUMP_APEX` under `GRAVITY`. */
const JUMP_V = (2 * JUMP_APEX) / T_APEX;

export const MOVE = {
  /** Ground run speed. */
  speed: RUN_SPEED,
  /** How fast the player reaches full speed on the ground, and in the air. */
  groundAccel: 2600,
  airAccel: 1200,
  groundDrag: 1900,
  airDrag: 260,
  /** Negative because screen y grows downward. */
  jumpVelocity: -JUMP_V,
  /** Jump still fires this long after walking off an edge. */
  coyoteMs: 110,
  /** A jump pressed this long before landing still fires on touchdown. */
  bufferMs: 130,
  /** Releasing jump early cuts the rise, for a variable-height jump. */
  cutMultiplier: 0.45,
} as const;

export const GRAPPLE = {
  /** How far an anchor can be and still be grabbed. */
  range: 520,
  /** The rope can never be longer than this, however far the anchor was. */
  maxRope: 460,
  minRope: 70,
  /** Rope shortens while held, so a swing gains height instead of decaying. */
  reelSpeed: 95,
  /** Sideways input while swinging pumps the pendulum. */
  swingAccel: 1500,
  /** Speed added along the current heading when the rope is let go. */
  releaseBoost: 130,
  cooldownMs: 220,
  /** Hard ceiling on speed, so the pendulum can never go unstable. */
  maxSpeed: 1350,
} as const;

/**
 * Enemies.
 *
 * They patrol and they hurt; they are not shot at. Removing the weapon took a
 * whole second verb out of a thirty-second game — a fire button, a bullet pool,
 * an auto-aim cone and a scoring row — and left the grapple as the one thing
 * worth learning.
 */
export const COMBAT = {
  enemyRadius: 20,
} as const;

export const PLAYER_SIZE = { w: 26, h: 38 } as const;

/** How long the player is invulnerable after taking a hazard hit. */
export const HAZARD_IFRAMES_MS = 900;

/** The run clock turns urgent at this point. */
export const WARNING_MS = 10_000;
