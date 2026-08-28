import Phaser from 'phaser';
import { sfx } from '@/clockshot/sfx';
import { activityLine, formatClock, formatPoints, store } from '@/clockshot/store';
import { fadeTo } from '@/clockshot/ui';
import { esc, mountForScene, type UiScreen } from '@/clockshot/uiLayer';
import { requestFullScreen } from '@/clockshot/immersive';
import { api, NetError } from '@/clockshot/net';
import { arenaAt } from '@/clockshot/arena';
import { arenaIndexAt } from '@/shared/config';

/**
 * The menu: what is running, how you stand in it, and the ways in.
 *
 * Built on the DOM layer rather than drawn on the canvas, which is what the
 * results card and the editor already do. Three things follow from that, and
 * none of them were available to a rectangle painted on a canvas:
 *
 * - Every control is a real `<button>`, so it has a focus ring, a tab stop and
 *   an accessible name. A drawn rectangle has none of those and cannot be given
 *   them; keyboard and screen-reader users simply could not use this screen.
 * - PLAY produces a trusted click, which is the only kind that buys full screen
 *   and an audio context. The canvas version needed `TapProxy` — transparent
 *   DOM buttons flying in formation over the drawn ones, re-synced on every
 *   relayout — purely to get that click back. All of it is gone.
 * - Layout is CSS. The old version placed nine text objects and five buttons by
 *   hand against a 4-point scale, recomputed on every resize.
 *
 * The screen is a pure function of `store`, re-rendered on change.
 */
export class MenuScene extends Phaser.Scene {
  private ui!: UiScreen;
  private unsubscribe: (() => void) | null = null;
  private poll!: Phaser.Time.TimerEvent;
  private starting = false;

  /**
   * Why the player is looking at a menu at all.
   *
   * TAKE THE RUN goes straight into a run, so arriving here means something
   * turned one down — not being logged in, or having taken too many too fast.
   * The server's own wording is carried across, because "log in to Reddit to
   * play" and "you have run out of runs for now" are different problems and a
   * silent menu explains neither.
   */
  private notice: string | null = null;

  constructor() {
    super('cs-menu');
  }

  init(data?: { notice?: string }): void {
    this.notice = data?.notice ?? null;
    this.starting = false;
  }

  create(): void {
    this.ui = mountForScene(this, this.markup());
    this.bind();
    this.render();

    this.unsubscribe = store.onChange(() => this.render());
    // Keep the board live while the player sits on the menu.
    this.poll = this.time.addEvent({
      delay: 12_000,
      loop: true,
      callback: () => void store.refreshQuietly(),
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.poll.remove();
    });

    this.cameras.main.fadeIn(200, 7, 11, 22);
  }

  /* ---------------------------------------------------------------------- */
  /* Markup                                                                  */
  /* ---------------------------------------------------------------------- */

  private markup(): string {
    return `
      <div class="cs-card cs-menu">
        <div class="cs-menu-board cs-glass cs-glass-dense">
          <p class="cs-menu-top"></p>
          <p class="cs-menu-arena"></p>
          <p class="cs-menu-window"></p>
          <p class="cs-menu-prev"></p>
        </div>

        <div class="cs-menu-title">
          <h1 class="cs-menu-wordmark">CLOCKSHOT</h1>
          <p class="cs-menu-tagline">a grappling time trial</p>
          <p class="cs-menu-you"></p>
        </div>

        <div class="cs-actions">
          <button type="button" class="cs-btn cs-btn-primary" data-act="play">PLAY</button>
          <button type="button" class="cs-btn cs-btn-good" data-act="build">BUILD A LEVEL</button>
          <button type="button" class="cs-btn cs-btn-secondary" data-act="how">HOW TO PLAY</button>
          <button type="button" class="cs-btn cs-btn-ghost" data-act="board">LEADERBOARD</button>
          <button type="button" class="cs-btn cs-btn-ghost" data-act="sound"></button>
        </div>

        <section class="cs-menu-feed">
          <h2 class="cs-label">lately</h2>
          <ul class="cs-menu-feed-rows"></ul>
        </section>
      </div>`;
  }

  private bind(): void {
    // The event is handed straight through: full screen may only be requested
    // from the real click, and this is the tap that starts a run.
    this.ui.onClick('[data-act="play"]', (event) => {
      requestFullScreen(event);
      void this.onPlay();
    });
    // Building wants the screen at least as much as playing does — it is a grid
    // and a palette on a phone.
    this.ui.onClick('[data-act="build"]', (event) => {
      requestFullScreen(event);
      fadeTo(this, () => this.scene.start('cs-editor'));
    });
    this.ui.onClick('[data-act="how"]', () => fadeTo(this, () => this.scene.start('cs-howto')));
    this.ui.onClick('[data-act="board"]', () =>
      fadeTo(this, () => this.scene.start('cs-leaderboard')),
    );
    this.ui.onClick('[data-act="sound"]', () => {
      sfx.toggleMute();
      this.renderSound();
    });
  }

  private button(act: string): HTMLButtonElement {
    return this.ui.find<HTMLButtonElement>(`[data-act="${act}"]`);
  }

  /* ---------------------------------------------------------------------- */
  /* Starting a run                                                          */
  /* ---------------------------------------------------------------------- */

  private async onPlay(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    // Whatever turned the last run down, the player is past it now.
    this.notice = null;
    this.render();

    try {
      const run = await api.startRun();
      fadeTo(this, () => this.scene.start('cs-play', { run }));
    } catch (err) {
      this.starting = false;

      if (err instanceof NetError && err.code === 'rate_limited') {
        this.notice = err.message;
        this.render();
        void store.refreshQuietly();
        return;
      }

      this.scene.start('cs-error', {
        retryTo: 'cs-menu',
        message: err instanceof NetError ? err.message : 'Could not start a run.',
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Naming the arena is what turns "a window" into a place. */
  private windowLine(): string {
    const b = store.board;
    if (!b) return '';
    return [
      `resets in ${formatClock(store.msLeftInWindow())}`,
      `${b.players} player${b.players === 1 ? '' : 's'}`,
    ].join('  ·  ');
  }

  private renderSound(): void {
    const on = !sfx.isMuted;
    const btn = this.button('sound');
    btn.textContent = on ? 'SOUND: ON' : 'SOUND: OFF';
    // The label already says which way it is, so this only has to agree with it
    // for anyone who cannot see the label.
    btn.setAttribute('aria-pressed', String(on));
  }

  private render(): void {
    this.renderSound();
    this.renderPlayButton();

    const b = store.board;
    if (!b) return;

    const arena = arenaAt(arenaIndexAt(b.roundIndex));
    this.ui.text('.cs-menu-arena', `${arena.name}  ·  ${arena.blurb}`);
    this.ui.text(
      '.cs-menu-top',
      b.topScore === null
        ? 'NO SCORE YET — BE FIRST'
        : `TOP  ${formatPoints(b.topScore)}  ·  u/${b.topPlayer}`,
    );
    this.ui.text('.cs-menu-window', this.windowLine());

    const prev = b.previous;
    this.ui.text(
      '.cs-menu-prev',
      prev === null || prev.topScore === null
        ? 'first board in this community'
        : `last board: u/${prev.topPlayer} won it with ${formatPoints(prev.topScore)}`,
    );

    this.renderYou();
    this.renderFeed();
  }

  private renderYou(): void {
    const el = this.ui.find('.cs-menu-you');

    // A refusal outranks the player's own standing: it is the reason this
    // screen is on at all, and it is what they have to act on.
    if (this.notice) {
      el.textContent = this.notice;
      el.dataset.tone = 'notice';
      return;
    }
    if (!store.username) {
      el.textContent = 'log in to Reddit to play';
      el.dataset.tone = 'dim';
      return;
    }

    const rank = store.rank !== null ? `  ·  #${store.rank}` : '';
    el.textContent =
      store.best > 0
        ? `u/${store.username}  ·  best ${formatPoints(store.best)}${rank}`
        : `u/${store.username}  ·  no score yet`;
    el.dataset.tone = store.best > 0 ? 'gold' : 'dim';
  }

  /**
   * PLAY, and the two states it is allowed to be in.
   *
   * `starting` owns the caption and the disabled flag together. Writing them
   * from separate places is what once left a button reading "PLAY" while still
   * disabled — available-looking, washed out, and dead to the touch.
   */
  private renderPlayButton(): void {
    const btn = this.button('play');
    if (!store.username) {
      btn.textContent = 'LOG IN TO PLAY';
      btn.disabled = true;
      return;
    }
    btn.textContent = this.starting ? 'STARTING…' : 'PLAY';
    btn.disabled = this.starting;
  }

  /** The feed is what turns a menu into a place where other people have been. */
  private renderFeed(): void {
    const rows = store.activity.slice(0, 5);
    this.ui.find('.cs-menu-feed').hidden = rows.length === 0;
    this.ui.find('.cs-menu-feed-rows').innerHTML = rows
      .map((a) => `<li>${esc(activityLine(a))}</li>`)
      .join('');
  }
}
