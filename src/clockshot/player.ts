import Phaser from 'phaser';
import { GRAPPLE, HAZARD_IFRAMES_MS, MOVE, PLAYER_SIZE } from './tuning';
import { TEX } from './textures';
import type { Anchor } from './arena';
import type { Team } from '../shared/config';

/** What the player is asking for this frame, from whichever input device. */
export interface Intent {
  moveX: number;
  /** True only on the frame the jump began. */
  jump: boolean;
  jumpHeld: boolean;
  grapple: boolean;
}

export const NO_INTENT: Intent = {
  moveX: 0,
  jump: false,
  jumpHeld: false,
  grapple: false,
};

/**
 * The player, and the grapple that defines how they move.
 *
 * The grapple is a position-based constraint rather than a simulated rope: each
 * frame, after Phaser has integrated gravity, the player is pulled back onto
 * the circle around the anchor and their outward velocity is removed. What is
 * left is tangential — a pendulum. That is cheap, completely stable, and above
 * all repeatable, which matters more than realism in a thirty-second run.
 */
export class Player {
  readonly sprite: Phaser.Physics.Arcade.Sprite;
  readonly body: Phaser.Physics.Arcade.Body;

  /** The anchor currently held, or null when airborne or running. */
  anchor: Anchor | null = null;
  ropeLength = 0;

  /** Which way the player is facing, for shooting and for the sprite. */
  facing: 1 | -1 = 1;

  private coyoteUntil = 0;
  private jumpBufferedUntil = 0;
  private grappleReadyAt = 0;
  private invulnerableUntil = 0;
  private wasGrappleHeld = false;
  private wasJumpHeld = false;

  constructor(
    private readonly scene: Phaser.Scene,
    x: number,
    y: number,
    team: Team | null,
  ) {
    const key = team === 'red' ? TEX.playerRed : team === 'blue' ? TEX.playerBlue : TEX.player;
    this.sprite = scene.physics.add.sprite(x, y, key);
    this.body = this.sprite.body as Phaser.Physics.Arcade.Body;

    this.body.setSize(PLAYER_SIZE.w, PLAYER_SIZE.h);
    this.body.setCollideWorldBounds(false);
    this.body.setMaxVelocity(GRAPPLE.maxSpeed, GRAPPLE.maxSpeed);
    this.sprite.setDepth(20);
  }

  get x(): number {
    return this.sprite.x;
  }

  get y(): number {
    return this.sprite.y;
  }

  get attached(): boolean {
    return this.anchor !== null;
  }

  get invulnerable(): boolean {
    return this.scene.time.now < this.invulnerableUntil;
  }

  /** Starts the post-hit grace period. Returns false if already invulnerable. */
  takeHit(): boolean {
    if (this.invulnerable) return false;
    this.invulnerableUntil = this.scene.time.now + HAZARD_IFRAMES_MS;
    return true;
  }

  respawn(at: Anchor): void {
    this.release();
    this.sprite.setPosition(at.x, at.y);
    this.body.setVelocity(0, 0);
    this.invulnerableUntil = this.scene.time.now + HAZARD_IFRAMES_MS;
  }

  /* ---------------------------------------------------------------------- */
  /* Grapple                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * The nearest anchor worth grabbing.
   *
   * Anchors below the player are excluded: a rope you hang *up* from is the
   * only kind that produces a swing, and auto-targeting one underfoot is the
   * single most annoying thing an auto-aimed grapple can do.
   */
  findAnchor(anchors: readonly Anchor[]): Anchor | null {
    let best: Anchor | null = null;
    let bestDist = Infinity;
    for (const a of anchors) {
      if (a.y > this.y - 30) continue;
      const d = Phaser.Math.Distance.Between(this.x, this.y, a.x, a.y);
      if (d <= GRAPPLE.range && d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    return best;
  }

  attach(anchor: Anchor): void {
    this.anchor = anchor;
    const d = Phaser.Math.Distance.Between(this.x, this.y, anchor.x, anchor.y);
    this.ropeLength = Phaser.Math.Clamp(d, GRAPPLE.minRope, GRAPPLE.maxRope);
  }

  release(): void {
    if (!this.anchor) return;
    this.anchor = null;
    this.grappleReadyAt = this.scene.time.now + GRAPPLE.cooldownMs;

    // Momentum carries; the boost just makes letting go feel like a decision
    // rather than a loss.
    const v = this.body.velocity;
    const speed = v.length();
    if (speed > 40) {
      const scale = (speed + GRAPPLE.releaseBoost) / speed;
      v.set(v.x * scale, v.y * scale);
      this.clampSpeed();
    }
  }

  private clampSpeed(): void {
    const v = this.body.velocity;
    if (v.length() > GRAPPLE.maxSpeed) {
      v.normalize().scale(GRAPPLE.maxSpeed);
    }
  }

  /**
   * Holds the player on the rope circle.
   *
   * Runs after Phaser's integration step, so it is correcting a position that
   * already includes this frame's gravity — which is what keeps the swing
   * stable no matter the frame rate.
   */
  private applyRope(dtSeconds: number, intent: Intent): void {
    const a = this.anchor;
    if (!a) return;

    // Reeling in turns a decaying swing into a climbing one.
    this.ropeLength = Math.max(GRAPPLE.minRope, this.ropeLength - GRAPPLE.reelSpeed * dtSeconds);

    let dx = this.x - a.x;
    let dy = this.y - a.y;
    let dist = Math.hypot(dx, dy);
    if (dist < 0.001) {
      // Directly on the anchor: nudge down so the maths has a direction.
      dx = 0;
      dy = 1;
      dist = 1;
    }

    const nx = dx / dist;
    const ny = dy / dist;
    const v = this.body.velocity;

    // Pumping: push along the tangent, the way you drive a swing.
    if (intent.moveX !== 0) {
      const tx = -ny;
      const ty = nx;
      const push = GRAPPLE.swingAccel * dtSeconds * intent.moveX;
      v.x += tx * push;
      v.y += ty * push;
    }

    if (dist > this.ropeLength) {
      // Snap back onto the circle...
      this.sprite.setPosition(a.x + nx * this.ropeLength, a.y + ny * this.ropeLength);
      // ...and drop the component of velocity that was stretching the rope.
      const radial = v.x * nx + v.y * ny;
      if (radial > 0) {
        v.x -= radial * nx;
        v.y -= radial * ny;
      }
    }

    this.clampSpeed();
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                   */
  /* ---------------------------------------------------------------------- */

  update(deltaMs: number, intent: Intent, anchors: readonly Anchor[]): void {
    const dt = Math.min(deltaMs, 50) / 1000;
    const now = this.scene.time.now;
    const grounded = this.body.blocked.down || this.body.touching.down;

    if (grounded) this.coyoteUntil = now + MOVE.coyoteMs;
    if (intent.jump) this.jumpBufferedUntil = now + MOVE.bufferMs;

    // --- grapple, edge-triggered on press, held to stay attached ---
    const pressed = intent.grapple && !this.wasGrappleHeld;
    this.wasGrappleHeld = intent.grapple;

    if (pressed && !this.attached && now >= this.grappleReadyAt) {
      const target = this.findAnchor(anchors);
      if (target) this.attach(target);
    } else if (!intent.grapple && this.attached) {
      this.release();
    }

    // --- horizontal movement ---
    if (intent.moveX !== 0) this.facing = intent.moveX > 0 ? 1 : -1;

    if (!this.attached) {
      const accel = grounded ? MOVE.groundAccel : MOVE.airAccel;
      const drag = grounded ? MOVE.groundDrag : MOVE.airDrag;

      if (intent.moveX !== 0) {
        this.body.setAccelerationX(accel * intent.moveX);
        this.body.setDragX(0);
        // Only cap run speed on the ground: capping in the air would eat the
        // momentum the player just earned from a swing.
        if (grounded) {
          this.body.velocity.x = Phaser.Math.Clamp(this.body.velocity.x, -MOVE.speed, MOVE.speed);
        }
      } else {
        this.body.setAccelerationX(0);
        this.body.setDragX(drag);
      }
    } else {
      this.body.setAccelerationX(0);
      this.body.setDragX(0);
    }

    // --- jump ---
    const canJump = now < this.coyoteUntil && !this.attached;
    if (now < this.jumpBufferedUntil && canJump) {
      this.body.velocity.y = MOVE.jumpVelocity;
      this.jumpBufferedUntil = 0;
      this.coyoteUntil = 0;
    }
    // Variable height: the cut fires once, on the frame the button comes up.
    // Running it every frame would compound — 0.45^5 is about 0.02 — and wipe
    // out the upward momentum a grapple release has just earned, which is the
    // one thing a swing exists to give you.
    const releasedJump = this.wasJumpHeld && !intent.jumpHeld;
    this.wasJumpHeld = intent.jumpHeld;
    if (releasedJump && this.body.velocity.y < 0 && !this.attached) {
      this.body.velocity.y *= MOVE.cutMultiplier;
    }

    // Jumping off the rope is a release plus a kick.
    if (intent.jump && this.attached) {
      this.release();
      this.body.velocity.y = Math.min(this.body.velocity.y, MOVE.jumpVelocity * 0.75);
    }

    if (this.attached) this.applyRope(dt, intent);

    this.sprite.setFlipX(this.facing < 0);

    // Blink while invulnerable so a hit is legible without a health bar.
    this.sprite.setAlpha(this.invulnerable ? (Math.floor(now / 70) % 2 ? 0.35 : 1) : 1);
  }

  destroy(): void {
    this.sprite.destroy();
  }
}
