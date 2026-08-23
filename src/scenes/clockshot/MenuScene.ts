import Phaser from 'phaser';
import { C, FONT, hex, teamColor, teamName } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { activityLine, store, formatClock } from '@/clockshot/store';
import { Button, drawTeamBar, fadeTo, layoutOf, text } from '@/clockshot/ui';
import { api, NetError } from '@/clockshot/net';

/**
 * Main menu.
 *
 * The shared battle is the headline, not the game's own name: the first thing
 * on screen is who is winning and how long is left, because that is what makes
 * a player want to take a run right now rather than later.
 */
export class MenuScene extends Phaser.Scene {
  private bg!: Phaser.GameObjects.Graphics;
  private bar!: Phaser.GameObjects.Graphics;
  private title!: Phaser.GameObjects.Text;
  private tagline!: Phaser.GameObjects.Text;
  private redLabel!: Phaser.GameObjects.Text;
  private blueLabel!: Phaser.GameObjects.Text;
  private leaderLabel!: Phaser.GameObjects.Text;
  private roundLabel!: Phaser.GameObjects.Text;
  private prevLabel!: Phaser.GameObjects.Text;
  private youLabel!: Phaser.GameObjects.Text;
  private feedHeading!: Phaser.GameObjects.Text;
  private feedLabel!: Phaser.GameObjects.Text;

  private playBtn!: Button;
  private howBtn!: Button;
  private dashBtn!: Button;
  private soundBtn!: Button;

  private unsubscribe: (() => void) | null = null;
  private poll!: Phaser.Time.TimerEvent;
  private starting = false;

  constructor() {
    super('cs-menu');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    this.bg = this.add.graphics();
    this.bar = this.add.graphics();

    this.title = text(this, 0, 0, 'CLOCKSHOT', 34, C.gold);
    this.title.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.tagline = text(this, 0, 0, 'Swing. Shoot. Bank seconds for your team.', 12, C.dim);

    this.redLabel = text(this, 0, 0, 'RED 0s', 15, C.red, 'left');
    this.blueLabel = text(this, 0, 0, '0s BLUE', 15, C.blue, 'right');
    this.leaderLabel = text(this, 0, 0, '', 13, C.ink);
    this.roundLabel = text(this, 0, 0, '', 13, C.dim);
    this.prevLabel = text(this, 0, 0, '', 11, C.faint);
    this.youLabel = text(this, 0, 0, '', 12, C.dim);
    this.feedHeading = text(this, 0, 0, 'LATEST', 11, C.cyan, 'left');
    this.feedLabel = text(this, 0, 0, '', 10.5, C.dim, 'left');
    this.feedLabel.setAlign('left').setLineSpacing(6);

    this.playBtn = new Button(this, 0, 0, 'PLAY', { width: 240, filled: true, color: C.gold }, () =>
      this.onPlay(),
    );
    this.howBtn = new Button(this, 0, 0, 'HOW TO PLAY', { width: 240, color: C.cyan }, () =>
      fadeTo(this, () => this.scene.start('cs-howto')),
    );
    this.dashBtn = new Button(this, 0, 0, 'COMMUNITY', { width: 240, color: C.panelEdge }, () =>
      fadeTo(this, () => this.scene.start('cs-dash')),
    );
    this.soundBtn = new Button(this, 0, 0, this.soundCaption(), { width: 240, color: C.panelEdge }, () => {
      sfx.toggleMute();
      this.soundBtn.setCaption(this.soundCaption());
    });

    this.relayout();
    this.render();

    this.unsubscribe = store.onChange(() => this.render());
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);

    // Keep the battle live while the player sits on the menu.
    this.poll = this.time.addEvent({
      delay: 12_000,
      loop: true,
      callback: () => void store.refreshQuietly(),
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.poll.remove();
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
   * The run id and its clock both come from that call, so a player who has no
   * team, is rate limited, or is not logged in is turned away here rather than
   * after wasting thirty seconds.
   */
  private async onPlay(): Promise<void> {
    if (this.starting) return;

    if (!store.team) {
      fadeTo(this, () => this.scene.start('cs-team'));
      return;
    }

    this.starting = true;
    this.playBtn.setCaption('STARTING…').setEnabled(false);

    try {
      const run = await api.startRun();
      fadeTo(this, () => this.scene.start('cs-play', { run }));
    } catch (err) {
      this.starting = false;
      this.playBtn.setCaption('PLAY').setEnabled(true);

      if (err instanceof NetError && err.code === 'no_team') {
        fadeTo(this, () => this.scene.start('cs-team'));
        return;
      }
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

  private render(): void {
    const c = store.community;
    if (!c) return;

    this.redLabel.setText(`RED  ${c.banks.red}s`);
    this.blueLabel.setText(`${c.banks.blue}s  BLUE`);

    if (c.leader) {
      this.leaderLabel.setText(`${teamName(c.leader)} TEAM LEADS`).setColor(hex(teamColor(c.leader)));
    } else {
      this.leaderLabel.setText('DEAD LEVEL').setColor(hex(C.ink));
    }

    this.roundLabel.setText(
      `round ends in ${formatClock(store.msLeftInRound())}  ·  ${c.players} player${c.players === 1 ? '' : 's'}`,
    );

    const prev = c.previous;
    this.prevLabel.setText(
      prev === null
        ? 'first round in this community'
        : prev.draw
          ? `last round: a draw at ${prev.banks.red}s`
          : `last round: ${teamName(prev.winner!)} won ${prev.banks[prev.winner!]}s to ${prev.banks[prev.winner === 'red' ? 'blue' : 'red']}s`,
    );

    if (!store.username) {
      this.youLabel.setText('log in to Reddit to play').setColor(hex(C.dim));
      this.playBtn.setCaption('LOG IN TO PLAY').setEnabled(false);
    } else if (store.team) {
      this.youLabel
        .setText(`u/${store.username} · ${teamName(store.team)} · ${store.contribution}s this round`)
        .setColor(hex(teamColor(store.team)));
      this.playBtn.setCaption('PLAY').setEnabled(!this.starting);
    } else {
      this.youLabel.setText(`u/${store.username} · no team yet`).setColor(hex(C.dim));
      this.playBtn.setCaption('PICK A TEAM').setEnabled(true);
    }

    // The feed is what turns a menu into a place where other people have been.
    const lines = store.activity.slice(0, 5).map((a) => `· ${activityLine(a)}`);
    this.feedLabel.setText(
      lines.length > 0 ? lines.join('\n') : '· Nothing yet this round. Be the first.',
    );

    this.drawBars();
  }

  private drawBars(): void {
    const c = store.community;
    if (!c) return;
    const L = layoutOf(this);
    const w = L.iw - 36 * L.ui;
    drawTeamBar(this.bar, L.x + 18 * L.ui, this.barY(L), w, 16 * L.ui, c.banks.red, c.banks.blue);
  }

  private barY(L: ReturnType<typeof layoutOf>): number {
    return L.y + 96 * L.ui;
  }

  private relayout(): void {
    const L = layoutOf(this);
    const g = this.bg;
    g.clear();

    // The community panel, which owns the top of the screen.
    const panelH = 148 * L.ui;
    g.fillStyle(C.panel, 0.92);
    g.fillRoundedRect(L.x, L.y + 4 * L.ui, L.iw, panelH, 16 * L.ui);
    g.lineStyle(1.5, C.panelEdge, 0.6);
    g.strokeRoundedRect(L.x, L.y + 4 * L.ui, L.iw, panelH, 16 * L.ui);

    this.leaderLabel.setPosition(L.cx, L.y + 30 * L.ui).setFontSize(Math.round(14 * L.ui));
    this.redLabel.setPosition(L.x + 18 * L.ui, L.y + 66 * L.ui).setFontSize(Math.round(15 * L.ui));
    this.blueLabel.setPosition(L.x + L.iw - 18 * L.ui, L.y + 66 * L.ui).setFontSize(Math.round(15 * L.ui));
    this.roundLabel.setPosition(L.cx, L.y + 124 * L.ui).setFontSize(Math.round(12 * L.ui));
    this.prevLabel.setPosition(L.cx, L.y + 144 * L.ui).setFontSize(Math.round(10.5 * L.ui));

    const titleY = L.y + panelH + 54 * L.ui;
    this.title.setPosition(L.cx, titleY).setFontSize(Math.round(34 * L.ui));
    this.tagline.setPosition(L.cx, titleY + 28 * L.ui).setFontSize(Math.round(11.5 * L.ui));
    this.youLabel.setPosition(L.cx, titleY + 50 * L.ui).setFontSize(Math.round(11.5 * L.ui));

    // The feed fills the space between the title block and the buttons.
    const feedTop = titleY + 76 * L.ui;
    const feedBottom = L.y + L.ih - (52 * L.ui + 10 * L.ui) * 4 - 16 * L.ui;
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
    this.dashBtn.setPosition(L.cx, by);
    by -= bh + gap;
    this.howBtn.setPosition(L.cx, by);
    by -= bh + gap;
    this.playBtn.setPosition(L.cx, by);

    for (const b of [this.playBtn, this.howBtn, this.dashBtn, this.soundBtn]) {
      b.setSize(bw, bh).setFontSize(16 * L.ui);
    }

    this.drawBars();
  }

  update(): void {
    const c = store.community;
    if (!c) return;
    this.roundLabel.setText(
      `round ends in ${formatClock(store.msLeftInRound())}  ·  ${c.players} player${c.players === 1 ? '' : 's'}`,
    );
    // The moment a round runs out, pull the new one rather than showing 0:00.
    if (store.roundStale) void store.refreshQuietly();
  }
}
