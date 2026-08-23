/**
 * Movement, grapple and combat feel.
 *
 * These are the numbers that were actually played with. The grapple values in
 * particular are chosen for predictability over realism: a rope that behaves
 * the same way every time is worth more in a 30-second run than one that
 * simulates rope.
 */

export const GRAVITY = 1500;

export const MOVE = {
  /** Ground run speed. */
  speed: 320,
  /** How fast the player reaches full speed on the ground, and in the air. */
  groundAccel: 2600,
  airAccel: 1200,
  groundDrag: 1900,
  airDrag: 260,
  jumpVelocity: -620,
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

export const COMBAT = {
  bulletSpeed: 900,
  bulletLifeMs: 900,
  fireCooldownMs: 210,
  /** How many bullets exist at once; the pool never grows past this. */
  poolSize: 24,
  bulletRadius: 6,
  enemyRadius: 20,
  /** Aim assist: a shot within this angle of an enemy snaps onto it. */
  autoAimRadians: 0.55,
  autoAimRange: 620,
  hitFlashMs: 120,
} as const;

export const PLAYER_SIZE = { w: 26, h: 38 } as const;

/** How long the player is invulnerable after taking a hazard hit. */
export const HAZARD_IFRAMES_MS = 900;

/** The run clock turns urgent at this point. */
export const WARNING_MS = 10_000;
