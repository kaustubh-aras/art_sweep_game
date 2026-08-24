import type Phaser from 'phaser';
import './ui.css';

/**
 * A DOM surface stacked exactly on top of the Phaser canvas.
 *
 * Full-screen interface — results, the board, pause, errors — is far cheaper to
 * build in HTML than in Phaser Graphics. Flexbox, padding, wrapping, scrolling,
 * focus rings and real buttons all come for free instead of being arithmetic
 * somebody has to maintain. More importantly, three things a canvas simply
 * cannot do:
 *
 * - **Trusted clicks.** Reddit only grants full screen during a real DOM click,
 *   and Phaser suppresses the click a tap over the canvas would have made. The
 *   workaround was `TapProxy` in `immersive.ts`: an invisible DOM button flown
 *   in formation with each canvas button, re-synced on every relayout. A screen
 *   built from real buttons does not need one.
 * - **Keyboard and assistive access.** A canvas has nothing to focus. Buttons
 *   here are `<button>`, so tab order, Enter/Space, focus rings and screen
 *   readers work because they were never broken.
 * - **Real frosted glass.** `backdrop-filter` genuinely blurs what is behind it,
 *   including the live game. The canvas version can only ever approximate it.
 *
 * Alignment is free here, which is worth saying because it usually is not:
 * `viewport.ts` pins the canvas CSS box to exactly its container, so a layer
 * with `inset: 0` in that same container lines up with the canvas by
 * construction — no transform to mirror, no scale to track. The layer works in
 * CSS pixels, which is the unit the rest of the web already agrees on.
 */

const LAYER_ID = 'cs-ui-layer';

/** The layer itself, created on first use. */
export function getUiLayer(): HTMLDivElement {
  const existing = document.getElementById(LAYER_ID);
  if (existing instanceof HTMLDivElement && existing.isConnected) return existing;

  const host = document.getElementById('game') ?? document.body;
  const el = document.createElement('div');
  el.id = LAYER_ID;
  host.append(el);
  return el;
}

/** A mounted screen. Always `destroy()` it from the scene's shutdown handler. */
export interface UiScreen {
  root: HTMLDivElement;
  /** First match for `selector`, typed. Throws if absent, to catch typos early. */
  find<T extends HTMLElement = HTMLElement>(selector: string): T;
  /** Every match for `selector`. */
  all<T extends HTMLElement = HTMLElement>(selector: string): T[];
  /** First match, or null — for parts of a screen that are conditional. */
  maybe<T extends HTMLElement = HTMLElement>(selector: string): T | null;
  /** Click handler on the first match. The event is passed through, because
   *  full screen can only be requested from the real one. */
  onClick(selector: string, handler: (event: MouseEvent) => void): void;
  /** Sets `textContent` if the element exists. Silent when it does not. */
  text(selector: string, value: string): void;
  destroy(): void;
}

/**
 * The DOM events Phaser turns into pointers.
 *
 * Both of its input managers listen on the *window*, not just the canvas, so a
 * tap that lands on a button in this layer is still hit-tested against the game
 * underneath. In the editor that means pressing UNDO would also paint a cell.
 * Stopping them at the screen root leaves the control as the single source of
 * the press — the same trick `TapProxy` used, applied once instead of per
 * button.
 */
const SWALLOWED = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'touchstart',
  'touchend',
  'touchcancel',
] as const;

/**
 * Mounts a screen into the layer.
 *
 * The markup is authored by the caller and is never player-supplied, so it goes
 * in as HTML. Anything that comes off the wire — a username, a server message —
 * must be set with `text()`, which cannot inject markup.
 */
export function mountScreen(html: string): UiScreen {
  const root = document.createElement('div');
  root.className = 'cs-screen';
  root.innerHTML = html;
  for (const type of SWALLOWED) {
    root.addEventListener(type, (event) => event.stopPropagation());
  }
  getUiLayer().append(root);

  const find = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const el = root.querySelector<T>(selector);
    if (!el) throw new Error(`mountScreen: nothing matches "${selector}"`);
    return el;
  };

  return {
    root,
    find,
    all: <T extends HTMLElement = HTMLElement>(selector: string): T[] =>
      Array.from(root.querySelectorAll<T>(selector)),
    maybe: <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
      root.querySelector<T>(selector),
    onClick: (selector, handler) => {
      find(selector).addEventListener('click', handler);
    },
    text: (selector, value) => {
      const el = root.querySelector(selector);
      if (el) el.textContent = value;
    },
    destroy: () => root.remove(),
  };
}

/**
 * Mounts a screen and takes it away when the scene shuts down.
 *
 * Phaser reuses scene instances, so a screen that outlived its scene would come
 * back stacked on top of the next one. Binding the teardown at the moment of
 * mounting is what stops that being something each scene has to remember.
 */
export function mountForScene(scene: Phaser.Scene, html: string): UiScreen {
  const ui = mountScreen(html);
  scene.events.once('shutdown', () => ui.destroy());
  scene.events.once('destroy', () => ui.destroy());
  return ui;
}

/** Escapes text destined for an HTML template. */
export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
