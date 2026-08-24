import Phaser from 'phaser';
import { C } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { formatPoints, store } from '@/clockshot/store';
import { api, NetError, withRetry } from '@/clockshot/net';
import { fadeTo } from '@/clockshot/ui';
import { addBackdrop } from '@/clockshot/glass';
import { esc, mountForScene, type UiScreen } from '@/clockshot/uiLayer';
import { requestFullScreen } from '@/clockshot/immersive';
import { SCORE } from '@/shared/config';
import type { LeaderRow, RunFinishResponse, RunTally } from '@/shared/api';

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
 * answer the same question: a score only means something next to everyone
 * else's. Flipping keeps the player where they are; starting a second scene
 * would read as leaving.
 *
 * This is the first screen built on the DOM layer rather than drawn on the
 * canvas, and it buys three things the canvas could not give it. The card turns
 * over with a real 3D transform instead of a squash standing in for one. RUN
 * AGAIN is a real `<button>`, so the click it produces is the trusted one
 * Reddit requires to grant full screen — no invisible proxy flying in formation
 * with a drawn rectangle, re-synced on every relayout. And the board scrolls
 * natively, with focus rings and keyboard access that work because nothing ever
 * took them away.
 */
export class ResultsScene extends Phaser.Scene {
  private runId!: string;
  private tally!: RunTally;
  private ui!: UiScreen;

  private face: 'front' | 'back' = 'front';
  private leaders: LeaderRow[] = [];
  private boardLoaded = false;

  private submitting = false;
  private failed = false;
  /**
   * True when the server refused the run for a reason that will never change.
   *
   * Kept as its own flag rather than inferred from whether a result landed: a
   * dropped connection and a rejected run both leave the screen without one,
   * and only the second of those is worth giving up on.
   */
  private permanent = false;

  constructor() {
    super('cs-results');
  }

  init(data: { runId: string; tally: RunTally }): void {
    this.runId = data.runId;
    this.tally = data.tally;
    this.submitting = false;
    this.failed = false;
    this.permanent = false;
    this.face = 'front';
    this.leaders = [];
    this.boardLoaded = false;
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    // The canvas keeps the vibrant field, so the card's `backdrop-filter` has
    // something worth blurring. This is real frosted glass, not an imitation.
    addBackdrop(this);

    this.ui = mountForScene(this, this.markup());
    this.bind();
    this.renderLocal();

    this.cameras.main.fadeIn(220, 7, 11, 22);
    void this.submit();
  }

  /* ---------------------------------------------------------------------- */
  /* Markup                                                                  */
  /* ---------------------------------------------------------------------- */

  private markup(): string {
    const won = this.tally.reachedGoal;
    return `
      <div class="cs-card cs-flip" data-face="front">
        <div class="cs-face cs-glass cs-glass-dense">
          <div class="cs-band" data-outcome="${won ? 'won' : 'lost'}">
            <span class="cs-badge" hidden>RECORD HOLDER</span>
            <h1 class="cs-verdict">${won ? 'CLEARED' : 'OUT OF TIME'}</h1>
            <p class="cs-sub"></p>
          </div>

          <div class="cs-stats">
            <div>
              <p class="cs-label">Your score</p>
              <b class="cs-stat-value" data-stat="score">—</b>
            </div>
            <div class="cs-stats-rule"></div>
            <div>
              <p class="cs-label">Your best</p>
              <b class="cs-stat-value" data-stat="best">—</b>
            </div>
          </div>

          <div class="cs-note">
            <p class="cs-note-main"></p>
            <p class="cs-note-sub"></p>
          </div>

          <p class="cs-status">posting your score…</p>

          <div class="cs-actions">
            <button type="button" class="cs-btn cs-btn-primary" data-act="again">RUN AGAIN</button>
            <button type="button" class="cs-btn cs-btn-secondary" data-act="board">LEADERBOARD</button>
            <button type="button" class="cs-btn cs-btn-good" data-act="forge">FORGE YOUR OWN</button>
          </div>
        </div>

        <div class="cs-face cs-face-back cs-glass cs-glass-dense">
          <div class="cs-board-head">
            <h2 class="cs-board-title">LEADERBOARD</h2>
            <p class="cs-sub" data-board="count"></p>
          </div>
          <ol class="cs-rows"><li class="cs-empty">loading…</li></ol>
          <div class="cs-actions">
            <button type="button" class="cs-btn cs-btn-ghost" data-act="back">← BACK</button>
          </div>
        </div>
      </div>`;
  }

  private bind(): void {
    // The event is handed straight through: full screen may only be requested
    // from the real click, and this is the tap that starts a run.
    this.ui.onClick('[data-act="again"]', (event) => {
      requestFullScreen(event);
      void this.playAgain();
    });
    this.ui.onClick('[data-act="board"]', () => this.onBoard());
    this.ui.onClick('[data-act="forge"]', () => fadeTo(this, () => this.scene.start('cs-levels')));
    this.ui.onClick('[data-act="back"]', () => this.flip('front'));
  }

  /* ---------------------------------------------------------------------- */
  /* The flip                                                                */
  /* ---------------------------------------------------------------------- */

  private flip(to: 'front' | 'back'): void {
    if (this.face === to) return;
    this.face = to;
    sfx.uiSelect();
    this.ui.find('.cs-flip').dataset.face = to;
    if (to === 'back') void this.loadBoard();
  }

  /* ---------------------------------------------------------------------- */
  /* Data                                                                    */
  /* ---------------------------------------------------------------------- */

  private status(message: string, tone: 'info' | 'good' | 'warn' | 'bad'): void {
    const el = this.ui.find('.cs-status');
    el.textContent = message;
    el.dataset.tone = tone;
  }

  private button(act: string): HTMLButtonElement {
    return this.ui.find<HTMLButtonElement>(`[data-act="${act}"]`);
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    this.failed = false;
    this.status('posting your score…', 'info');
    this.button('again').disabled = true;

    try {
      // Four attempts: the backoff spans ~2.8s, which covers a submit that
      // reached the server a moment before its clock agreed the run was over.
      const res = await withRetry(() => api.finishRun(this.runId, this.tally), 4);
      store.applyBoard(res.board, res.activity);
      store.best = res.you.best;
      store.rank = res.you.rank;
      store.runs = res.you.runs;

      this.status(
        res.adjusted ? 'posted (adjusted by the server)' : 'posted',
        res.adjusted ? 'warn' : 'good',
      );
      this.renderResult(res);

      if (res.tookLead) sfx.leadChange();
      else if (res.personalBest) sfx.victory();
    } catch (err) {
      this.submitting = false;
      this.failed = true;
      this.button('again').disabled = false;

      const e = err instanceof NetError ? err : null;
      // A run the server refused outright is gone; retrying it will never work.
      // Anything else — a dropped connection, a timeout — is worth another go.
      this.permanent =
        e !== null &&
        (e.code === 'run_duplicate' || e.code === 'run_expired' || e.code === 'round_changed');

      this.status(e?.message ?? 'Could not reach the server.', this.permanent ? 'warn' : 'bad');
      this.button('board').textContent = this.permanent ? 'LEADERBOARD' : 'RETRY POSTING';
      void store.refreshQuietly();
      return;
    }

    this.submitting = false;
    this.button('again').disabled = false;
  }

  /** The board behind the card. Fetched on the first flip, then kept. */
  private async loadBoard(): Promise<void> {
    if (this.boardLoaded) return;
    try {
      const res = await api.leaderboard();
      this.leaders = res.players;
      this.boardLoaded = true;
      this.renderBoard();
    } catch (err) {
      this.ui.find('.cs-rows').innerHTML = `<li class="cs-empty">${esc(
        err instanceof NetError ? err.message : 'Could not load the board.',
      )}</li>`;
    }
  }

  private async playAgain(): Promise<void> {
    const btn = this.button('again');
    btn.textContent = 'STARTING…';
    btn.disabled = true;
    try {
      const run = await api.startRun();
      fadeTo(this, () => this.scene.start('cs-play', { run }));
    } catch (err) {
      btn.textContent = 'RUN AGAIN';
      btn.disabled = false;
      this.status(err instanceof NetError ? err.message : 'Could not start another run.', 'warn');
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

    this.setStat('score', local);
    this.setStat('best', store.best);
    this.ui.text('.cs-sub', this.runLine());
    this.ui.text('.cs-note-main', t.reachedGoal ? 'counting your run…' : 'The clock ran out.');
    this.ui.text('.cs-note-sub', this.detailLine());
  }

  private setStat(name: string, value: number): void {
    const el = this.ui.find(`[data-stat="${name}"]`);
    el.textContent = value > 0 ? formatPoints(value) : '—';
    el.dataset.zero = String(value <= 0);
  }

  private renderResult(r: RunFinishResponse): void {
    this.setStat('score', r.points);
    this.setStat('best', r.you.best);
    this.ui.text('.cs-sub', this.runLine(r));
    this.ui.find('.cs-badge').hidden = !r.tookLead;

    // The one line that says what this run changed. A record beats a personal
    // best, which beats a rank, which beats nothing having happened.
    const note = this.ui.find('.cs-note-main');
    if (r.tookLead) {
      note.textContent = `You hold the board at ${formatPoints(r.points)}`;
      note.style.color = 'var(--cs-gold)';
    } else if (r.personalBest) {
      note.textContent = `Personal best — ${formatPoints(r.points)}`;
      note.style.color = 'var(--cs-good)';
    } else if (r.you.rank !== null) {
      note.textContent = `#${r.you.rank} on the board`;
      note.style.color = 'var(--cs-ink)';
    } else {
      note.textContent = 'No score this run';
      note.style.color = 'var(--cs-dim)';
    }

    this.ui.text('.cs-note-sub', this.detailLine());
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
    this.ui.text(
      '[data-board="count"]',
      this.leaders.length === 1 ? '1 clear' : `${this.leaders.length} clears`,
    );

    const rows = this.ui.find('.cs-rows');
    if (this.leaders.length === 0) {
      rows.innerHTML = `<li class="cs-empty">Nobody has cleared it yet.<br>Be first.</li>`;
      return;
    }

    // Usernames come off the wire, so they are escaped rather than trusted.
    rows.innerHTML = this.leaders
      .map(
        (r) => `
        <li class="cs-row" data-you="${r.isYou}">
          <span class="cs-rank">#${r.rank}</span>
          <span class="cs-who">${r.isYou ? '▸ you' : `u/${esc(r.username)}`}</span>
          <span class="cs-score">${formatPoints(r.points)}</span>
        </li>`,
      )
      .join('');
  }
}
