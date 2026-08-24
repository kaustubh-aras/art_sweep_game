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
 * Tune these two. Gravity falls out of them.
 *
 * There is no jump button any more, but gravity still has to be *some* number,
 * and picking it by hand means it has no relationship to anything you can see.
 * So it is still expressed as a fall: an arc `FALL_HEIGHT` tall covers
 * `FALL_RANGE` of ground at run speed. That is a shape you can hold against the
 * arena and check, and it is what decides how a swing release feels.
 *
 * All distances are world pixels, which is what the arena in `arena.ts` is
 * authored in. For reference: the player is 38px tall and a platform is 24-28px.
 */
const RUN_SPEED = 320;
const FALL_HEIGHT = 128;
const FALL_RANGE = 264;

const T_APEX = FALL_RANGE / 2 / RUN_SPEED;

/**
 * Downward acceleration, in px/s^2.
 *
 * Also handed to Arcade Physics in `game.ts`, so it is the gravity for
 * everything in the world, not just the player.
 */
export const GRAVITY = (2 * FALL_HEIGHT) / (T_APEX * T_APEX);

export const MOVE = {
  /** Ground run speed. */
  speed: RUN_SPEED,
  /** How fast the player reaches full speed on the ground, and in the air. */
  groundAccel: 3200,
  /**
   * Air steering. Raised with the ground figure: after a release you are
   * airborne almost all the time, so this — not `groundAccel` — is what most
   * of the game's steering actually feels like.
   */
  airAccel: 1900,
  groundDrag: 1900,
  airDrag: 260,
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
  /**
   * Dead time after letting go before the rope can be thrown again.
   *
   * This was 220ms — about thirteen frames — from when the grapple was one of
   * five inputs and spamming it needed rate limiting. With the rope as the only
   * action in the game that is simply a button that does not work, and it is
   * the single largest source of the "input lag" this game had. 60ms is short
   * enough to feel immediate and long enough that a release cannot re-attach on
   * the very next frame.
   */
  cooldownMs: 60,
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

/**
 * The clock turns urgent below this.
 *
 * It used to be 10s, which was fine when a run was a fixed 30 seconds. The tank
 * is now 10s to start with, so that threshold painted the ring red for the
 * whole run and the warning meant nothing. Three seconds is about one swing.
 */
export const WARNING_MS = 3_000;
