import Phaser from 'phaser';
import { C } from './theme';
import { drawGlass } from './glass';
import type { Layout } from './ui';
import type { Intent } from './player';

/**
 * Touch and keyboard controls.
 *
 * Two things, and only two: a thumbstick that steers, and a hook that swings.
 * The pair of arrow pads this replaced could only ever say "all the way left"
 * or "nothing", which is a blunt instrument for pumping a pendulum — a swing
 * wants a lean, not a shove. The stick reports how far it has been pushed and
 * `Player` already multiplies by that, so a light touch is now a light push.
 *
 * The stick is claimed by pointer id from the scene's own pointer events, then
 * reconciled once a frame against what is really still down. Events alone lose
 * a finger whenever a `pointerup` goes missing — off the edge of the canvas, or
 * through a full-screen transition — and polling alone cannot tell which finger
 * started where, which is the whole job when a second thumb is already holding
 * the hook.
 */

/** Everything about the thumbstick, in design pixels. */
const STICK = {
  /** The visible well the thumb rests in. */
  base: 58,
  /**
   * How far the knob travels before it is at full lean.
   *
   * This is the precision dial, not the size dial. Lean is reported as a
   * fraction of this distance, so a longer throw spreads the same 0-to-1 range
   * over more millimetres of thumb — every intermediate value gets easier to
   * hold, which is what steering a swing actually asks for.
   */
  throw: 50,
  knob: 26,
  /**
   * Lean below this fraction reads as centred.
   *
   * A thumb resting on the stick is never quite still, and a run that drifts
   * on its own reads as the game fighting you.
   */
  deadzone: 0.16,
} as const;

/** The hook pad. Bigger than the knob: it is the shot. */
const GRAPPLE_R = 41;

/** How far outside the drawn circle a thumb still counts as on it. */
const TOUCH_SLOP = 1.22;

export class Controls {
  /* --- thumbstick ------------------------------------------------------- */

  /** Where the well sits when nothing is touching it. */
  private homeX = 0;
  private homeY = 0;
  /** Where the well sits right now — under the thumb that grabbed it. */
  private baseX = 0;
  private baseY = 0;
  private knobX = 0;
  private knobY = 0;
  /** The pointer that owns the stick, or null. */
  private stickId: number | null = null;
  /** Lean along X, already deadzoned, in -1..1. */
  private lean = 0;
  /** The rectangle a press has to land in to grab the stick. */
  private zone = new Phaser.Geom.Rectangle();
  private stickGfx!: Phaser.GameObjects.Graphics;

  /* --- hook ------------------------------------------------------------- */

  private grappleX = 0;
  private grappleY = 0;
  private grappleR = GRAPPLE_R;
  private grappleDown = false;
  /** True while an anchor is actually within reach — set by the play scene. */
  private grappleReady = false;
  /** True while the rope is out. */
  private grappleLive = false;
  private grappleGfx!: Phaser.GameObjects.Graphics;
  /** Quantised pulse phase, so a breathing ring is not a redraw every frame. */
  private pulse = -1;

  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private mouseGrapple = false;
  private ui = 1;

  /** Set once the player has touched the screen rather than typed. */
  usingTouch = false;

  private onPointerDown: ((p: Phaser.Input.Pointer) => void) | null = null;
  private onPointerMove: ((p: Phaser.Input.Pointer) => void) | null = null;
  private onPointerUp: ((p: Phaser.Input.Pointer) => void) | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly onPause: () => void,
  ) {
    this.stickGfx = scene.add.graphics().setScrollFactor(0).setDepth(900);
    this.grappleGfx = scene.add.graphics().setScrollFactor(0).setDepth(900);

    this.bindKeyboard();
    this.bindPointers();
  }

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Positions both controls for the current viewport.
   *
   * Called on every resize, and it reads the safe-area insets, so neither
   * control ends up under a notch or a home indicator.
   */
  layout(L: Layout): void {
    const ui = L.ui;
    this.ui = ui;

    const bottom = L.h - Math.max(L.safe.bottom, 10 * ui) - 16 * ui;
    const left = Math.max(L.safe.left, 12 * ui);
    const right = L.w - Math.max(L.safe.right, 12 * ui);

    const reach = (STICK.base + STICK.knob * 0.5) * ui;
    this.homeX = left + reach + 6 * ui;
    this.homeY = bottom - reach;
    if (this.stickId === null) this.recentre();

    this.grappleR = GRAPPLE_R * ui;
    this.grappleX = right - this.grappleR - 8 * ui;
    this.grappleY = bottom - this.grappleR;

    // Anywhere on the left of the screen, low enough to be a thumb rather than
    // a swing: grabbing the stick should not mean finding it first. The zone
    // stops short of the hook so the two can never fight over a finger.
    const zoneTop = Math.min(this.homeY - reach * 2.1, L.h * 0.52);
    const zoneRight = Math.min(L.w * 0.52, this.grappleX - this.grappleR * 1.3);
    this.zone.setTo(0, zoneTop, Math.max(0, zoneRight), L.h - zoneTop);

    this.draw();
  }

  private recentre(): void {
    this.baseX = this.homeX;
    this.baseY = this.homeY;
    this.knobX = this.homeX;
    this.knobY = this.homeY;
    this.lean = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Input                                                                   */
  /* ---------------------------------------------------------------------- */

  private bindKeyboard(): void {
    const kb = this.scene.input.keyboard;
    if (!kb) {
      this.keys = {};
      return;
    }
    this.keys = kb.addKeys('A,D,LEFT,RIGHT,SPACE,W,UP,E,ESC,P') as Record<
      string,
      Phaser.Input.Keyboard.Key
    >;

    // Escape and P both pause; both are conventions people already have.
    kb.on('keydown-ESC', this.onPause);
    kb.on('keydown-P', this.onPause);
  }

  private bindPointers(): void {
    this.onPointerDown = (p: Phaser.Input.Pointer): void => {
      if (p.wasTouch) this.usingTouch = true;

      // The stick gets first refusal on anything landing in its corner.
      if (this.stickId === null && this.zone.contains(p.x, p.y)) {
        this.stickId = p.id;
        // The well comes to the thumb, not the other way round. Missing a
        // fixed stick by a centimetre is how a run gets thrown away.
        this.baseX = p.x;
        this.baseY = p.y;
        this.moveKnob(p.x, p.y);
        this.draw();
        return;
      }

      // A mouse has no pad to hold, so a click anywhere else is the hook. Touch
      // is left to the pad below, or a tap on it would count twice.
      if (!p.wasTouch && !this.overGrapple(p.x, p.y)) this.mouseGrapple = true;
    };

    this.onPointerMove = (p: Phaser.Input.Pointer): void => {
      if (p.id !== this.stickId) return;
      this.moveKnob(p.x, p.y);
      this.draw();
    };

    this.onPointerUp = (p: Phaser.Input.Pointer): void => {
      if (p.id === this.stickId) {
        this.stickId = null;
        this.recentre();
        this.draw();
      }
      if (!p.wasTouch) this.mouseGrapple = false;
    };

    this.scene.input.on('pointerdown', this.onPointerDown);
    this.scene.input.on('pointermove', this.onPointerMove);
    this.scene.input.on('pointerup', this.onPointerUp);
    this.scene.input.on('pointerupoutside', this.onPointerUp);
  }

  /** Clamps the knob to the stick's throw and reads the lean off it. */
  private moveKnob(x: number, y: number): void {
    const max = STICK.throw * this.ui;
    let dx = x - this.baseX;
    let dy = y - this.baseY;
    const dist = Math.hypot(dx, dy);
    if (dist > max && dist > 0) {
      dx = (dx / dist) * max;
      dy = (dy / dist) * max;
    }
    this.knobX = this.baseX + dx;
    this.knobY = this.baseY + dy;

    const raw = Phaser.Math.Clamp(dx / max, -1, 1);
    const mag = Math.abs(raw);
    // Rescaled past the deadzone, so the first millimetre of real travel is a
    // real push rather than a step from nothing to a sixth.
    this.lean =
      mag < STICK.deadzone
        ? 0
        : Math.sign(raw) * ((mag - STICK.deadzone) / (1 - STICK.deadzone));
  }

  /** Every pointer the input manager knows about, without duplicates. */
  private pointers(): Phaser.Input.Pointer[] {
    const all = [this.scene.input.activePointer, ...this.scene.input.manager.pointers];
    return all.filter((p, i) => p && all.indexOf(p) === i);
  }

  private overGrapple(x: number, y: number): boolean {
    const dx = x - this.grappleX;
    const dy = y - this.grappleY;
    const reach = this.grappleR * TOUCH_SLOP;
    return dx * dx + dy * dy <= reach * reach;
  }

  /**
   * Reconciles both controls against the pointers that are really down.
   *
   * The hook is polled outright rather than driven by events: holding it while
   * a second thumb works the stick is the normal case, and a hold is exactly
   * what a pair of events is worst at keeping track of.
   *
   * Returns whether anything needs redrawing.
   */
  private pollPointers(): boolean {
    let changed = false;
    let held = false;
    let stickAlive = false;

    for (const p of this.pointers()) {
      if (!p || !p.isDown) continue;
      if (p.id === this.stickId) {
        stickAlive = true;
        // A move that never fired — a finger that slid in during a resize, say
        // — would otherwise leave the knob behind the thumb.
        if (p.x !== this.knobX || p.y !== this.knobY) {
          this.moveKnob(p.x, p.y);
          changed = true;
        }
        continue;
      }
      if (!held && this.overGrapple(p.x, p.y)) held = true;
    }

    // A finger whose release was never delivered still has to let go.
    if (this.stickId !== null && !stickAlive) {
      this.stickId = null;
      this.recentre();
      changed = true;
    }
    if (held !== this.grappleDown) {
      this.grappleDown = held;
      changed = true;
    }
    return changed;
  }

  private key(name: string): boolean {
    return this.keys[name]?.isDown ?? false;
  }

  /** The player's intent for this frame, from touch and keyboard together. */
  read(): Intent {
    if (this.pollPointers()) this.draw();

    let moveX = this.lean;
    if (this.key('A') || this.key('LEFT')) moveX -= 1;
    if (this.key('D') || this.key('RIGHT')) moveX += 1;
    moveX = Phaser.Math.Clamp(moveX, -1, 1);

    // Space and W grapple too: with no jump there is nothing else they could
    // sensibly mean, and a player will try them first.
    const grapple =
      this.grappleDown ||
      this.key('E') ||
      this.key('SPACE') ||
      this.key('W') ||
      this.key('UP') ||
      this.mouseGrapple;

    return { moveX, grapple };
  }

  /**
   * Tells the hook pad what the hook could actually do right now.
   *
   * A button that looks identical whether or not there is anything to grab is
   * a button you learn to distrust. Lit means a real anchor is in range; solid
   * means the rope is out.
   */
  setGrappleState(ready: boolean, live: boolean): void {
    if (ready === this.grappleReady && live === this.grappleLive) return;
    // The rope catching is the one moment in the game worth feeling. A thumb is
    // covering the pad at the instant it happens, so the confirmation cannot be
    // where the thumb is — and the sound is no use to the many players who meet
    // this post muted. Short enough to be a tick rather than a buzz, and only
    // on the catch: firing on release as well would make swinging feel noisy.
    if (live && !this.grappleLive) navigator.vibrate?.(10);
    this.grappleReady = ready;
    this.grappleLive = live;
    this.drawGrapple();
  }

  /**
   * Advances the ready ring's breath.
   *
   * Quantised to eight steps, so the one control that animates costs about
   * eleven redraws a second rather than sixty, in the loop that has to stay
   * tight.
   */
  tick(nowMs: number): void {
    if (!this.grappleReady || this.grappleDown || this.grappleLive) return;
    const step = Math.floor(nowMs / 90) % 8;
    if (step === this.pulse) return;
    this.pulse = step;
    this.drawGrapple();
  }

  /* ---------------------------------------------------------------------- */
  /* Drawing                                                                 */
  /* ---------------------------------------------------------------------- */

  private draw(): void {
    this.drawStick();
    this.drawGrapple();
  }

  private drawStick(): void {
    const ui = this.ui;
    const g = this.stickGfx;
    const held = this.stickId !== null;
    const base = STICK.base * ui;
    const knob = STICK.knob * ui;
    g.clear();

    // The well. Dim while idle, so it reads as furniture rather than as
    // something waiting to be pressed.
    g.fillStyle(C.panel, held ? 0.5 : 0.3);
    g.fillCircle(this.baseX, this.baseY, base);
    g.lineStyle(Math.max(1.5, 2 * ui), C.panelEdge, held ? 0.95 : 0.55);
    g.strokeCircle(this.baseX, this.baseY, base);

    // A horizontal guide, because left and right are the only axis that does
    // anything and the stick should say so before it is pushed.
    g.lineStyle(Math.max(1, 1.5 * ui), C.faint, held ? 0.5 : 0.32);
    g.lineBetween(this.baseX - base * 0.62, this.baseY, this.baseX + base * 0.62, this.baseY);

    // The knob, tinted by how hard it is being pushed.
    const lean = Math.abs(this.lean);
    g.fillStyle(C.panelEdge, 0.95);
    g.fillCircle(this.knobX, this.knobY, knob);
    g.fillStyle(C.ink, 0.1 + lean * 0.22);
    g.fillCircle(this.knobX, this.knobY, knob);
    g.lineStyle(Math.max(1.5, 2.2 * ui), held ? C.cyan : C.dim, held ? 0.95 : 0.6);
    g.strokeCircle(this.knobX, this.knobY, knob);

    // Two chevrons on the knob: the control says what it is for.
    const chev = knob * 0.34;
    g.lineStyle(Math.max(1.5, 2 * ui), C.ink, 0.5 + lean * 0.45);
    for (const dir of [-1, 1] as const) {
      const x = this.knobX + dir * knob * 0.42;
      g.beginPath();
      g.moveTo(x - dir * chev * 0.5, this.knobY - chev);
      g.lineTo(x + dir * chev * 0.5, this.knobY);
      g.lineTo(x - dir * chev * 0.5, this.knobY + chev);
      g.strokePath();
    }
  }

  private drawGrapple(): void {
    const ui = this.ui;
    const g = this.grappleGfx;
    const r = this.grappleR;
    const x = this.grappleX;
    const y = this.grappleY;
    const on = this.grappleDown || this.grappleLive;
    const lit = this.grappleReady || on;
    g.clear();

    // A ring outside the pad that breathes while there is something to catch.
    if (this.grappleReady && !on) {
      const grow = 1 + 0.06 * Math.sin((Math.max(this.pulse, 0) / 8) * Math.PI * 2);
      g.lineStyle(Math.max(1.5, 2 * ui), C.cyan, 0.3);
      g.strokeCircle(x, y, r * 1.16 * grow);
    }

    // The same pane every other surface in the game is made of, rather than the
    // `C.panel` recipe this used to paint. A rounded rectangle whose radius is
    // half its size is a circle, so the shared material needs no round variant.
    drawGlass(g, x - r, y - r, r * 2, r * 2, r, ui);

    // The cyan says what the pad is for, and how strongly it says it is the
    // state. The resting values are deliberately not faint: holding the button
    // *keeps* trying, and an anchor is caught the moment it comes into range —
    // so a pad that looks switched off whenever nothing is near teaches the
    // opposite of the way the rope is meant to be played. It should read as
    // available and waiting, with `lit` as the promise that something is there.
    g.fillStyle(C.cyan, on ? 0.34 : lit ? 0.18 : 0.12);
    g.fillCircle(x, y, r);
    g.lineStyle(Math.max(2, 3 * ui), C.cyan, on ? 1 : lit ? 0.9 : 0.62);
    g.strokeCircle(x, y, r);

    // The hook is the whole affordance now, so it is drawn big enough to be
    // read as a hook rather than decoration on a circle.
    this.drawHook(g, x, y, r * 0.54, on ? 1 : lit ? 0.95 : 0.72);
  }

  /** The hook itself: an eye, a shaft, a curl and a barb. Reads at thumb size. */
  private drawHook(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    r: number,
    alpha: number,
  ): void {
    const w = Math.max(2, r * 0.26);

    // The eyelet the rope ties to, and the shaft under it.
    g.lineStyle(Math.max(1.5, w * 0.8), C.ink, alpha);
    g.strokeCircle(cx, cy - r * 1.24, r * 0.28);
    g.lineStyle(w, C.ink, alpha);
    g.beginPath();
    g.moveTo(cx, cy - r * 0.96);
    g.lineTo(cx, cy + r * 0.12);
    g.strokePath();

    // The curl.
    g.beginPath();
    g.arc(cx, cy + r * 0.12, r * 0.64, 0, Math.PI, false);
    g.strokePath();

    // The barb, so the curl reads as a hook rather than a horseshoe.
    g.beginPath();
    g.moveTo(cx - r * 0.64, cy + r * 0.12);
    g.lineTo(cx - r * 0.64, cy - r * 0.36);
    g.lineTo(cx - r * 0.24, cy - r * 0.16);
    g.strokePath();
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Every display object the controls own.
   *
   * The play scene needs this so it can keep them on the UI camera: the world
   * camera zooms, and a zoomed thumbstick would be the wrong size.
   */
  objects(): Phaser.GameObjects.GameObject[] {
    return [this.stickGfx, this.grappleGfx];
  }

  setVisible(visible: boolean): void {
    this.stickGfx.setVisible(visible);
    this.grappleGfx.setVisible(visible);
  }

  destroy(): void {
    const kb = this.scene.input.keyboard;
    if (kb) {
      kb.off('keydown-ESC', this.onPause);
      kb.off('keydown-P', this.onPause);
    }
    // Only the handlers this class installed. `removeAllListeners()` would also
    // take out anything the scene bound for itself.
    if (this.onPointerDown) this.scene.input.off('pointerdown', this.onPointerDown);
    if (this.onPointerMove) this.scene.input.off('pointermove', this.onPointerMove);
    if (this.onPointerUp) {
      this.scene.input.off('pointerup', this.onPointerUp);
      this.scene.input.off('pointerupoutside', this.onPointerUp);
    }
    this.stickGfx.destroy();
    this.grappleGfx.destroy();
  }
}
