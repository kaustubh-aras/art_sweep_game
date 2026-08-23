import Phaser from 'phaser';
import { C, FONT, hex, teamColor, teamName } from '@/clockshot/theme';
import { activityLine, formatClock, store } from '@/clockshot/store';
import { Button, drawTeamBar, fadeTo, layoutOf, text } from '@/clockshot/ui';

/**
 * The community battle dashboard.
 *
 * This is the screen that makes the game feel shared rather than solitary: the
 * two clocks, the round countdown, who is playing, and a live feed of what
 * other people have just done to the score.
 */
export class DashboardScene extends Phaser.Scene {
  private bg!: Phaser.GameObjects.Graphics;
  private bar!: Phaser.GameObjects.Graphics;
  private heading!: Phaser.GameObjects.Text;
  private leaderText!: Phaser.GameObjects.Text;
  private redText!: Phaser.GameObjects.Text;
  private blueText!: Phaser.GameObjects.Text;
  private roundText!: Phaser.GameObjects.Text;
  private prevText!: Phaser.GameObjects.Text;
  private feedHeading!: Phaser.GameObjects.Text;
  private feed!: Phaser.GameObjects.Text;

  private boardBtn!: Button;
  private playBtn!: Button;
  private backBtn!: Button;

  private unsubscribe: (() => void) | null = null;
  private poll!: Phaser.Time.TimerEvent;

  constructor() {
    super('cs-dash');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    this.bg = this.add.graphics();
    this.bar = this.add.graphics();

    this.heading = text(this, 0, 0, 'COMMUNITY BATTLE', 20, C.ink);
    this.heading.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.leaderText = text(this, 0, 0, '', 15, C.ink);
    this.redText = text(this, 0, 0, '', 16, C.red, 'left');
    this.blueText = text(this, 0, 0, '', 16, C.blue, 'right');
    this.roundText = text(this, 0, 0, '', 12, C.dim);
    this.prevText = text(this, 0, 0, '', 11, C.faint);
    this.feedHeading = text(this, 0, 0, 'RECENT ACTIVITY', 12, C.cyan, 'left');
    this.feed = text(this, 0, 0, '', 11, C.dim, 'left');
    this.feed.setAlign('left').setLineSpacing(6);

    this.playBtn = new Button(this, 0, 0, 'TAKE A RUN', { width: 240, filled: true, color: C.gold }, () =>
      fadeTo(this, () => this.scene.start('cs-menu')),
    );
    this.boardBtn = new Button(this, 0, 0, 'LEADERBOARD', { width: 240, color: C.cyan }, () =>
      fadeTo(this, () => this.scene.start('cs-leaderboard')),
    );
    this.backBtn = new Button(this, 0, 0, 'BACK', { width: 240, color: C.panelEdge }, () =>
      fadeTo(this, () => this.scene.start('cs-menu')),
    );

    this.render();
    this.relayout();

    this.unsubscribe = store.onChange(() => this.render());
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.poll = this.time.addEvent({
      delay: 8000,
      loop: true,
      callback: () => void store.refreshQuietly(),
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.poll.remove();
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
    });

    void store.refreshQuietly();
    this.cameras.main.fadeIn(200, 7, 11, 22);
  }

  private render(): void {
    const c = store.community;
    if (!c) return;

    this.redText.setText(`RED  ${c.banks.red}s`);
    this.blueText.setText(`${c.banks.blue}s  BLUE`);

    if (c.leader) {
      const lead = Math.abs(c.banks.red - c.banks.blue);
      this.leaderText
        .setText(`${teamName(c.leader)} LEADS BY ${lead}s`)
        .setColor(hex(teamColor(c.leader)));
    } else {
      this.leaderText.setText('DEAD LEVEL').setColor(hex(C.ink));
    }

    this.roundText.setText(
      `${formatClock(store.msLeftInRound())} left  ·  ${c.players} player${c.players === 1 ? '' : 's'} this round`,
    );

    const prev = c.previous;
    this.prevText.setText(
      prev === null
        ? 'no previous round yet'
        : prev.draw
          ? `previous round ended in a draw (${prev.banks.red}s each)`
          : `previous round: ${teamName(prev.winner!)} won ${prev.banks[prev.winner!]}s – ${prev.banks[prev.winner === 'red' ? 'blue' : 'red']}s`,
    );

    const lines = store.activity.slice(0, 9).map((a) => `· ${activityLine(a)}`);
    this.feed.setText(
      lines.length > 0 ? lines.join('\n') : 'Nothing yet this round.\nBe the first to bank some seconds.',
    );

    this.drawBar();
  }

  private drawBar(): void {
    const c = store.community;
    if (!c) return;
    const L = layoutOf(this);
    drawTeamBar(this.bar, L.x + 18 * L.ui, L.y + 108 * L.ui, L.iw - 36 * L.ui, 18 * L.ui, c.banks.red, c.banks.blue);
  }

  private relayout(): void {
    const L = layoutOf(this);
    const g = this.bg;
    g.clear();

    const topH = 178 * L.ui;
    g.fillStyle(C.panel, 0.92);
    g.fillRoundedRect(L.x, L.y, L.iw, topH, 16 * L.ui);
    g.lineStyle(1.5, C.panelEdge, 0.6);
    g.strokeRoundedRect(L.x, L.y, L.iw, topH, 16 * L.ui);

    const feedTop = L.y + topH + 14 * L.ui;
    const feedH = L.ih - topH - 14 * L.ui - 176 * L.ui;
    g.fillStyle(C.panel, 0.6);
    g.fillRoundedRect(L.x, feedTop, L.iw, Math.max(80 * L.ui, feedH), 14 * L.ui);

    this.heading.setPosition(L.cx, L.y + 26 * L.ui).setFontSize(Math.round(18 * L.ui));
    this.leaderText.setPosition(L.cx, L.y + 56 * L.ui).setFontSize(Math.round(15 * L.ui));
    this.redText.setPosition(L.x + 18 * L.ui, L.y + 88 * L.ui).setFontSize(Math.round(15 * L.ui));
    this.blueText.setPosition(L.x + L.iw - 18 * L.ui, L.y + 88 * L.ui).setFontSize(Math.round(15 * L.ui));
    this.roundText.setPosition(L.cx, L.y + 142 * L.ui).setFontSize(Math.round(11.5 * L.ui));
    this.prevText.setPosition(L.cx, L.y + 162 * L.ui).setFontSize(Math.round(10.5 * L.ui));

    this.feedHeading.setPosition(L.x + 18 * L.ui, feedTop + 18).setFontSize(Math.round(11.5 * L.ui));
    this.feed
      .setPosition(L.x + 18 * L.ui, feedTop + 38)
      .setOrigin(0, 0)
      .setFontSize(Math.round(10.5 * L.ui))
      .setWordWrapWidth(L.iw - 36 * L.ui);

    const bw = Math.min(300 * L.ui, L.iw - 40 * L.ui);
    const bh = 50 * L.ui;
    const gap = 9 * L.ui;
    let by = L.y + L.ih - bh / 2 - 4 * L.ui;
    this.backBtn.setPosition(L.cx, by).setSize(bw, bh);
    by -= bh + gap;
    this.boardBtn.setPosition(L.cx, by).setSize(bw, bh);
    by -= bh + gap;
    this.playBtn.setPosition(L.cx, by).setSize(bw, bh);

    this.drawBar();
  }

  update(): void {
    if (!store.community) return;
    this.roundText.setText(
      `${formatClock(store.msLeftInRound())} left  ·  ${store.community.players} player${store.community.players === 1 ? '' : 's'} this round`,
    );
    if (store.roundStale) void store.refreshQuietly();
  }
}
