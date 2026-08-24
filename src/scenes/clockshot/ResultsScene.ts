import Phaser from 'phaser';
import { C, FONT, hex, teamColor, teamName } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { activityLine, store } from '@/clockshot/store';
import { api, NetError, withRetry } from '@/clockshot/net';
import { Button, drawTeamBar, fadeTo, layoutOf, text } from '@/clockshot/ui';
import { SCORE, type Team } from '@/shared/config';
import type { RunFinishResponse, RunTally } from '@/shared/api';
import { attachTapProxy, type TapProxy } from '@/clockshot/immersive';

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
  /** Null until the player picks a side — see `askForTeam`. */
  private team!: Team | null;

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
  /** Shown only on a first run, in place of the buttons above. */
  private redBtn!: Button;
  private blueBtn!: Button;
  private choosing = false;

  /** See MenuScene: PLAY AGAIN is the other way into a run. */
  private playProxy: TapProxy | null = null;

  private result: RunFinishResponse | null = null;
  private submitting = false;
  private failed = false;
  /**
   * True when the server refused the run for a reason that will never change.
   *
   * This has to be its own flag rather than being inferred from `result`, which
   * is only ever set on success: testing `!result` treats every failure as
   * permanent, and the retry path below then becomes unreachable.
   */
  private permanent = false;

  constructor() {
    super('cs-results');
  }

  init(data: { runId: string; tally: RunTally; team: Team | null }): void {
    this.runId = data.runId;
    this.tally = data.tally;
    this.team = data.team;
    this.result = null;
    this.submitting = false;
    this.failed = false;
    this.permanent = false;
    this.choosing = data.team === null;
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

    this.redBtn = new Button(this, 0, 0, 'RED TEAM', { width: 240, filled: true, color: C.red }, () =>
      this.chooseTeam('red'),
    );
    this.blueBtn = new Button(this, 0, 0, 'BLUE TEAM', { width: 240, filled: true, color: C.blue }, () =>
      this.chooseTeam('blue'),
    );
    // Whichever set of buttons this screen is not using has to start hidden,
    // or both stacks paint on top of each other for the first frame.
    this.showChoice(this.choosing);

    this.renderLocal();
    this.relayout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.playProxy = attachTapProxy(this, this.againBtn);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
      this.playProxy?.destroy();
    });

    this.cameras.main.fadeIn(220, 7, 11, 22);

    // A first run has no side yet, so nothing is banked until the player says
    // where it goes. Everyone else banks immediately.
    if (this.choosing) this.askForTeam();
    else void this.submit();
  }

  /* ---------------------------------------------------------------------- */
  /* Choosing a side                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * The first-run moment: the player has something in their hands before they
   * are asked to commit to anything.
   */
  private askForTeam(): void {
    const earned = this.localEarned();
    this.heading.setText(earned > 0 ? 'WHO GETS THESE SECONDS?' : 'CHOOSE A SIDE');
    this.statusText
      .setText('your seconds go into that team’s shared clock')
      .setColor(hex(C.dim));
    this.showChoice(true);
  }

  private showChoice(on: boolean): void {
    this.redBtn.setVisible(on);
    this.blueBtn.setVisible(on);
    for (const b of [this.againBtn, this.boardBtn, this.menuBtn, this.shareBtn]) {
      b.setVisible(!on);
    }
    // Hiding the button has to hide what sits on top of it, or the team choice
    // is taken through an invisible stand-in for a button that is not there.
    this.playProxy?.sync();
  }

  private chooseTeam(team: Team): void {
    if (!this.choosing) return;
    this.choosing = false;
    this.team = team;
    store.setTeam(team);
    this.showChoice(false);
    this.heading.setText('RUN COMPLETE');
    this.renderLocal();
    this.relayout();
    void this.submit();
  }

  /** What the local tally is worth, before the server has its say. */
  private localEarned(): number {
    const t = this.tally;
    return (
      t.fragments * SCORE.fragment +
      t.goldenClocks * SCORE.goldenClock +
      t.enemyFragments * SCORE.enemyFragment
    );
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
      // Four attempts rather than three: the backoff then spans ~2.8s, which
      // comfortably covers the 1.2s early-grace window if this run reached the
      // server a moment before its clock said it was done.
      const res = await withRetry(
        () => api.finishRun(this.runId, this.tally, this.team ?? undefined),
        4,
      );
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
      // A run the server refused outright is gone; retrying it will never work,
      // so the button becomes "back to menu" rather than a pointless retry.
      // Anything else — a dropped connection, a timeout — is worth another go,
      // and losing thirty seconds of play to one bad packet is the worst thing
      // this game could do.
      this.permanent =
        e !== null &&
        (e.code === 'run_duplicate' || e.code === 'run_expired' || e.code === 'round_changed');

      this.statusText
        .setText(e?.message ?? 'Could not reach the server.')
        .setColor(hex(this.permanent ? C.gold : C.danger));

      this.shareBtn.setCaption(this.permanent ? 'BACK TO MENU' : 'RETRY BANKING');
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
    if (this.permanent) {
      // Nothing was banked and nothing can be; go back rather than pretending
      // it counted. A recoverable failure keeps the run, so it falls through
      // and the player can still start a fresh one.
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
    // Order matters: only a *permanent* refusal sends the player away. A
    // recoverable failure has to fall through to the retry, which is the whole
    // point of the button saying "RETRY BANKING".
    if (this.permanent) {
      fadeTo(this, () => this.scene.start('cs-menu'));
      return;
    }
    if (this.failed) {
      void this.submit();
      return;
    }

    const r = this.result;
    if (!r || !this.team) return;
    const c = r.community;
    const line = [
      `I banked ${r.awarded + r.stolen}s for ${teamName(this.team)} Team in Clockshot. `,
      `Red ${c.banks.red}s vs Blue ${c.banks.blue}s — come take a run.`,
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

  /**
   * What we can show before the server answers, from the local tally.
   *
   * Three rows, not ten. The old breakdown listed every counter the game keeps
   * — including two kinds of penalty — and a beginner read it as a report card.
   * These are the only lines that describe something the player chose to do.
   */
  private renderLocal(): void {
    const t = this.tally;
    const rows: string[] = [`clocks         ${t.fragments}`];
    if (t.goldenClocks > 0) rows.push(`golden clocks  ${t.goldenClocks}`);
    if (t.enemyFragments > 0) rows.push(`stolen clocks  ${t.enemyFragments}`);
    this.breakdown.setText(rows.join('\n'));

    this.scoreText
      .setText(`+${this.localEarned()}s`)
      .setColor(hex(this.team ? teamColor(this.team) : C.gold));
  }

  private renderResult(r: RunFinishResponse): void {
    const c = r.community;

    // One number. `awarded` and `stolen` land in different banks, but they do
    // the same thing to the only question the player actually asked — did my
    // run help my team — so the screen answers it once instead of three times.
    const banked = r.awarded + r.stolen;
    const side = this.team ? teamName(this.team) : 'YOUR';

    this.scoreText
      .setText(`+${banked}s`)
      .setColor(hex(this.team ? teamColor(this.team) : C.gold));
    this.heading.setText(banked > 0 ? 'SECONDS BANKED' : 'RUN COMPLETE');

    this.communityText.setText(
      `banked for ${side} TEAM\nRED ${c.banks.red}s   ·   BLUE ${c.banks.blue}s`,
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

    // The rule above applies to the breakdown too, not just the feed. It used
    // to be placed unconditionally, and a ten-row column ran a good 60px under
    // the buttons on a short screen.
    this.breakdown.setVisible(columnTop + this.breakdown.height <= buttonsTop);

    const breakdownBottom = this.breakdown.visible
      ? columnTop + this.breakdown.height
      : columnTop;
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

    // The two side buttons share the bottom of the stack when they are up, so
    // the choice sits exactly where the thumb already is.
    const cbh = 58 * L.ui;
    let cy = L.y + L.ih - cbh / 2 - 4 * L.ui;
    this.blueBtn.setPosition(L.cx, cy).setSize(bw, cbh).setFontSize(18 * L.ui);
    cy -= cbh + 12 * L.ui;
    this.redBtn.setPosition(L.cx, cy).setSize(bw, cbh).setFontSize(18 * L.ui);

    const statusY = this.choosing ? cy - cbh / 2 - 16 * L.ui : by - bh / 2 - 16 * L.ui;
    this.statusText.setPosition(L.cx, statusY).setFontSize(Math.round(11 * L.ui));

    this.playProxy?.sync();
    this.drawBar();
  }
}
