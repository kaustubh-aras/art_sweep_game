import Phaser from 'phaser';
import { C, FONT, hex } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { activityLine, formatPoints, store } from '@/clockshot/store';
import { api, NetError, withRetry } from '@/clockshot/net';
<<<<<<< HEAD
import { Button, fadeTo, layoutOf, text } from '@/clockshot/ui';
import { SCORE } from '@/shared/config';
=======
import { Button, drawTeamBar, fadeTo, fitText, layoutOf, text } from '@/clockshot/ui';
import { SCORE, type Team } from '@/shared/config';
>>>>>>> feat/fullScreen
import type { RunFinishResponse, RunTally } from '@/shared/api';
import { attachTapProxy, type TapProxy } from '@/clockshot/immersive';

/**
 * Run results, and the moment the run actually counts.
 *
 * Scoring happens here rather than at the end of gameplay so the player is
 * looking at a screen that can explain a failure. Losing a run to one dropped
 * request is the worst thing this game could do, so the submit retries, and if
 * it still fails the run is offered again by hand.
 */
export class ResultsScene extends Phaser.Scene {
  private runId!: string;
  private tally!: RunTally;

  private bg!: Phaser.GameObjects.Graphics;
  private heading!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private breakdown!: Phaser.GameObjects.Text;
  private standingText!: Phaser.GameObjects.Text;
  private feedText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  private againBtn!: Button;
  private boardBtn!: Button;
  private menuBtn!: Button;

<<<<<<< HEAD
  /** Kept so a re-layout after the server answers can redraw from the result. */
=======
  /** See MenuScene: PLAY AGAIN is the other way into a run. */
  private playProxy: TapProxy | null = null;

>>>>>>> feat/fullScreen
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

  init(data: { runId: string; tally: RunTally }): void {
    this.runId = data.runId;
    this.tally = data.tally;
    this.result = null;
    this.submitting = false;
    this.failed = false;
    this.permanent = false;
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    this.bg = this.add.graphics();

    const won = this.tally.reachedGoal;

    this.heading = text(this, 0, 0, won ? 'GOAL REACHED' : 'OUT OF TIME', 22, won ? C.goal : C.danger);
    this.heading.setStyle({ fontFamily: FONT, fontStyle: 'bold' });

    this.scoreText = text(this, 0, 0, '…', 40, won ? C.gold : C.faint);
    this.breakdown = text(this, 0, 0, '', 12, C.dim);
    this.breakdown.setAlign('left').setLineSpacing(6);
    this.standingText = text(this, 0, 0, '', 12, C.dim);
    this.feedText = text(this, 0, 0, '', 11, C.faint);
    this.feedText.setAlign('left').setLineSpacing(5);
    this.statusText = text(this, 0, 0, 'posting your score…', 12, C.cyan);

    this.againBtn = new Button(
      this,
      0,
      0,
      'RUN AGAIN',
      { width: 240, filled: true, color: C.gold },
      () => this.playAgain(),
    );
    this.boardBtn = new Button(this, 0, 0, 'LEADERBOARD', { width: 240, color: C.cyan }, () =>
      this.onBoard(),
    );
    this.menuBtn = new Button(this, 0, 0, 'MENU', { width: 240, color: C.panelEdge }, () =>
      fadeTo(this, () => this.scene.start('cs-menu')),
    );

    this.renderLocal();
    this.relayout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.playProxy = attachTapProxy(this, this.againBtn);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
      this.playProxy?.destroy();
    });

    this.cameras.main.fadeIn(220, 7, 11, 22);
<<<<<<< HEAD
=======

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
>>>>>>> feat/fullScreen
    void this.submit();
  }

  /* ---------------------------------------------------------------------- */
  /* Submission                                                              */
  /* ---------------------------------------------------------------------- */

  private async submit(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    this.failed = false;
    this.statusText.setText('posting your score…').setColor(hex(C.cyan));
    this.againBtn.setEnabled(false);

    try {
      // Four attempts: the backoff spans ~2.8s, which covers a submit that
      // reached the server a moment before its clock agreed the run was over.
      const res = await withRetry(() => api.finishRun(this.runId, this.tally), 4);
      this.result = res;
      store.applyBoard(res.board, res.activity);
      store.best = res.you.best;
      store.rank = res.you.rank;
      store.runs = res.you.runs;

      this.statusText.setText(res.adjusted ? 'posted (adjusted by the server)' : 'posted');
      this.statusText.setColor(hex(res.adjusted ? C.gold : C.good));
      this.renderResult(res);

      if (res.tookLead) {
        sfx.leadChange();
        this.flash('TOP OF THE BOARD', C.gold);
      } else if (res.personalBest) {
        sfx.victory();
        this.flash('PERSONAL BEST', C.good);
      }
    } catch (err) {
      this.submitting = false;
      this.failed = true;
      this.againBtn.setEnabled(true);

      const e = err instanceof NetError ? err : null;
      // A run the server refused outright is gone; retrying it will never work.
      // Anything else — a dropped connection, a timeout — is worth another go.
      this.permanent =
        e !== null &&
        (e.code === 'run_duplicate' || e.code === 'run_expired' || e.code === 'round_changed');

      this.statusText
        .setText(e?.message ?? 'Could not reach the server.')
        .setColor(hex(this.permanent ? C.gold : C.danger));
      this.boardBtn.setCaption(this.permanent ? 'LEADERBOARD' : 'RETRY POSTING');
      void store.refreshQuietly();
      return;
    }

    this.submitting = false;
    this.againBtn.setEnabled(true);
  }

  private flash(msg: string, color: number): void {
    const L = layoutOf(this);
    const t = text(this, L.cx, L.y + L.ih * 0.42, msg, 20, color);
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
    this.againBtn.setCaption('STARTING…').setEnabled(false);
    try {
      const run = await api.startRun();
      fadeTo(this, () => this.scene.start('cs-play', { run }));
    } catch (err) {
      this.againBtn.setCaption('RUN AGAIN').setEnabled(true);
      this.statusText
        .setText(err instanceof NetError ? err.message : 'Could not start another run.')
        .setColor(hex(C.gold));
      void store.refreshQuietly();
    }
  }

  /** The leaderboard button doubles as the retry when a post failed. */
  private onBoard(): void {
    if (this.failed && !this.permanent) {
      void this.submit();
      return;
    }
    fadeTo(this, () => this.scene.start('cs-leaderboard'));
  }

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  /** What we can show before the server answers, from the local tally. */
  private renderLocal(): void {
    const t = this.tally;
    const secs = Math.floor(t.msLeft / 1000);
    const rows = [
      `anchors used   ${t.anchorsUsed}`,
      `clocks         ${t.clocks + t.goldens}`,
      `time left      ${(t.msLeft / 1000).toFixed(1)}s`,
    ];
    if (t.hits > 0) rows.push(`hits taken     ${t.hits}`);
    this.breakdown.setText(rows.join('\n'));

    const local = t.reachedGoal
      ? SCORE.goal + t.anchorsUsed * SCORE.anchor + secs * SCORE.secondLeft
      : 0;
    this.scoreText.setText(formatPoints(local));
  }

  private renderResult(r: RunFinishResponse): void {
    this.scoreText.setText(formatPoints(r.points)).setColor(hex(r.points > 0 ? C.gold : C.faint));

    if (r.points > 0) {
      // Show the working. "More anchors and more leftover time" is the whole
      // strategy, and it is far easier to read off three numbers than to infer
      // it from one.
      this.breakdown.setText(
        [
          `reached the goal      ${formatPoints(r.breakdown.goal)}`,
          `${String(this.tally.anchorsUsed).padStart(2)} anchors used       ${formatPoints(r.breakdown.anchors)}`,
          `${String(Math.floor(this.tally.msLeft / 1000)).padStart(2)}s left on the clock ${formatPoints(r.breakdown.time)}`,
        ].join('\n'),
      );
    } else {
      this.breakdown.setText(
        [
          'No score — the clock ran out.',
          '',
          `You used ${this.tally.anchorsUsed} anchors and collected`,
          `${this.tally.clocks + this.tally.goldens} clocks along the way.`,
        ].join('\n'),
      );
    }

    this.standingText.setText(
      [
        `your best this board  ${formatPoints(r.you.best)}`,
        r.you.rank !== null ? `rank  #${r.you.rank}` : 'not yet ranked',
        `runs  ${r.you.runs}`,
      ].join('   ·   '),
    );

    this.feedText.setText(
      r.activity
        .slice(0, 4)
        .map((a) => `· ${activityLine(a)}`)
        .join('\n'),
    );
<<<<<<< HEAD
=======

    this.fitLabels();

    if (r.adjusted) {
      // Being open about a correction beats silently changing someone's score.
      this.statusText.setText('banked (score adjusted by the server)').setColor(hex(C.gold));
    }

    this.drawBar();
  }

  /**
   * Sizes the two labels whose width the server decides.
   *
   * Called from the layout *and* from every render, because the text arrives
   * after the screen is first laid out: two four-figure banks, or a round total
   * beside a community rank, are wider than the panel on a phone, and a line
   * that runs off the edge of the panel it sits in reads as a bug.
   */
  private fitLabels(): void {
    const L = layoutOf(this);
    const inner = L.iw - 36 * L.ui;
    fitText(this.communityText, 12 * L.ui, inner);
    fitText(this.rankText, 11 * L.ui, inner);
  }

  private drawBar(): void {
    const c = this.result?.community ?? store.community;
    if (!c) return;
    const L = layoutOf(this);
    drawTeamBar(this.bar, L.x + 18 * L.ui, L.y + 176 * L.ui, L.iw - 36 * L.ui, 14 * L.ui, c.banks.red, c.banks.blue);
>>>>>>> feat/fullScreen
  }

  private relayout(): void {
    const L = layoutOf(this);
    const g = this.bg;
    g.clear();
    g.fillStyle(C.panel, 0.55);
    g.fillRoundedRect(L.x, L.y + 96 * L.ui, L.iw, 92 * L.ui, 14 * L.ui);

<<<<<<< HEAD
    this.heading.setPosition(L.cx, L.y + 34 * L.ui).setFontSize(Math.round(20 * L.ui));
    this.scoreText.setPosition(L.cx, L.y + 76 * L.ui).setFontSize(Math.round(40 * L.ui));
    this.standingText.setPosition(L.cx, L.y + 152 * L.ui).setFontSize(Math.round(11 * L.ui));
=======
    this.heading.setPosition(L.cx, L.y + 30 * L.ui).setFontSize(Math.round(20 * L.ui));
    this.scoreText.setPosition(L.cx, L.y + 66 * L.ui).setFontSize(Math.round(38 * L.ui));

    this.communityText.setPosition(L.cx, L.y + 126 * L.ui);
    this.rankText.setPosition(L.cx, L.y + 200 * L.ui);
    this.fitLabels();
>>>>>>> feat/fullScreen

    const bw = Math.min(300 * L.ui, L.iw - 40 * L.ui);
    const bh = 52 * L.ui;
    const gap = 10 * L.ui;
    let by = L.y + L.ih - bh / 2 - 6 * L.ui;

    // The button stack owns the bottom of the screen; everything above it has
    // to fit in what is left, or be dropped.
    const buttonsTop = by - bh * 2.5 - gap * 2;
    const columnTop = L.y + 196 * L.ui;

    this.breakdown
      .setPosition(L.x + 20 * L.ui, columnTop)
      .setOrigin(0, 0)
      .setFontSize(Math.round(11.5 * L.ui));
    this.breakdown.setVisible(columnTop + this.breakdown.height <= buttonsTop);
    // A resize after the score landed must redraw from the server's numbers,
    // not the local guess this screen opened with.
    if (this.result) this.standingText.setVisible(true);

    const feedTop =
      (this.breakdown.visible ? columnTop + this.breakdown.height : columnTop) + 14 * L.ui;
    this.feedText.setVisible(buttonsTop - feedTop > 34 * L.ui);
    this.feedText
      .setPosition(L.x + 20 * L.ui, feedTop)
      .setOrigin(0, 0)
      .setFontSize(Math.round(10.5 * L.ui))
      .setWordWrapWidth(L.iw - 40 * L.ui);

    this.menuBtn.setPosition(L.cx, by).setSize(bw, bh);
    by -= bh + gap;
    this.boardBtn.setPosition(L.cx, by).setSize(bw, bh);
    by -= bh + gap;
    this.againBtn.setPosition(L.cx, by).setSize(bw, bh);

<<<<<<< HEAD
    this.statusText.setPosition(L.cx, by - bh / 2 - 16 * L.ui).setFontSize(Math.round(11 * L.ui));
=======
    // The two side buttons share the bottom of the stack when they are up, so
    // the choice sits exactly where the thumb already is.
    const cbh = 58 * L.ui;
    let cy = L.y + L.ih - cbh / 2 - 4 * L.ui;
    this.blueBtn.setPosition(L.cx, cy).setSize(bw, cbh).setFontSize(18 * L.ui);
    cy -= cbh + 12 * L.ui;
    this.redBtn.setPosition(L.cx, cy).setSize(bw, cbh).setFontSize(18 * L.ui);

    const statusY = this.choosing ? cy - cbh / 2 - 16 * L.ui : by - bh / 2 - 16 * L.ui;
    // The status line is the only label that can be handed a whole sentence —
    // a server error, or the share text when the clipboard is blocked — so it
    // wraps instead of running off both edges of the screen.
    this.statusText
      .setPosition(L.cx, statusY)
      .setOrigin(0.5, 1)
      .setFontSize(Math.round(11 * L.ui))
      .setAlign('center')
      .setLineSpacing(3)
      .setWordWrapWidth(L.iw - 24 * L.ui);

    this.playProxy?.sync();
    this.drawBar();
>>>>>>> feat/fullScreen
  }
}
