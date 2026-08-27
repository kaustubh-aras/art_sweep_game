import Phaser from 'phaser';
import { C, FONT } from '@/clockshot/theme';
import { bakeTextures } from '@/clockshot/textures';
import { loadArt } from '@/clockshot/art';
import { store } from '@/clockshot/store';
import { whenChosen } from '@/clockshot/choice';
import type { LevelPostResponse } from '@/shared/api';
import { api, NetError } from '@/clockshot/net';
import { toArena } from '@/clockshot/build';
import { setLevelPost } from '@/clockshot/levelPost';
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
  /** Set when this post carries a level of its own. */
  private levelPost: LevelPostResponse | null = null;

  constructor() {
    super('cs-boot');
  }

  /**
   * Queues the illustrated artwork.
   *
   * Boot is the only screen that can afford to wait on a network fetch — it is
   * already a loading screen, and it is behind the splash card either way. Any
   * image that fails simply never registers its key, and the generated sprite
   * takes over.
   */
  preload(): void {
    loadArt(this);
  }

  create(): void {
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
      // Both at once: a level post still needs the community state, and the
      // level lookup is the same round trip either way.
      const [, post] = await Promise.all([
        store.refresh(),
        api.levelPost().catch(() => null),
      ]);
      if (post?.level) {
        this.levelPost = post;
        setLevelPost(post);
      }
    } catch {
      this.status.setText('could not reach the server');
      this.time.delayedCall(400, () => this.go('cs-error', { retryTo: 'cs-boot' }));
      return;
    }

    // Which door the player took decides where they land. Waiting for it costs
    // nothing: the card is still covering this screen, and everything that
    // could have made the tap feel slow — the state fetch, the textures — has
    // already happened.
    this.status.setText('ready when you are');
    const choice = await whenChosen();
    // A retry that came back through here has already moved on.
    if (this.done) return;

    if (choice === 'build') {
      this.go('cs-levels');
      return;
    }
    await this.startRun();
  }

  /**
   * Asks the server for a run, then drops the player straight into it.
   *
   * TAKE THE RUN means take the run. The menu is somewhere a player chooses to
   * go from the results screen, not a toll booth between the post and the game
   * — nobody tapped a button marked "take the run" hoping to be asked again,
   * next to a sound toggle.
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
      // A level post plays the arena it carries rather than the daily one. The
      // run is still the server's — it is scored, just onto that level's own
      // board — so only the geometry changes here.
      const post = this.levelPost;
      if (post?.level) {
        const arena = toArena(post.level);
        this.go('cs-play', { run, arena });
        return;
      }
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
