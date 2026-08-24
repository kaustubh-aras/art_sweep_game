import { api, NetError } from './net';
import { choose, type Choice } from './choice';
import { requestFullScreen } from './immersive';
import { sfx } from './sfx';
import { formatPoints, store } from './store';
import { arenaAt } from './arena';
import { arenaArt } from './splashArt';
import { arenaIndexAt, START_TIME_MS } from '../shared/config';
import type { LeaderRow } from '../shared/api';

/**
 * The splash card — what a player sees in the feed before the game exists.
 *
 * This is a Reddit post first and a game second. Someone scrolling past has not
 * asked for a grappling hook; they are deciding, in about a second, whether
 * this post is worth stopping for. So the card leads with the things that make
 * that decision: which course is up, how hard it is, who has beaten it and how
 * fast, and how long is left to take it off them.
 *
 * It is deliberately DOM rather than another Phaser scene. The card is a
 * document — a heading, a table, a button — and it has to be on screen before
 * a single texture is baked. It is also the one place the game is guaranteed a
 * *trusted* click, which is the only currency that buys full screen and an
 * audio context, so the tap that opens the game spends it on both.
 */

/** How many difficulty marks the card shows, lit or unlit. */
const PIPS = 5;

/**
 * Puts the card up and resolves when the player taps into the game.
 *
 * The overlay is already in the document as a loading state; this fills it in
 * once the board answers, and takes it away on the tap. A board that never
 * answers is not a reason to trap anybody behind a spinner — the card renders
 * with what it has and the button still opens the game, which has its own
 * error screen for the same failure.
 */
export async function mountSplash(): Promise<void> {
  const root = document.getElementById('splash');
  if (!root) {
    // No card means no door to pick, and the game must never be left waiting
    // on an answer that can no longer arrive.
    choose('run');
    return;
  }

  const rows = await loadData();
  const open = renderCard(root, rows);
  await open;

  root.classList.add('gone');
  window.setTimeout(() => root.remove(), 400);
}

/**
 * Fetches both halves of the card at once, and survives either one failing.
 *
 * `store.refresh()` is the same call the boot scene makes, so the state it
 * lands is reused rather than fetched twice.
 */
async function loadData(): Promise<LeaderRow[]> {
  const [, board] = await Promise.allSettled([
    store.refreshQuietly(),
    api.leaderboard().catch((err: unknown) => {
      // A board that is empty and a board that failed read the same on the
      // card: no rows. Neither is worth blocking the post for.
      if (!(err instanceof NetError)) throw err;
      return { players: [] as LeaderRow[] };
    }),
  ]);

  return board.status === 'fulfilled' ? board.value.players : [];
}

/** Builds the card and hands back the tap that dismisses it. */
function renderCard(root: HTMLElement, rows: LeaderRow[]): Promise<void> {
  const b = store.board;
  const arena = b ? arenaAt(arenaIndexAt(b.roundIndex)) : arenaAt(0);

  root.classList.add('splash-card-mode');
  root.innerHTML = `
    <div class="splash-card">
      <div class="art">
        ${arenaArt(arena)}
        <div class="art-fade"></div>
      </div>

      <div class="card-head">
        <div class="art-meta">
          <span class="art-round">${b ? `ROUND ${b.roundIndex}` : 'CLOCKSHOT'}</span>
          <span class="art-pips" title="difficulty ${arena.difficulty} of 5">
            difficulty ${pips(arena.difficulty)}
          </span>
        </div>
        <h1 class="art-title">${esc(arena.name)}</h1>
        <p class="art-blurb">${esc(arena.blurb)}</p>
      </div>

      <section class="board">
        <h2 class="section-label">fastest clears</h2>
        ${boardRows(rows)}
      </section>

      <section class="stats">
        ${stat('racing', b ? String(b.players) : '—')}
        ${stat('top', b && b.topScore !== null ? formatPoints(b.topScore) : '—', 'gold')}
        ${stat('your best', store.best > 0 ? formatPoints(store.best) : '—')}
      </section>

      <button type="button" class="card-cta">
        <span class="cta-main">TAKE THE RUN</span>
        <span class="cta-sub">${START_TIME_MS / 1000} seconds on the clock</span>
      </button>

      <button type="button" class="card-build">
        <span class="cta-main">BUILD A LEVEL</span>
        <span class="cta-sub">make an arena of your own</span>
      </button>

      <p class="card-foot">${footer()}</p>
    </div>
  `;

  return new Promise<void>((resolve) => {
    const run = root.querySelector<HTMLButtonElement>('.card-cta');
    const build = root.querySelector<HTMLButtonElement>('.card-build');
    if (!run) {
      choose('run');
      resolve();
      return;
    }

    /**
     * Either door spends the same trusted click.
     *
     * Full screen and the audio context both need a click the browser itself
     * produced, and the card is the only place the game is promised one — so
     * whichever button is pressed has to buy both, not just the one that
     * happens to start a run.
     */
    const open = (button: HTMLButtonElement, choice: Choice): void => {
      button.addEventListener(
        'click',
        (event) => {
          requestFullScreen(event);
          sfx.unlock();
          button.blur();
          choose(choice);
          resolve();
        },
        { once: true },
      );
    };

    open(run, 'run');
    if (build) open(build, 'build');
  });
}

/** Difficulty as five marks, so it reads before it is counted. */
function pips(level: number): string {
  return Array.from({ length: PIPS }, (_, i) =>
    i < level ? '<i class="pip on"></i>' : '<i class="pip"></i>',
  ).join('');
}

/**
 * The top three, plus you.
 *
 * Each row carries a bar of its own score against the leader's, so the gap
 * between first and third is a shape rather than an arithmetic problem. If the
 * reader is not in the top three their own row is appended anyway, because
 * "you are twelfth" is the line that makes someone take another run.
 */
function boardRows(rows: LeaderRow[]): string {
  if (rows.length === 0) {
    return `<p class="board-empty">No clears yet this round — the board is open.</p>`;
  }

  const top = rows.slice(0, 3);
  const you = rows.find((r) => r.isYou);
  const shown = you && !top.includes(you) ? [...top, you] : top;
  const lead = Math.max(...shown.map((r) => r.points), 1);

  return shown
    .map((r) => {
      const name = r.isYou ? 'you' : `u/${esc(r.username)}`;
      const width = Math.max(6, Math.round((r.points / lead) * 100));
      return `
        <div class="board-row${r.isYou ? ' you' : ''}">
          <span class="rank">${r.rank}</span>
          <span class="who">${name}</span>
          <span class="bar"><i style="width:${width}%"></i></span>
          <span class="score">${formatPoints(r.points)}</span>
        </div>`;
    })
    .join('');
}

/** One of the three readings under the board. */
function stat(label: string, value: string, tone = 'ink'): string {
  return `
    <div class="stat ${tone}">
      <b class="stat-value">${value}</b>
      <span class="stat-label">${label}</span>
    </div>`;
}

/**
 * The line under the button: the last thing that happened here.
 *
 * An empty round says so plainly. "Be the first" is a better offer than a
 * blank line, and it is only true when it is true.
 */
function footer(): string {
  const last = store.activity[0];
  if (!last) return `Nobody has run this course yet · <b>be the first</b>`;

  const who = last.username === store.username ? 'you' : `u/${esc(last.username)}`;
  return `Last run: ${who} · ${ago(store.serverNow() - last.at)} · scored <b>${formatPoints(
    last.points,
  )}</b>`;
}

/** Coarse relative time — the card only needs "recently" or "a while ago". */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Usernames come off the wire, and this card is HTML. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}
