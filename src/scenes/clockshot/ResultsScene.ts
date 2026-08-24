import Phaser from 'phaser';
import { C, FONT, hex } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { formatPoints, store } from '@/clockshot/store';
import { api, NetError, withRetry } from '@/clockshot/net';
import { Button, fadeTo, fitText, layoutOf, type Layout } from '@/clockshot/ui';
import { SCORE } from '@/shared/config';
import type { LeaderRow, RunFinishResponse, RunTally } from '@/shared/api';
import { attachTapProxy, type TapProxy } from '@/clockshot/immersive';

/**
 * Run results, and the moment the run actually counts.
 *
 * Scoring happens here rather than at the end of gameplay so the player is
 * looking at a screen that can explain a failure. Losing a run to one dropped
 * request is the worst thing this game could do, so the submit retries, and if
 * it still fails the run is offered again by hand.
 *
 * The screen is one card with two faces. The front is the verdict — did you
 * clear it, what was it worth, where does that leave you — and the back is the
 * board. They are two sides of one object rather than two screens because they
 * answer the same question: the score only means something next to everyone
 * else's. Flipping keeps the player where they are; starting a second scene
 * would make checking the board feel like leaving.
 */

/** The card's design height. Everything inside is measured against this. */
const CARD_H = 432;
const CARD_W = 330;

/** How many rows of the board the back can hold. */
const ROW_MAX = 6;

interface Row {
  rank: Phaser.GameObjects.Text;
  who: Phaser.GameObjects.Text;
  score: Phaser.GameObjects.Text;
}

export class ResultsScene extends Phaser.Scene {
  private runId!: string;
  private tally!: RunTally;

  /* --- the card -------------------------------------------------------- */

  /** Both faces live in here, so the flip is one tween on one object. */
  private card!: Phaser.GameObjects.Container;
  private frontGfx!: Phaser.GameObjects.Graphics;
  private backGfx!: Phaser.GameObjects.Graphics;

  private badge!: Phaser.GameObjects.Text;
  private heading!: Phaser.GameObjects.Text;
  private subheading!: Phaser.GameObjects.Text;
  private statLabels: Phaser.GameObjects.Text[] = [];
  private statValues: Phaser.GameObjects.Text[] = [];
  private noteMain!: Phaser.GameObjects.Text;
  private noteSub!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  private boardTitle!: Phaser.GameObjects.Text;
  private boardCount!: Phaser.GameObjects.Text;
  private boardStatus!: Phaser.GameObjects.Text;
  private rows: Row[] = [];

  private againBtn!: Button;
  private boardBtn!: Button;
  private forgeBtn!: Button;
  private backBtn!: Button;

  /** Stands in for RUN AGAIN so the tap that starts a run can take the screen. */
  private playProxy: TapProxy | null = null;

  /* --- state ------------------------------------------------------------ */

  private face: 'front' | 'back' = 'front';
  private flipping = false;
  private leaders: LeaderRow[] = [];
  private boardLoaded = false;
  private boardError: string | null = null;

  /** Kept so a re-layout after the server answers can redraw from the result. */
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
    this.face = 'front';
    this.flipping = false;
    this.leaders = [];
    this.boardLoaded = false;
    this.boardError = null;
    this.statLabels = [];
    this.statValues = [];
    this.rows = [];
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);

    this.card = this.add.container(0, 0);
    this.frontGfx = this.add.graphics();
    this.backGfx = this.add.graphics();
    this.card.add([this.frontGfx, this.backGfx]);

    this.buildFront();
    this.buildBack();
    this.buildButtons();

    this.applyFace();
    this.renderLocal();
    this.relayout();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.playProxy = attachTapProxy(this, this.againBtn);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
      this.playProxy?.destroy();
    });

    this.cameras.main.fadeIn(220, 7, 11, 22);
    void this.submit();
  }

  /* ---------------------------------------------------------------------- */
  /* Building                                                                */
  /* ---------------------------------------------------------------------- */

  /** A label inside the card, positioned later in card-local coordinates. */
  private cardText(
    content: string,
    size: number,
    colour: number,
    origin = 0.5,
  ): Phaser.GameObjects.Text {
    const t = this.add
      .text(0, 0, content, { fontFamily: FONT, fontSize: `${Math.round(size)}px`, color: hex(colour) })
      .setOrigin(origin, 0.5);
    this.card.add(t);
    return t;
  }

  private buildFront(): void {
    const won = this.tally.reachedGoal;

    this.badge = this.cardText('RECORD HOLDER', 9.5, C.bg);
    this.heading = this.cardText(won ? 'CLEARED' : 'OUT OF TIME', 30, won ? C.goal : C.danger);
    this.heading.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.subheading = this.cardText('', 10.5, C.dim);

    for (const label of ['YOUR SCORE', 'YOUR BEST']) {
      this.statLabels.push(this.cardText(label, 9, C.faint));
      this.statValues.push(this.cardText('—', 24, C.ink));
    }

    this.noteMain = this.cardText('', 12, C.gold);
    this.noteSub = this.cardText('', 10, C.dim);
    this.statusText = this.cardText('posting your score…', 10.5, C.cyan);
  }

  private buildBack(): void {
    this.boardTitle = this.cardText('LEADERBOARD', 17, C.ink);
    this.boardTitle.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.boardCount = this.cardText('', 10, C.dim);
    this.boardStatus = this.cardText('loading…', 11, C.faint);

    for (let i = 0; i < ROW_MAX; i++) {
      this.rows.push({
        rank: this.cardText('', 10, C.faint, 0),
        who: this.cardText('', 12, C.ink, 0),
        score: this.cardText('', 12, C.ink, 1),
      });
    }
  }

  private buildButtons(): void {
    this.againBtn = new Button(
      this,
      0,
      0,
      'RUN AGAIN',
      { width: 240, filled: true, color: C.gold },
      () => void this.playAgain(),
    );
    this.boardBtn = new Button(this, 0, 0, 'LEADERBOARD', { width: 240, color: C.cyan }, () =>
      this.onBoard(),
    );
    this.forgeBtn = new Button(this, 0, 0, 'FORGE YOUR OWN', { width: 240, color: C.good }, () =>
      fadeTo(this, () => this.scene.start('cs-levels')),
    );
    this.backBtn = new Button(this, 0, 0, '← BACK', { width: 240, color: C.panelEdge }, () =>
      this.flip('front'),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* The flip                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Turns the card over.
   *
   * Squashing to nothing and back out is the cheapest honest reading of a flip
   * — there is no perspective camera here to rotate through — and it is the
   * half of the motion that actually carries the meaning: the face you were
   * looking at leaves edge-on, and a different one comes back.
   *
   * The buttons are scene objects rather than children of the card, so they are
   * taken away for the turn and put back with the new face. Nesting them would
   * mean scaling their hit areas to nothing halfway through, and a button that
   * is a sliver wide is a button that eats taps.
   */
  private flip(to: 'front' | 'back'): void {
    if (this.flipping || this.face === to) return;
    this.flipping = true;
    sfx.uiSelect();
    this.setButtonsVisible(false);

    this.tweens.add({
      targets: this.card,
      scaleX: 0,
      duration: 165,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        this.face = to;
        this.applyFace();
        if (to === 'back') void this.loadBoard();

        this.tweens.add({
          targets: this.card,
          scaleX: 1,
          duration: 190,
          ease: 'Cubic.easeOut',
          onComplete: () => {
            this.flipping = false;
            this.setButtonsVisible(true);
          },
        });
      },
    });
  }

  /** Shows the objects belonging to the face that is up, and hides the rest. */
  private applyFace(): void {
    const front = this.face === 'front';

    this.frontGfx.setVisible(front);
    this.backGfx.setVisible(!front);

    for (const t of [
      this.badge,
      this.heading,
      this.subheading,
      this.noteMain,
      this.noteSub,
      this.statusText,
      ...this.statLabels,
      ...this.statValues,
    ]) {
      t.setVisible(front);
    }
    this.badge.setVisible(front && this.result?.tookLead === true);

    for (const t of [this.boardTitle, this.boardCount, this.boardStatus]) {
      t.setVisible(!front);
    }
    this.boardStatus.setVisible(!front && (this.boardError !== null || !this.boardLoaded));
    for (const r of this.rows) {
      const on = !front && r.who.text !== '';
      r.rank.setVisible(on);
      r.who.setVisible(on);
      r.score.setVisible(on);
    }

    this.setButtonsVisible(!this.flipping);
  }

  private setButtonsVisible(on: boolean): void {
    const front = this.face === 'front';
    this.againBtn.setVisible(on && front);
    this.boardBtn.setVisible(on && front);
    this.forgeBtn.setVisible(on && front);
    this.backBtn.setVisible(on && !front);
    this.playProxy?.sync();
  }

  /* ---------------------------------------------------------------------- */
  /* Data                                                                    */
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
      } else if (res.personalBest) {
        sfx.victory();
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

  /** The board behind the card. Fetched on the first flip, then kept. */
  private async loadBoard(): Promise<void> {
    if (this.boardLoaded) return;
    this.boardError = null;
    this.boardStatus.setText('loading…').setColor(hex(C.faint)).setVisible(true);

    try {
      const res = await api.leaderboard();
      this.leaders = res.players;
      this.boardLoaded = true;
    } catch (err) {
      this.boardError = err instanceof NetError ? err.message : 'Could not load the board.';
      this.boardStatus.setText(this.boardError).setColor(hex(C.danger));
    }

    this.renderBoard();
    if (this.face === 'back') this.applyFace();
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
    this.flip('back');
  }

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  /** What we can show before the server answers, from the local tally. */
  private renderLocal(): void {
    const t = this.tally;
    const secs = Math.floor(t.msLeft / 1000);
    const local = t.reachedGoal
      ? SCORE.goal + t.anchorsUsed * SCORE.anchor + secs * SCORE.secondLeft
      : 0;

    this.statValues[0]?.setText(formatPoints(local));
    this.statValues[1]?.setText(store.best > 0 ? formatPoints(store.best) : '—');
    this.subheading.setText(this.runLine());
    this.noteMain.setText(t.reachedGoal ? 'counting your run…' : 'The clock ran out.');
    this.noteSub.setText(this.detailLine());
  }

  private renderResult(r: RunFinishResponse): void {
    this.statValues[0]?.setText(formatPoints(r.points)).setColor(hex(r.points > 0 ? C.gold : C.faint));
    this.statValues[1]?.setText(formatPoints(r.you.best));
    this.subheading.setText(this.runLine(r));

    // The one line that says what this run changed. A record beats a personal
    // best, which beats a rank, which beats nothing happening at all.
    if (r.tookLead) {
      this.noteMain.setText(`You hold the board at ${formatPoints(r.points)}`).setColor(hex(C.gold));
    } else if (r.personalBest) {
      this.noteMain.setText(`Personal best — ${formatPoints(r.points)}`).setColor(hex(C.good));
    } else if (r.you.rank !== null) {
      this.noteMain.setText(`#${r.you.rank} on the board`).setColor(hex(C.ink));
    } else {
      this.noteMain.setText('No score this run').setColor(hex(C.dim));
    }

    this.noteSub.setText(this.detailLine());
    this.applyFace();
    this.fitLabels();
  }

  /** "Run 3 this board" — the reference's "solved in 1 try", in this game's terms. */
  private runLine(r?: RunFinishResponse): string {
    const runs = r ? r.you.runs : store.runs;
    if (!runs || runs < 1) return 'your first run this board';
    return runs === 1 ? 'cleared on your first run' : `run ${runs} this board`;
  }

  /** The supporting detail: what the run was actually made of. */
  private detailLine(): string {
    const t = this.tally;
    const parts = [
      `${t.anchorsUsed} anchor${t.anchorsUsed === 1 ? '' : 's'}`,
      `${(t.msLeft / 1000).toFixed(1)}s left`,
    ];
    if (t.clocks + t.goldens > 0) parts.push(`${t.clocks + t.goldens} clocks`);
    if (t.hits > 0) parts.push(`${t.hits} hit${t.hits === 1 ? '' : 's'}`);
    return parts.join('  ·  ');
  }

  private renderBoard(): void {
    const shown = this.leaders.slice(0, ROW_MAX);
    this.boardCount.setText(
      this.leaders.length === 1 ? '1 clear' : `${this.leaders.length} clears`,
    );

    this.rows.forEach((row, i) => {
      const r = shown[i];
      if (!r) {
        row.rank.setText('');
        row.who.setText('');
        row.score.setText('');
        return;
      }
      row.rank.setText(`#${r.rank}`).setColor(hex(r.isYou ? C.goal : C.faint));
      row.who.setText(r.isYou ? '▸ you' : `u/${r.username}`).setColor(hex(r.isYou ? C.goal : C.ink));
      row.score.setText(formatPoints(r.points)).setColor(hex(r.isYou ? C.goal : C.ink));
    });

    if (this.boardLoaded && this.leaders.length === 0) {
      this.boardStatus.setText('Nobody has cleared it yet. Be first.').setColor(hex(C.dim));
    }

    this.relayout();
  }

  /**
   * Sizes the labels whose width the server decides.
   *
   * A four-figure score, or a long username, is wider than the card on a phone,
   * and a line that runs off the panel it sits in reads as a bug — where the
   * same line a point or two smaller reads as designed.
   */
  private fitLabels(): void {
    const { u, w } = this.metrics(layoutOf(this));
    fitText(this.noteMain, 12 * u, w - 40 * u);
    fitText(this.noteSub, 10 * u, w - 40 * u);
    for (const v of this.statValues) fitText(v, 24 * u, w / 2 - 26 * u);
    for (const row of this.rows) fitText(row.who, 12 * u, w * 0.52);
  }

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * The card's size, and the unit everything inside it is measured in.
   *
   * The card is designed at one size and then shrunk to fit whatever height the
   * post is given, rather than reflowed. Everything in it — type, padding, the
   * buttons — scales by the same `u`, so a short screen gets a smaller card
   * rather than a broken one.
   */
  private metrics(L: Layout): { u: number; w: number; h: number; cx: number; cy: number } {
    const fit = Math.min(1, L.ih / (CARD_H * L.ui), L.iw / (CARD_W * L.ui));
    const u = L.ui * fit;
    return { u, w: CARD_W * u, h: CARD_H * u, cx: L.cx, cy: L.y + L.ih / 2 };
  }

  private relayout(): void {
    const L = layoutOf(this);
    const { u, w, h, cx, cy } = this.metrics(L);

    this.card.setPosition(cx, cy);
    const top = -h / 2;
    const left = -w / 2;

    this.drawFront(u, w, h);
    this.drawBack(u, w, h);

    /* --- front ---------------------------------------------------------- */

    this.badge.setPosition(0, top + 20 * u).setFontSize(Math.round(9 * u));
    this.heading.setPosition(0, top + 58 * u).setFontSize(Math.round(29 * u));
    this.subheading.setPosition(0, top + 84 * u).setFontSize(Math.round(10 * u));

    // Two readings, side by side, the way the card in the reference splits
    // "your time" from "your best".
    this.statLabels.forEach((label, i) => {
      const x = left + w * (i === 0 ? 0.27 : 0.73);
      label.setPosition(x, top + 126 * u).setFontSize(Math.round(8.5 * u));
      this.statValues[i]?.setPosition(x, top + 150 * u).setFontSize(Math.round(23 * u));
    });

    this.noteMain.setPosition(0, top + 196 * u).setFontSize(Math.round(11.5 * u));
    this.noteSub.setPosition(0, top + 217 * u).setFontSize(Math.round(9.5 * u));
    this.statusText.setPosition(0, top + 243 * u).setFontSize(Math.round(10 * u));

    /* --- back ----------------------------------------------------------- */

    this.boardTitle.setPosition(0, top + 32 * u).setFontSize(Math.round(16 * u));
    this.boardCount.setPosition(0, top + 54 * u).setFontSize(Math.round(9.5 * u));
    this.boardStatus.setPosition(0, top + 130 * u).setFontSize(Math.round(10.5 * u));

    this.rows.forEach((row, i) => {
      const y = top + 84 * u + i * 30 * u;
      row.rank.setPosition(left + 18 * u, y).setFontSize(Math.round(9.5 * u));
      row.who.setPosition(left + 46 * u, y).setFontSize(Math.round(11.5 * u));
      row.score.setPosition(left + w - 18 * u, y).setFontSize(Math.round(11.5 * u));
    });

    /* --- buttons -------------------------------------------------------- */

    const bw = w - 36 * u;
    const bh = 44 * u;
    const gap = 8 * u;
    let by = cy + top + 274 * u + bh / 2;

    this.againBtn.setPosition(cx, by).setSize(bw, bh).setFontSize(15 * u);
    by += bh + gap;
    this.boardBtn.setPosition(cx, by).setSize(bw, bh).setFontSize(14 * u);
    by += bh + gap;

    this.forgeBtn.setPosition(cx, by).setSize(bw, bh).setFontSize(13 * u);

    this.backBtn
      .setPosition(cx, cy + top + 274 * u + bh / 2)
      .setSize(bw, bh)
      .setFontSize(14 * u);

    this.fitLabels();
    this.playProxy?.sync();
  }

  private drawFront(u: number, w: number, h: number): void {
    const g = this.frontGfx;
    const x = -w / 2;
    const y = -h / 2;
    const r = 18 * u;
    const won = this.tally.reachedGoal;
    g.clear();

    // The card itself.
    g.fillStyle(C.panel, 0.97);
    g.fillRoundedRect(x, y, w, h, r);

    // The verdict band across the top, in the colour of the outcome. This is
    // the whole point of the face: green means you did it.
    const bandH = 100 * u;
    g.fillStyle(won ? C.goal : C.danger, won ? 0.16 : 0.13);
    g.fillRoundedRect(x, y, w, bandH, { tl: r, tr: r, bl: 0, br: 0 });
    g.lineStyle(Math.max(1, 1.5 * u), won ? C.goal : C.danger, 0.35);
    g.lineBetween(x, y + bandH, x + w, y + bandH);

    // The record pill, drawn only when there is a record to sit in it.
    if (this.result?.tookLead) {
      const pw = this.badge.width + 22 * u;
      const ph = 17 * u;
      g.fillStyle(C.gold, 0.92);
      g.fillRoundedRect(-pw / 2, y + 20 * u - ph / 2, pw, ph, ph / 2);
    }

    // The line that says what changed, boxed so it reads as the headline of
    // the lower half rather than another stat.
    const nx = x + 16 * u;
    const nw = w - 32 * u;
    const ny = y + 182 * u;
    const nh = 50 * u;
    g.fillStyle(C.gold, 0.07);
    g.fillRoundedRect(nx, ny, nw, nh, 12 * u);
    g.lineStyle(Math.max(1, 1.5 * u), C.gold, 0.4);
    g.strokeRoundedRect(nx, ny, nw, nh, 12 * u);

    g.lineStyle(Math.max(1, 1.5 * u), C.panelEdge, 0.9);
    g.strokeRoundedRect(x, y, w, h, r);
  }

  private drawBack(u: number, w: number, h: number): void {
    const g = this.backGfx;
    const x = -w / 2;
    const y = -h / 2;
    const r = 18 * u;
    g.clear();

    g.fillStyle(C.panel, 0.97);
    g.fillRoundedRect(x, y, w, h, r);
    g.lineStyle(Math.max(1, 1.5 * u), C.panelEdge, 0.9);
    g.strokeRoundedRect(x, y, w, h, r);
    g.lineStyle(Math.max(1, 1.5 * u), C.panelEdge, 0.7);
    g.lineBetween(x + 16 * u, y + 68 * u, x + w - 16 * u, y + 68 * u);

    // Your own row is lit the way the goal is lit, so it is found without
    // being read.
    const mine = this.leaders.findIndex((p) => p.isYou);
    if (mine >= 0 && mine < ROW_MAX) {
      const ry = y + 84 * u + mine * 30 * u;
      g.fillStyle(C.goal, 0.1);
      g.fillRoundedRect(x + 10 * u, ry - 13 * u, w - 20 * u, 26 * u, 8 * u);
    }
  }
}
