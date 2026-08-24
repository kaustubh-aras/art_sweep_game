import Phaser from 'phaser';
import { C, FONT } from '@/clockshot/theme';
import { bakeTextures } from '@/clockshot/textures';
import { store } from '@/clockshot/store';
import { api, NetError } from '@/clockshot/net';
import { whenOpened } from '@/clockshot/gate';
import { layoutOf, text } from '@/clockshot/ui';

/**
 * Loading screen, and the hand-off from the post into a run.
 *
 * It bakes the sprite textures and fetches the community state at the same
 * time, behind a live clock animation — the first thing a player sees is the
 * game's own artwork, not a blank rectangle waiting on a network call.
 *
 * It then waits on the splash gate rather than starting a scene. TAKE THE RUN
 * means take the run: the menu is somewhere a player chooses to go from the
 * results screen, not a toll booth between the post and the game. Everything
 * that could turn a tap into a wait — the state fetch, the textures — has
 * already happened by the time the gate opens, so all that is left is asking
 * the server for a run id.
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
    } catch {
      this.status.setText('could not reach the server');
      this.time.delayedCall(400, () => this.go('cs-error', { retryTo: 'cs-boot' }));
      return;
    }

    this.status.setText('ready when you are');
    await whenOpened();
    // A retry that came back through here has already moved on.
    if (this.done) return;
    await this.startRun();
  }

  /**
   * Asks the server for a run, then drops the player straight into it.
   *
   * The two failures a player can actually do something about — not being
   * logged in, and having taken too many runs too quickly — are sent to the
   * menu with the server's own wording, because the menu is the screen that can
   * explain them and still offer the board. Anything else is a connection
   * problem, which has its own screen and a retry that comes back through here.
   */
  private async startRun(): Promise<void> {
    this.status.setText('starting your run…');

    try {
      const run = await api.startRun();
      this.go('cs-play', { run });
    } catch (err) {
      const e = err instanceof NetError ? err : null;
      if (e && (e.code === 'no_user' || e.code === 'rate_limited')) {
        this.go('cs-menu', { notice: e.message });
        return;
      }
      this.go('cs-error', {
        retryTo: 'cs-boot',
        message: e?.message ?? 'Could not start a run.',
      });
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
