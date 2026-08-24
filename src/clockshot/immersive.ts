import type Phaser from 'phaser';
import { getWebViewMode, requestExpandedMode } from '@devvit/web/client';
import { dpr } from '../ui/viewport';
import type { Button } from './ui';

/**
 * Full-screen play inside a Reddit post.
 *
 * Reddit presents a post's web view *inline* by default — a fixed-height panel
 * in a feed, between other posts — and will show it as a full-screen modal
 * instead, but only if the app asks during a **trusted DOM click**. A game
 * drawn entirely on a `<canvas>` never sees one: Phaser calls `preventDefault()`
 * on every touch over the canvas, which is what stops a swing from turning into
 * a page scroll, and that also suppresses the click a tap would have produced.
 *
 * Switching that suppression off is not a way out. Without it a phone follows
 * the tap with emulated mouse events, and Phaser feeds those through its window
 * listeners as a second, separate press — every menu button would fire twice.
 *
 * So the click is taken where it can be had: a transparent DOM button laid
 * exactly over the canvas button that starts a run. It swallows the pointer
 * events Phaser would otherwise pick up (nothing is handled twice), drives that
 * button's own pressed state and action so the screen behaves as before, and
 * carries the request for full screen on the real click underneath.
 *
 * All of it is inert outside Reddit: `globalThis.devvit` exists only in a web
 * view, so local play, the dev server and the tests get no proxy and no effect.
 */

/**
 * `requestExpandedMode` types its entrypoint argument as required, but the
 * effect it sends treats it as optional, and the wire contract is explicit
 * about what that means: *"When specified, clients must unconditionally load or
 * reload the target web view. When unspecified, clients must never reload the
 * target web view."* Naming an entrypoint would therefore restart the game from
 * boot, dropping the player back at the menu on the very tap that asked to
 * play. Expanding what is already on screen is the only usable form.
 */
const expandInPlace = requestExpandedMode as unknown as (event: MouseEvent) => void;

function inWebView(): boolean {
  return typeof (globalThis as { devvit?: unknown }).devvit === 'object';
}

/** Whether the post is currently presented full screen. */
export function isExpanded(): boolean {
  // `getWebViewMode()` reads the `devvit` global unguarded, so it may only be
  // called once we know there is one.
  return inWebView() && getWebViewMode() === 'expanded';
}

/**
 * Asks Reddit to show the post full screen, on the click that is happening now.
 *
 * Only a click the browser itself produced counts; Reddit rejects anything a
 * script dispatched, and so does this. Failure is not worth interrupting
 * anything for either: an older client, or a surface with no expanded
 * presentation, simply leaves the game inline — which is how it has always
 * played.
 */
export function requestFullScreen(event: MouseEvent): void {
  if (!inWebView() || !event.isTrusted || isExpanded()) return;
  try {
    expandInPlace(event);
  } catch (err) {
    console.warn('[clockshot] expanded mode refused', err);
    return;
  }
  settleViewport();
}

/**
 * Re-measures the canvas after the presentation changes.
 *
 * `initViewport` already resizes on every `resize` event, and an iframe growing
 * to full screen normally fires one. "Normally" is doing real work in that
 * sentence: the transition is animated on some clients, which report the old
 * size for a beat, exactly like an iOS rotation. Measuring again over the next
 * second costs nothing and removes the chance of the game being laid out for
 * the panel it has just left.
 */
function settleViewport(): void {
  for (const ms of [0, 160, 420, 900]) {
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), ms);
  }
}

/**
 * The DOM events Phaser turns into pointers.
 *
 * Both managers listen on the window as well as the canvas, so a touch that
 * lands on the proxy would still be hit-tested against the button underneath
 * and run its action a second time. Stopping them here leaves the proxy as the
 * single source of the press.
 */
const SWALLOWED = ['mousedown', 'mouseup', 'touchstart', 'touchend', 'touchcancel'] as const;

/** A transparent DOM button that stands in for a canvas button. */
export class TapProxy {
  private readonly el: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private readonly button: Button,
  ) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tap-proxy';
    el.setAttribute('aria-label', this.button.caption);

    for (const type of SWALLOWED) {
      el.addEventListener(type, (event) => event.stopPropagation());
    }

    // The canvas button still looks like the thing being pressed, because it
    // is: the proxy only relays what the pointer is doing to it.
    el.addEventListener('pointerdown', () => this.button.setPressed(true));
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      el.addEventListener(type, () => this.button.setPressed(false));
    }

    el.addEventListener('click', (event) => {
      if (!this.button.isEnabled) return;
      requestFullScreen(event);
      // Leaving focus on a button that is about to be removed would let the
      // next Space — the jump key — press it again.
      el.blur();
      this.button.click();
    });

    parent.appendChild(el);
    this.el = el;
    this.sync();
  }

  /** Follows the button it stands for. Call whenever the screen is laid out. */
  sync(): void {
    const b = this.button.bounds();
    const d = dpr();
    const el = this.el;

    el.hidden = !this.button.isVisible;
    el.setAttribute('aria-label', this.button.caption);
    el.style.left = `${b.x / d}px`;
    el.style.top = `${b.y / d}px`;
    el.style.width = `${b.w / d}px`;
    el.style.height = `${b.h / d}px`;
  }

  destroy(): void {
    this.el.remove();
  }
}

/**
 * Lays a tap proxy over a button, for the buttons that start a run.
 *
 * Returns `null` — and changes nothing — outside a Reddit web view, or when the
 * post is already full screen and the canvas can simply be tapped. The caller
 * owns what it gets back: `sync()` it whenever the screen is laid out, and
 * `destroy()` it when the screen goes away.
 */
export function attachTapProxy(scene: Phaser.Scene, button: Button): TapProxy | null {
  if (!inWebView() || isExpanded()) return null;

  const parent = scene.game.canvas?.parentElement;
  if (!parent) return null;

  return new TapProxy(parent, button);
}
