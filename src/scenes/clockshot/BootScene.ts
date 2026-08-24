import Phaser from 'phaser';
import { C, FONT } from '@/clockshot/theme';
import { bakeTextures } from '@/clockshot/textures';
import { store } from '@/clockshot/store';
import { layoutOf, text } from '@/clockshot/ui';

/**
 * Loading screen.
 *
 * It bakes the sprite textures and fetches the community state at the same
 * time, behind a live clock animation — the first thing a player sees is the
 * game's own artwork, not a blank rectangle waiting on a network call.
 */
export class BootScene extends Phaser.Scene {
  private dial!: Phaser.GameObjects.Graphics;
  private status!: Phaser.GameObjects.Text;
  private title!: Phaser.GameObjects.Text;
  private tagline!: Phaser.GameObjects.Text;
  private t = 0;
  private done = false;

  constructor() {
    super('cs-boot');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    bakeTextures(this);

    this.dial = this.add.graphics();
    this.title = text(this, 0, 0, 'CLOCKSHOT', 34, C.gold);
    this.title.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.tagline = text(this, 0, 0, 'a grappling time trial', 13, C.dim);
    this.status = text(this, 0, 0, 'syncing the clock…', 12, C.faint);

    this.relayout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
    });

    void this.load_();
  }

  private async load_(): Promise<void> {
    try {
      await store.refresh();
      this.status.setText('ready');
      // A beat on "ready" so the transition does not feel like a glitch.
      this.time.delayedCall(220, () => this.go('cs-menu'));
    } catch {
      this.status.setText('could not reach the server');
      this.time.delayedCall(400, () => this.go('cs-error', { retryTo: 'cs-boot' }));
    }
  }

  private go(key: string, data?: object): void {
    if (this.done) return;
    this.done = true;
    this.cameras.main.fadeOut(180, 7, 11, 22);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () =>
      this.scene.start(key, data),
    );
  }

  private relayout(): void {
    const L = layoutOf(this);
    const cy = L.y + L.ih * 0.4;
    this.title.setPosition(L.cx, cy + 120 * L.ui).setFontSize(Math.round(32 * L.ui));
    this.tagline.setPosition(L.cx, cy + 148 * L.ui).setFontSize(Math.round(12 * L.ui));
    this.status.setPosition(L.cx, cy + 186 * L.ui).setFontSize(Math.round(11 * L.ui));
  }

  update(_time: number, delta: number): void {
    this.t += delta / 1000;
    const L = layoutOf(this);
    const cx = L.cx;
    const cy = L.y + L.ih * 0.4;
    const r = 46 * L.ui;

    const g = this.dial;
    g.clear();

    g.fillStyle(C.panel, 1);
    g.fillCircle(cx, cy, r);
    g.lineStyle(2, C.panelEdge, 0.9);
    g.strokeCircle(cx, cy, r);

    // Twelve marks, so it reads as a clock rather than a spinner.
    g.lineStyle(2, C.faint, 0.8);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.lineBetween(
        cx + Math.cos(a) * (r - 8),
        cy + Math.sin(a) * (r - 8),
        cx + Math.cos(a) * (r - 3),
        cy + Math.sin(a) * (r - 3),
      );
    }

    const fast = this.t * 2.4 - Math.PI / 2;
    const slow = this.t * 0.4 - Math.PI / 2;
    g.lineStyle(3, C.gold, 0.95);
    g.lineBetween(cx, cy, cx + Math.cos(fast) * r * 0.72, cy + Math.sin(fast) * r * 0.72);
    g.lineStyle(4, C.cyan, 0.9);
    g.lineBetween(cx, cy, cx + Math.cos(slow) * r * 0.48, cy + Math.sin(slow) * r * 0.48);
    g.fillStyle(C.ink, 1);
    g.fillCircle(cx, cy, 4);
  }
}
