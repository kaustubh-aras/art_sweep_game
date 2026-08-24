import Phaser from 'phaser';
import { C, FONT } from '@/clockshot/theme';
import { addBackdrop } from '@/clockshot/glass';
import { store } from '@/clockshot/store';
import { Button, layoutOf, text } from '@/clockshot/ui';

/**
 * The reconnect screen.
 *
 * Reached whenever the game cannot reach its server. It always offers a way
 * forward, and it retries by actually refetching state rather than by
 * restarting into the same failure.
 */
export class ErrorScene extends Phaser.Scene {
  private retryTo = 'cs-boot';
  private message = 'Cannot reach the server.';
  private bg!: Phaser.GameObjects.Graphics;
  private icon!: Phaser.GameObjects.Graphics;
  private title!: Phaser.GameObjects.Text;
  private body!: Phaser.GameObjects.Text;
  private retryBtn!: Button;
  private busy = false;
  private t = 0;

  constructor() {
    super('cs-error');
  }

  init(data: { retryTo?: string; message?: string }): void {
    this.retryTo = data.retryTo ?? 'cs-boot';
    this.message = data.message ?? 'Cannot reach the server.';
    this.busy = false;
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    // Glass needs something behind it, or it is just a grey box.
    addBackdrop(this);
    this.bg = this.add.graphics();
    this.icon = this.add.graphics();

    this.title = text(this, 0, 0, 'DISCONNECTED', 22, C.danger);
    this.title.setStyle({ fontFamily: FONT, fontStyle: 'bold' });

    this.body = text(this, 0, 0, `${this.message}\n\nYour banked seconds are safe on the server.`, 12.5, C.dim);
    this.body.setAlign('center').setLineSpacing(6);

    this.retryBtn = new Button(this, 0, 0, 'TRY AGAIN', { width: 240, variant: 'primary' }, () =>
      void this.retry(),
    );

    this.relayout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
    });
    this.cameras.main.fadeIn(200, 7, 11, 22);
  }

  private async retry(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.retryBtn.setCaption('RECONNECTING…').setEnabled(false);

    try {
      await store.refresh();
      this.scene.start(this.retryTo === 'cs-boot' ? 'cs-menu' : this.retryTo);
    } catch {
      this.busy = false;
      this.retryBtn.setCaption('TRY AGAIN').setEnabled(true);
      this.body.setText('Still cannot reach the server.\n\nCheck your connection and try once more.');
    }
  }

  private relayout(): void {
    const L = layoutOf(this);
    const g = this.bg;
    g.clear();
    g.fillStyle(C.panel, 0.9);
    const h = 260 * L.ui;
    g.fillRoundedRect(L.x, L.y + (L.ih - h) / 2, L.iw, h, 16 * L.ui);
    g.lineStyle(1.5, C.danger, 0.35);
    g.strokeRoundedRect(L.x, L.y + (L.ih - h) / 2, L.iw, h, 16 * L.ui);

    const top = L.y + (L.ih - h) / 2;
    this.title.setPosition(L.cx, top + 96 * L.ui).setFontSize(Math.round(21 * L.ui));
    this.body
      .setPosition(L.cx, top + 148 * L.ui)
      .setFontSize(Math.round(12 * L.ui))
      .setWordWrapWidth(L.iw - 44 * L.ui);
    this.retryBtn
      .setPosition(L.cx, top + h - 40 * L.ui)
      .setSize(Math.min(280 * L.ui, L.iw - 48 * L.ui), 52 * L.ui);
  }

  update(_time: number, delta: number): void {
    // A clock with a stalled hand: the game's own idiom for "not connected".
    this.t += delta / 1000;
    const L = layoutOf(this);
    const cy = L.y + (L.ih - 260 * L.ui) / 2 + 44 * L.ui;
    const r = 26 * L.ui;
    const g = this.icon;
    g.clear();
    g.lineStyle(2.5, C.danger, 0.8);
    g.strokeCircle(L.cx, cy, r);
    // The hand twitches instead of sweeping.
    const jitter = Math.sin(this.t * 8) * 0.12;
    g.lineStyle(3, C.danger, 0.9);
    g.lineBetween(
      L.cx,
      cy,
      L.cx + Math.cos(-Math.PI / 2 + jitter) * r * 0.7,
      cy + Math.sin(-Math.PI / 2 + jitter) * r * 0.7,
    );
  }
}
