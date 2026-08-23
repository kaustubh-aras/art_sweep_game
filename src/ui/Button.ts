import Phaser from 'phaser';
import { T, TX, FONT } from './theme';
import { sfx } from '@/audio/AudioManager';
import { dpr } from './viewport';

export type Variant = 'primary' | 'ghost' | 'gold' | 'danger' | 'quiet';

export interface ButtonOpts {
  label: string;
  variant?: Variant;
  fontSize?: number;
  onClick: () => void;
  /** Skips the click sound (used by the mute toggle itself). */
  silent?: boolean;
}

const FILL: Record<Variant, { bg: number; edge: number; text: string }> = {
  primary: { bg: 0x0f3a2c, edge: T.hand, text: TX.green },
  ghost: { bg: 0x0d1a26, edge: T.panelEdge, text: TX.text },
  gold: { bg: 0x3a2c08, edge: T.gold, text: TX.gold },
  danger: { bg: 0x3a1119, edge: T.warn, text: TX.warn },
  quiet: { bg: 0x0a121b, edge: 0x16303f, text: TX.dim },
};

/**
 * The one button used on every screen.
 *
 * Grown from the `iconBtn` / `textBtn` helpers in the existing EditorScene, with
 * the things a phone needs bolted on: a 44 px minimum tap target, press-down
 * feedback that does not rely on hover, an "armed" latch so a finger that
 * slides off does not fire, and a short cooldown so a double-tap cannot
 * activate twice.
 */
export class Button extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.Graphics;
  private label: Phaser.GameObjects.Text;
  private hit: Phaser.GameObjects.Rectangle;
  private variant: Variant;
  private enabled = true;
  private armed = false;
  private lastFire = -1e9;
  private bw = 100;
  private bh = 44;

  constructor(scene: Phaser.Scene, private opts: ButtonOpts) {
    super(scene, 0, 0);
    this.variant = opts.variant ?? 'ghost';

    this.bg = scene.add.graphics();
    this.label = scene.add
      .text(0, 0, opts.label, {
        fontFamily: FONT,
        fontSize: `${opts.fontSize ?? 15 * dpr()}px`,
        color: FILL[this.variant].text,
      })
      .setOrigin(0.5);
    this.hit = scene.add.rectangle(0, 0, 100, 44, 0xffffff, 0).setOrigin(0.5);

    this.add([this.bg, this.label, this.hit]);
    scene.add.existing(this);

    this.hit.setInteractive({ useHandCursor: true });
    this.hit.on('pointerdown', this.onDown, this);
    this.hit.on('pointerup', this.onUp, this);
    this.hit.on('pointerout', this.disarm, this);
    this.hit.on('pointerupoutside', this.disarm, this);
    // Nothing outlives the scene: no stale listeners after a restart.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  /** Position and size the button. Enforces the 44 px minimum tap height. */
  layout(cx: number, cy: number, w: number, h: number): this {
    this.bw = w;
    this.bh = h;
    this.setPosition(cx, cy);
    this.hit.setSize(w, Math.max(h, 44 * dpr()));
    this.hit.setInteractive({ useHandCursor: true });
    this.label.setPosition(0, 0);
    this.redraw(false);
    return this;
  }

  setFontSize(px: number): this {
    this.label.setFontSize(px);
    return this;
  }

  setLabel(text: string): this {
    this.label.setText(text);
    return this;
  }

  setVariant(v: Variant): this {
    this.variant = v;
    this.label.setColor(FILL[v].text);
    this.redraw(false);
    return this;
  }

  setEnabled(on: boolean): this {
    this.enabled = on;
    this.setAlpha(on ? 1 : 0.38);
    this.hit.input && (this.hit.input.enabled = on);
    return this;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private onDown(): void {
    if (!this.enabled) return;
    this.armed = true;
    this.redraw(true);
    this.scene.tweens.add({ targets: this, scale: 0.955, duration: 60, ease: 'Quad.easeOut' });
  }

  private disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.redraw(false);
    this.scene.tweens.add({ targets: this, scale: 1, duration: 90, ease: 'Quad.easeOut' });
  }

  private onUp(): void {
    if (!this.enabled || !this.armed) return;
    this.armed = false;
    this.redraw(false);
    this.scene.tweens.add({ targets: this, scale: 1, duration: 110, ease: 'Back.easeOut' });

    // Guard against a bounced tap firing the action twice.
    const now = this.scene.time.now;
    if (now - this.lastFire < 240) return;
    this.lastFire = now;
    if (!this.opts.silent) sfx.tap();
    this.opts.onClick();
  }

  private redraw(down: boolean): void {
    const f = FILL[this.variant];
    const w = this.bw;
    const h = this.bh;
    const r = Math.min(10 * dpr(), h / 2);
    const g = this.bg;
    g.clear();
    g.fillStyle(f.bg, down ? 1 : 0.85);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, r);
    g.lineStyle(down ? 2.5 : 1.5, f.edge, down ? 1 : 0.7);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, r);
  }
}

/** Convenience factory so scenes read as layout code, not construction code. */
export function button(scene: Phaser.Scene, opts: ButtonOpts): Button {
  return new Button(scene, opts);
}
