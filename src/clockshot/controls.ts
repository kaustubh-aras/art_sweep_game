import Phaser from 'phaser';
import { C, FONT, hex } from './theme';
import type { Layout } from './ui';
import type { Intent } from './player';

/**
 * Touch and keyboard controls.
 *
 * The touch buttons are hit-tested against every active pointer each frame
 * rather than wired to per-object input events. That is what makes "hold left,
 * hold grapple, tap jump" work at the same time — with object events, a second
 * finger landing on a second button is easy to lose.
 */

interface Pad {
  id: string;
  cx: number;
  cy: number;
  r: number;
  label: string;
  /** Radius in design pixels; `r` is the scaled value actually drawn. */
  baseR: number;
  color: number;
  /** Pressed right now. */
  down: boolean;
  /** Pressed for the first time this frame. */
  pressed: boolean;
  gfx: Phaser.GameObjects.Graphics;
  text: Phaser.GameObjects.Text;
}

/**
 * Pad radii in design pixels — comfortably above the 44px minimum once
 * doubled into a diameter. They are multiplied by the layout scale (which
 * carries the device pixel ratio) before anything is drawn or hit-tested.
 */
const R_MOVE = 29;
const R_ACTION = 27;
const R_GRAPPLE = 33;

export class Controls {
  private pads: Pad[] = [];
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private prevJump = false;
  private mouseGrapple = false;

  /** Set when the player has touched the screen, so we can hide key hints. */
  usingTouch = false;

  private onPointerDown: ((p: Phaser.Input.Pointer) => void) | null = null;
  private onPointerUp: ((p: Phaser.Input.Pointer) => void) | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly onPause: () => void,
  ) {
    this.buildPads();
    this.bindKeyboard();
    this.bindMouse();
  }

  private makePad(id: string, label: string, r: number, color: number): Pad {
    const gfx = this.scene.add.graphics().setScrollFactor(0).setDepth(900);
    const text = this.scene.add
      .text(0, 0, label, {
        fontFamily: FONT,
        fontSize: '14px',
        color: hex(C.ink),
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(901);
    return { id, cx: 0, cy: 0, r, baseR: r, label, color, down: false, pressed: false, gfx, text };
  }

  private buildPads(): void {
    this.pads = [
      this.makePad('left', '<', R_MOVE, C.panelEdge),
      this.makePad('right', '>', R_MOVE, C.panelEdge),
      this.makePad('grapple', 'GRAPPLE', R_GRAPPLE, C.cyan),
      this.makePad('jump', 'JUMP', R_ACTION, C.good),
    ];
  }

  /** Design-pixel radius of a pad, scaled into game units. */
  private radius(p: Pad, ui: number): number {
    return p.baseR * ui;
  }

  /**
   * Positions the pads for the current viewport.
   *
   * Called on every resize, and it reads the safe-area insets, so the buttons
   * never end up under a notch or a home indicator.
   */
  layout(L: Layout): void {
    const ui = L.ui;
    const bottom = L.h - Math.max(L.safe.bottom, 10 * ui) - 18 * ui;
    const left = Math.max(L.safe.left, 12 * ui);
    const right = L.w - Math.max(L.safe.right, 12 * ui);

    const place = (id: string, x: number, y: number): void => {
      const p = this.pads.find((q) => q.id === id);
      if (!p) return;
      p.cx = x;
      p.cy = y;
      p.r = this.radius(p, ui);
      p.text.setPosition(x, y).setFontSize(Math.round((p.baseR > 30 ? 9.5 : 12) * ui));
    };

    const rm = R_MOVE * ui;
    const ra = R_ACTION * ui;
    const rg = R_GRAPPLE * ui;

    // Movement sits under the left thumb, actions under the right.
    place('left', left + rm + 6 * ui, bottom - rm);
    place('right', left + rm * 3 + 16 * ui, bottom - rm);

    // Grapple sits above jump under the right thumb. It is the verb the game
    // is built on, so it gets the largest pad and the easiest reach.
    place('grapple', right - rg - 6 * ui, bottom - rg - 62 * ui);
    place('jump', right - ra - 8 * ui, bottom - ra);

    this.draw();
  }

  private draw(): void {
    for (const p of this.pads) {
      const g = p.gfx;
      g.clear();
      const alpha = p.down ? 0.42 : 0.18;
      g.fillStyle(p.color, alpha);
      g.fillCircle(p.cx, p.cy, p.r);
      g.lineStyle(Math.max(1.5, p.r * 0.05), p.color, p.down ? 0.95 : 0.5);
      g.strokeCircle(p.cx, p.cy, p.r);
      p.text.setAlpha(p.down ? 1 : 0.75);
    }
  }

  private bindKeyboard(): void {
    const kb = this.scene.input.keyboard;
    if (!kb) {
      this.keys = {};
      return;
    }
    this.keys = kb.addKeys(
      'A,D,LEFT,RIGHT,SPACE,W,UP,E,ESC,P',
    ) as Record<string, Phaser.Input.Keyboard.Key>;

    // Escape and P both pause; both are conventions people already have.
    kb.on('keydown-ESC', this.onPause);
    kb.on('keydown-P', this.onPause);
  }

  private bindMouse(): void {
    // Either mouse button grapples — but only from a real mouse, so a touch
    // never double-counts as both a pad press and a click. With shooting gone
    // there is nothing else a click could mean, so both buttons do the useful
    // thing rather than making the player find the right one.
    this.onPointerDown = (p: Phaser.Input.Pointer): void => {
      if (p.wasTouch) {
        this.usingTouch = true;
        return;
      }
      this.mouseGrapple = true;
    };
    this.onPointerUp = (p: Phaser.Input.Pointer): void => {
      if (p.wasTouch) return;
      this.mouseGrapple = false;
    };
    this.scene.input.on('pointerdown', this.onPointerDown);
    this.scene.input.on('pointerup', this.onPointerUp);
  }

  /** Reads every pointer against every pad. Call once per frame. */
  private pollPads(): void {
    const pointers: Phaser.Input.Pointer[] = [
      this.scene.input.activePointer,
      ...this.scene.input.manager.pointers,
    ];

    for (const p of this.pads) {
      let down = false;
      for (const ptr of pointers) {
        if (!ptr || !ptr.isDown) continue;
        // Generous hit box: the visible circle plus a margin, because thumbs
        // are not precise and a missed jump feels like a broken game.
        const dx = ptr.x - p.cx;
        const dy = ptr.y - p.cy;
        const reach = p.r * 1.22;
        if (dx * dx + dy * dy <= reach * reach) {
          down = true;
          break;
        }
      }
      p.pressed = down && !p.down;
      p.down = down;
    }
    this.draw();
  }

  private padDown(id: string): boolean {
    return this.pads.find((p) => p.id === id)?.down ?? false;
  }

  private key(name: string): boolean {
    return this.keys[name]?.isDown ?? false;
  }

  /** The player's intent for this frame, from touch and keyboard together. */
  read(): Intent {
    this.pollPads();

    let moveX = 0;
    if (this.padDown('left') || this.key('A') || this.key('LEFT')) moveX -= 1;
    if (this.padDown('right') || this.key('D') || this.key('RIGHT')) moveX += 1;

    const jumpHeld =
      this.padDown('jump') || this.key('SPACE') || this.key('W') || this.key('UP');
    const grapple = this.padDown('grapple') || this.key('E') || this.mouseGrapple;

    const jump = jumpHeld && !this.prevJump;
    this.prevJump = jumpHeld;

    return { moveX, jump, jumpHeld, grapple };
  }

  /**
   * Every display object the controls own.
   *
   * The play scene needs this so it can keep the pads on the UI camera: the
   * world camera zooms, and a zoomed thumb pad would be the wrong size.
   */
  objects(): Phaser.GameObjects.GameObject[] {
    const out: Phaser.GameObjects.GameObject[] = [];
    for (const p of this.pads) {
      out.push(p.gfx, p.text);
    }
    return out;
  }

  setVisible(visible: boolean): void {
    for (const p of this.pads) {
      p.gfx.setVisible(visible);
      p.text.setVisible(visible);
    }
  }

  destroy(): void {
    const kb = this.scene.input.keyboard;
    if (kb) {
      kb.off('keydown-ESC', this.onPause);
      kb.off('keydown-P', this.onPause);
    }
    // Only the two handlers this class installed. `removeAllListeners()` would
    // also take out anything the scene bound for itself.
    if (this.onPointerDown) this.scene.input.off('pointerdown', this.onPointerDown);
    if (this.onPointerUp) this.scene.input.off('pointerup', this.onPointerUp);
    for (const p of this.pads) {
      p.gfx.destroy();
      p.text.destroy();
    }
    this.pads = [];
  }
}
