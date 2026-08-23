import Phaser from 'phaser';
import { C, FONT, hex, teamColor, teamName } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { activityLine, store } from '@/clockshot/store';
import { api, NetError, withRetry } from '@/clockshot/net';
import { Button, drawTeamBar, fadeTo, layoutOf, text } from '@/clockshot/ui';
import { SCORE, type Team } from '@/shared/config';
import type { RunFinishResponse, RunTally } from '@/shared/api';

/**
 * Run results, and the moment the run actually counts.
 *
 * Banking happens here rather than at the end of gameplay so the player is
 * looking at a screen that can explain a failure. Losing thirty seconds of
 * play to one dropped request is the worst thing this game could do, so the
 * submit retries, and if it still fails the run is offered again by hand.
 */
export class ResultsScene extends Phaser.Scene {
  private runId!: string;
  private tally!: RunTally;
  private team!: Team;

  private bg!: Phaser.GameObjects.Graphics;
  private bar!: Phaser.GameObjects.Graphics;
  private heading!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private breakdown!: Phaser.GameObjects.Text;
  private communityText!: Phaser.GameObjects.Text;
  private rankText!: Phaser.GameObjects.Text;
  private feedText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  private againBtn!: Button;
  private boardBtn!: Button;
  private menuBtn!: Button;
  private shareBtn!: Button;

  private result: RunFinishResponse | null = null;
  private submitting = false;
  private failed = false;

  constructor() {
    super('cs-results');
  }

  init(data: { runId: string; tally: RunTally; team: Team }): void {
    this.runId = data.runId;
    this.tally = data.tally;
    this.team = data.team;
    this.result = null;
    this.submitting = false;
    this.failed = false;
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    this.bg = this.add.graphics();
    this.bar = this.add.graphics();

    this.heading = text(this, 0, 0, 'RUN COMPLETE', 22, C.gold);
    this.heading.setStyle({ fontFamily: FONT, fontStyle: 'bold' });

    this.scoreText = text(this, 0, 0, '…', 40, C.ink);
    this.breakdown = text(this, 0, 0, '', 12, C.dim);
    this.breakdown.setAlign('left').setLineSpacing(5);
    this.communityText = text(this, 0, 0, '', 12.5, C.dim);
    this.rankText = text(this, 0, 0, '', 12, C.dim);
    this.feedText = text(this, 0, 0, '', 11, C.faint);
    this.feedText.setAlign('left').setLineSpacing(5);
    this.statusText = text(this, 0, 0, 'banking your seconds…', 12, C.cyan);

    this.againBtn = new Button(this, 0, 0, 'PLAY AGAIN', { width: 240, filled: true, color: C.gold }, () =>
      this.playAgain(),
    );
    this.boardBtn = new Button(this, 0, 0, 'LEADERBOARD', { width: 240, color: C.cyan }, () =>
      fadeTo(this, () => this.scene.start('cs-leaderboard')),
    );
    this.menuBtn = new Button(this, 0, 0, 'MENU', { width: 240, color: C.panelEdge }, () =>
      fadeTo(this, () => this.scene.start('cs-menu')),
    );
    this.shareBtn = new Button(this, 0, 0, 'COPY SHARE TEXT', { width: 240, color: C.panelEdge }, () =>
      void this.share(),
    );

    this.renderLocal();
    this.relayout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
    });

    this.cameras.main.fadeIn(220, 7, 11, 22);
    void this.submit();
  }

  /* ---------------------------------------------------------------------- */
  /* Submission                                                              */
  /* ---------------------------------------------------------------------- */

  private async submit(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    this.failed = false;
    this.statusText.setText('banking your seconds…').setColor(hex(C.cyan));
    this.againBtn.setEnabled(false);

    try {
      const res = await withRetry(() => api.finishRun(this.runId, this.tally));
      this.result = res;
      store.applyCommunity(res.community, res.activity);
      store.contribution = res.you.contribution;
      store.rank = res.you.rank;

      this.statusText.setText('banked').setColor(hex(C.good));
      this.renderResult(res);

      if (res.leadChanged) {
        sfx.leadChange();
        this.flashLead(res.community.leader);
      } else if (res.awarded > 0) {
        sfx.victory();
      }
    } catch (err) {
      this.submitting = false;
      this.failed = true;
      this.againBtn.setEnabled(true);

      const e = err instanceof NetError ? err : null;
      // A run the server refused is gone; retrying it will never work, so the
      // button becomes "play again" rather than a pointless retry.
      const permanent =
        e !== null &&
        (e.code === 'run_duplicate' || e.code === 'run_expired' || e.code === 'round_changed');

      this.statusText
        .setText(e?.message ?? 'Could not reach the server.')
        .setColor(hex(permanent ? C.gold : C.danger));

      this.shareBtn.setCaption(permanent ? 'BACK TO MENU' : 'RETRY BANKING');
      void store.refreshQuietly();
      return;
    }

    this.submitting = false;
    this.againBtn.setEnabled(true);
  }

  private flashLead(leader: Team | null): void {
    if (!leader) return;
    const L = layoutOf(this);
    const t = text(this, L.cx, L.y + L.ih * 0.42, `${teamName(leader)} TAKES THE LEAD`, 20, teamColor(leader));
    t.setDepth(50);
    this.tweens.add({
      targets: t,
      alpha: 0,
      y: t.y - 40 * L.ui,
      duration: 1600,
      ease: 'Cubic.out',
      onComplete: () => t.destroy(),
    });
  }

  private async playAgain(): Promise<void> {
    if (this.failed && !this.result) {
      // Nothing was banked; go back rather than pretending it counted.
      fadeTo(this, () => this.scene.start('cs-menu'));
      return;
    }
    this.againBtn.setCaption('STARTING…').setEnabled(false);
    try {
      const run = await api.startRun();
      fadeTo(this, () => this.scene.start('cs-play', { run }));
    } catch (err) {
      this.againBtn.setCaption('PLAY AGAIN').setEnabled(true);
      this.statusText
        .setText(err instanceof NetError ? err.message : 'Could not start another run.')
        .setColor(hex(C.gold));
      void store.refreshQuietly();
    }
  }

  /** Puts a ready-made comment on the clipboard. */
  private async share(): Promise<void> {
    if (this.failed && !this.result) {
      fadeTo(this, () => this.scene.start('cs-menu'));
      return;
    }
    if (this.failed) {
      void this.submit();
      return;
    }

    const r = this.result;
    if (!r) return;
    const c = r.community;
    const line = [
      `I banked ${r.awarded}s for ${teamName(this.team)} Team in Clockshot`,
      r.stolen > 0 ? ` and stole ${r.stolen}s from the other side` : '',
      `. Red ${c.banks.red}s vs Blue ${c.banks.blue}s — come take a run.`,
    ].join('');

    try {
      await navigator.clipboard.writeText(line);
      this.shareBtn.setCaption('COPIED');
      this.time.delayedCall(1400, () => this.shareBtn.setCaption('COPY SHARE TEXT'));
    } catch {
      // Clipboard access is often blocked inside an embedded web view; showing
      // the text is the useful fallback.
      this.statusText.setText(line).setColor(hex(C.dim));
      this.shareBtn.setCaption('SHOWN ABOVE');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  /** What we can show before the server answers, from the local tally. */
  private renderLocal(): void {
    const t = this.tally;
    const gained =
      t.fragments * SCORE.fragment +
      t.largeFragments * SCORE.largeFragment +
      t.goldenClocks * SCORE.goldenClock +
      t.enemyKills * SCORE.enemyKill;
    const lost = t.hazardHits * SCORE.hazardPenalty + t.falls * SCORE.fallPenalty;

    this.breakdown.setText(
      [
        `fragments      ${t.fragments}`,
        `large clocks   ${t.largeFragments}`,
        `golden clocks  ${t.goldenClocks}`,
        `enemies down   ${t.enemyKills}`,
        `stolen clocks  ${t.enemyFragments}`,
        `hazards hit    ${t.hazardHits}`,
        `falls          ${t.falls}`,
        `                    `,
        `collected      +${gained}s`,
        `penalties      -${lost}s`,
      ].join('\n'),
    );
    this.scoreText.setText(`+${Math.max(0, gained - lost)}s`).setColor(hex(teamColor(this.team)));
  }

  private renderResult(r: RunFinishResponse): void {
    const c = r.community;

    this.scoreText.setText(`+${r.awarded}s`).setColor(hex(teamColor(this.team)));
    this.heading.setText(r.awarded > 0 ? 'SECONDS BANKED' : 'RUN COMPLETE');

    const stolenLine = r.stolen > 0 ? `  ·  stole ${r.stolen}s` : '';
    this.communityText.setText(
      `${teamName(this.team)} TEAM  +${r.awarded}s${stolenLine}\nRED ${c.banks.red}s   ·   BLUE ${c.banks.blue}s`,
    );
    this.communityText.setAlign('center').setLineSpacing(5);

    this.rankText.setText(
      [
        `your round total  ${r.you.contribution}s`,
        r.you.rank !== null ? `community rank  #${r.you.rank}` : 'not yet ranked this round',
      ].join('   ·   '),
    );

    this.feedText.setText(
      r.activity
        .slice(0, 4)
        .map((a) => `· ${activityLine(a)}`)
        .join('\n'),
    );

    if (r.adjusted) {
      // Being open about a correction beats silently changing someone's score.
      this.statusText.setText('banked (score adjusted by the server)').setColor(hex(C.gold));
    }

    this.drawBar();
  }

  private drawBar(): void {
    const c = this.result?.community ?? store.community;
    if (!c) return;
    const L = layoutOf(this);
    drawTeamBar(this.bar, L.x + 18 * L.ui, L.y + 176 * L.ui, L.iw - 36 * L.ui, 14 * L.ui, c.banks.red, c.banks.blue);
  }

  private relayout(): void {
    const L = layoutOf(this);
    const g = this.bg;
    g.clear();
    g.fillStyle(C.panel, 0.55);
    g.fillRoundedRect(L.x, L.y + 96 * L.ui, L.iw, 116 * L.ui, 14 * L.ui);

    this.heading.setPosition(L.cx, L.y + 30 * L.ui).setFontSize(Math.round(20 * L.ui));
    this.scoreText.setPosition(L.cx, L.y + 66 * L.ui).setFontSize(Math.round(38 * L.ui));
    this.communityText.setPosition(L.cx, L.y + 126 * L.ui).setFontSize(Math.round(12 * L.ui));
    this.rankText.setPosition(L.cx, L.y + 200 * L.ui).setFontSize(Math.round(11 * L.ui));

    const bw = Math.min(300 * L.ui, L.iw - 40 * L.ui);
    const bh = 50 * L.ui;
    const gap = 9 * L.ui;
    let by = L.y + L.ih - bh / 2 - 4 * L.ui;

    // The button stack owns the bottom of the screen; everything above it has
    // to fit in what is left, or be dropped. Text running under a button is
    // worse than text that is not there.
    const buttonsTop = by - bh * 3.5 - gap * 3;
    const columnTop = L.y + 226 * L.ui;

    this.breakdown
      .setPosition(L.x + 20 * L.ui, columnTop)
      .setOrigin(0, 0)
      .setFontSize(Math.round(11 * L.ui));

    const breakdownBottom = columnTop + this.breakdown.height;
    const feedTop = breakdownBottom + 14 * L.ui;
    const feedRoom = buttonsTop - feedTop;

    this.feedText.setVisible(feedRoom > 34 * L.ui);
    this.feedText
      .setPosition(L.x + 20 * L.ui, feedTop)
      .setOrigin(0, 0)
      .setFontSize(Math.round(10.5 * L.ui))
      .setWordWrapWidth(L.iw - 40 * L.ui);

    this.menuBtn.setPosition(L.cx, by).setSize(bw, bh);
    by -= bh + gap;
    this.shareBtn.setPosition(L.cx, by).setSize(bw, bh);
    by -= bh + gap;
    this.boardBtn.setPosition(L.cx, by).setSize(bw, bh);
    by -= bh + gap;
    this.againBtn.setPosition(L.cx, by).setSize(bw, bh);

    this.statusText.setPosition(L.cx, by - bh / 2 - 16 * L.ui).setFontSize(Math.round(11 * L.ui));

    this.drawBar();
  }
}
