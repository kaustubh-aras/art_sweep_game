import Phaser from 'phaser';
import { C, FONT, hex } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { activityLine, formatClock, formatPoints, store } from '@/clockshot/store';
import { Button, fadeTo, layoutOf, text } from '@/clockshot/ui';
import { api, NetError } from '@/clockshot/net';
import { attachTapProxy, type TapProxy } from '@/clockshot/immersive';
import { arenaAt } from '@/clockshot/arena';
import { arenaIndexAt, START_TIME_MS } from '@/shared/config';

/**
 * Main menu.
 *
 * The board is the headline, not the game's own name: the first thing on screen
 * is the score to beat and how long is left to beat it, because that is what
 * makes a player take a run right now rather than later.
 */
export class MenuScene extends Phaser.Scene {
  private bg!: Phaser.GameObjects.Graphics;
  private title!: Phaser.GameObjects.Text;
  private tagline!: Phaser.GameObjects.Text;
  private topLabel!: Phaser.GameObjects.Text;
  private arenaLabel!: Phaser.GameObjects.Text;
  private windowLabel!: Phaser.GameObjects.Text;
  private prevLabel!: Phaser.GameObjects.Text;
  private youLabel!: Phaser.GameObjects.Text;
  private feedHeading!: Phaser.GameObjects.Text;
  private feedLabel!: Phaser.GameObjects.Text;

  private playBtn!: Button;
  private buildBtn!: Button;
  private howBtn!: Button;
  private boardBtn!: Button;
  private soundBtn!: Button;

  /** Present wherever full screen can be had; PLAY is the tap that asks. */
  private playProxy: TapProxy | null = null;
  /**
   * The same, for the builder.
   *
   * Building wants the screen at least as much as playing does — it is a grid
   * and a palette on a phone — and this is the only tap on the way in that the
   * DOM ever sees.
   */
  private buildProxy: TapProxy | null = null;

  private unsubscribe: (() => void) | null = null;
  private poll!: Phaser.Time.TimerEvent;
  private starting = false;

  constructor() {
    super('cs-menu');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    this.bg = this.add.graphics();

    this.title = text(this, 0, 0, 'CLOCKSHOT', 34, C.gold);
    this.title.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.tagline = text(
      this,
      0,
      0,
      `${START_TIME_MS / 1000} seconds. Swing. Reach the goal.`,
      12,
      C.dim,
    );

    this.topLabel = text(this, 0, 0, '', 17, C.gold);
    this.arenaLabel = text(this, 0, 0, '', 13, C.cyan);
    this.windowLabel = text(this, 0, 0, '', 12, C.dim);
    this.prevLabel = text(this, 0, 0, '', 10.5, C.faint);
    this.youLabel = text(this, 0, 0, '', 12, C.dim);
    this.feedHeading = text(this, 0, 0, 'LATEST', 11, C.cyan, 'left');
    this.feedLabel = text(this, 0, 0, '', 10.5, C.dim, 'left');
    this.feedLabel.setAlign('left').setLineSpacing(6);

    this.playBtn = new Button(this, 0, 0, 'PLAY', { width: 240, filled: true, color: C.gold }, () =>
      this.onPlay(),
    );
    // Building needs no server and no login: it is the one thing here a player
    // can do while the board is between windows or their connection is out.
    this.buildBtn = new Button(this, 0, 0, 'BUILD A LEVEL', { width: 240, color: C.good }, () =>
      fadeTo(this, () => this.scene.start('cs-levels')),
    );
    this.howBtn = new Button(this, 0, 0, 'HOW TO PLAY', { width: 240, color: C.cyan }, () =>
      fadeTo(this, () => this.scene.start('cs-howto')),
    );
    this.boardBtn = new Button(this, 0, 0, 'LEADERBOARD', { width: 240, color: C.panelEdge }, () =>
      fadeTo(this, () => this.scene.start('cs-leaderboard')),
    );
    this.soundBtn = new Button(
      this,
      0,
      0,
      this.soundCaption(),
      { width: 240, color: C.panelEdge },
      () => {
        sfx.toggleMute();
        this.soundBtn.setCaption(this.soundCaption());
      },
    );

    this.relayout();
    this.render();

    this.unsubscribe = store.onChange(() => this.render());
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);

    // The one tap a player is guaranteed to make before a run is PLAY, so that
    // is the tap that carries the request to take over the screen.
    this.playProxy = attachTapProxy(this, this.playBtn);
    this.buildProxy = attachTapProxy(this, this.buildBtn);

    // Keep the board live while the player sits on the menu.
    this.poll = this.time.addEvent({
      delay: 12_000,
      loop: true,
      callback: () => void store.refreshQuietly(),
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.poll.remove();
      this.playProxy?.destroy();
      this.buildProxy?.destroy();
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
    });

    this.cameras.main.fadeIn(200, 7, 11, 22);
  }

  private soundCaption(): string {
    return sfx.isMuted ? 'SOUND: OFF' : 'SOUND: ON';
  }

  /**
   * Starts a run — but only after the server has agreed to one.
   *
   * The run id, its seed and its arena all come from that call, so a player who
   * is rate limited or not logged in is turned away here rather than after
   * wasting a run.
   */
  private async onPlay(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.playBtn.setCaption('STARTING…').setEnabled(false);

    try {
      const run = await api.startRun();
      fadeTo(this, () => this.scene.start('cs-play', { run }));
    } catch (err) {
      this.starting = false;
      this.playBtn.setCaption('PLAY').setEnabled(true);

      if (err instanceof NetError && err.code === 'rate_limited') {
        this.youLabel.setText(err.message).setColor(hex(C.gold));
        void store.refreshQuietly();
        return;
      }
      this.scene.start('cs-error', {
        retryTo: 'cs-menu',
        message: err instanceof NetError ? err.message : 'Could not start a run.',
      });
    }
  }

  /** Naming the arena is what turns "a window" into a place. */
  private windowLine(): string {
    const b = store.board;
    if (!b) return '';
    return [
      `resets in ${formatClock(store.msLeftInWindow())}`,
      `${b.players} player${b.players === 1 ? '' : 's'}`,
    ].join('  ·  ');
  }

  private render(): void {
    const b = store.board;
    if (!b) return;

    const arena = arenaAt(arenaIndexAt(b.roundIndex));
    this.arenaLabel.setText(`${arena.name}  ·  ${arena.blurb}`);

    this.topLabel.setText(
      b.topScore === null
        ? 'NO SCORE YET — BE FIRST'
        : `TOP  ${formatPoints(b.topScore)}  ·  u/${b.topPlayer}`,
    );
    this.windowLabel.setText(this.windowLine());

    const prev = b.previous;
    this.prevLabel.setText(
      prev === null || prev.topScore === null
        ? 'first board in this community'
        : `last board: u/${prev.topPlayer} won it with ${formatPoints(prev.topScore)}`,
    );

    if (!store.username) {
      this.youLabel.setText('log in to Reddit to play').setColor(hex(C.dim));
      this.playBtn.setCaption('LOG IN TO PLAY').setEnabled(false);
    } else {
      const rank = store.rank !== null ? `  ·  #${store.rank}` : '';
      this.youLabel
        .setText(
          store.best > 0
            ? `u/${store.username}  ·  best ${formatPoints(store.best)}${rank}`
            : `u/${store.username}  ·  no score yet`,
        )
        .setColor(hex(store.best > 0 ? C.gold : C.dim));
      this.playBtn.setCaption('PLAY').setEnabled(!this.starting);
    }

    // The feed is what turns a menu into a place where other people have been.
    const lines = store.activity.slice(0, 5).map((a) => `· ${activityLine(a)}`);
    this.feedLabel.setText(lines.join('\n'));
  }

  private relayout(): void {
    const L = layoutOf(this);
    const g = this.bg;
    g.clear();

    // The board panel, which owns the top of the screen.
    const panelH = 132 * L.ui;
    g.fillStyle(C.panel, 0.92);
    g.fillRoundedRect(L.x, L.y + 4 * L.ui, L.iw, panelH, 16 * L.ui);
    g.lineStyle(1.5, C.panelEdge, 0.6);
    g.strokeRoundedRect(L.x, L.y + 4 * L.ui, L.iw, panelH, 16 * L.ui);

    this.topLabel.setPosition(L.cx, L.y + 36 * L.ui).setFontSize(Math.round(17 * L.ui));
    this.arenaLabel.setPosition(L.cx, L.y + 66 * L.ui).setFontSize(Math.round(11.5 * L.ui));
    this.windowLabel.setPosition(L.cx, L.y + 94 * L.ui).setFontSize(Math.round(12 * L.ui));
    this.prevLabel.setPosition(L.cx, L.y + 118 * L.ui).setFontSize(Math.round(10.5 * L.ui));

    const titleY = L.y + panelH + 52 * L.ui;
    this.title.setPosition(L.cx, titleY).setFontSize(Math.round(34 * L.ui));
    this.tagline.setPosition(L.cx, titleY + 28 * L.ui).setFontSize(Math.round(11.5 * L.ui));
    this.youLabel.setPosition(L.cx, titleY + 50 * L.ui).setFontSize(Math.round(11.5 * L.ui));

    // The feed fills the space between the title block and the buttons.
    const feedTop = titleY + 76 * L.ui;
    const feedBottom = L.y + L.ih - (52 * L.ui + 10 * L.ui) * 5 - 16 * L.ui;
    const feedH = Math.max(0, feedBottom - feedTop);
    const showFeed = feedH > 76 * L.ui;

    this.feedHeading.setVisible(showFeed);
    this.feedLabel.setVisible(showFeed);
    if (showFeed) {
      g.fillStyle(C.panel, 0.5);
      g.fillRoundedRect(L.x, feedTop, L.iw, feedH, 14 * L.ui);
      this.feedHeading
        .setPosition(L.x + 16 * L.ui, feedTop + 16 * L.ui)
        .setFontSize(Math.round(10.5 * L.ui));
      this.feedLabel
        .setPosition(L.x + 16 * L.ui, feedTop + 34 * L.ui)
        .setOrigin(0, 0)
        .setFontSize(Math.round(10 * L.ui))
        .setWordWrapWidth(L.iw - 32 * L.ui);
    }

    // Buttons stack up from the bottom so the thumb reaches PLAY first.
    const bw = Math.min(300 * L.ui, L.iw - 40 * L.ui);
    const bh = 52 * L.ui;
    const gap = 10 * L.ui;
    let by = L.y + L.ih - bh / 2 - 6 * L.ui;

    this.soundBtn.setPosition(L.cx, by);
    by -= bh + gap;
    this.boardBtn.setPosition(L.cx, by);
    by -= bh + gap;
    this.howBtn.setPosition(L.cx, by);
    by -= bh + gap;
    this.buildBtn.setPosition(L.cx, by);
    by -= bh + gap;
    this.playBtn.setPosition(L.cx, by);

    for (const b of [this.playBtn, this.buildBtn, this.howBtn, this.boardBtn, this.soundBtn]) {
      b.setSize(bw, bh).setFontSize(16 * L.ui);
    }

    // A proxy that did not follow the re-layout would take taps where the
    // button no longer is.
    this.playProxy?.sync();
    this.buildProxy?.sync();
  }

  update(): void {
    if (!store.board) return;
    this.windowLabel.setText(this.windowLine());
    // The moment a window runs out, pull the new one rather than showing 0:00.
    if (store.windowStale) void store.refreshQuietly();
  }
}
