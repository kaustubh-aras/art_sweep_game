import type Phaser from 'phaser';
import { getWebViewMode, requestExpandedMode } from '@devvit/web/client';
import { dpr } from '../ui/viewport';

/**
 * Full-screen play, on every device the game runs on.
 *
 * There are two ways to take over a screen, and the game uses whichever one it
 * has:
 *
 * - **Inside a Reddit post.** Reddit presents a post's web view *inline* by
 *   default — a fixed-height panel in a feed, between other posts — and will
 *   show it as a full-screen modal instead, but only if the app asks. The
 *   browser's own full-screen API is not available to ask with: the post lives
 *   in an iframe that does not carry the permission.
 * - **Anywhere else** — a desktop browser, a phone browser, `npm run dev` —
 *   there is no host to ask, so the Fullscreen API is used directly on the
 *   document. iOS Safari on iPhone implements it for video only; there the game
 *   stays as it was, which is already a fixed, full-viewport layout.
 *
 * Both routes have the same precondition: they only work during a **trusted DOM
 * click**. A game drawn entirely on a `<canvas>` never sees one — Phaser calls
 * `preventDefault()` on every touch over the canvas, which is what stops a
 * swing from turning into a page scroll, and that also suppresses the click a
 * tap would have produced.
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

/** Whether the post is currently presented full screen by Reddit. */
export function isExpanded(): boolean {
  // `getWebViewMode()` reads the `devvit` global unguarded, so it may only be
  // called once we know there is one.
  return inWebView() && getWebViewMode() === 'expanded';
}

/** The vendor-prefixed corners of the Fullscreen API, as optional members. */
interface FullScreenDoc extends Document {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
}

interface FullScreenEl extends HTMLElement {
  webkitRequestFullscreen?: () => unknown;
}

function doc(): FullScreenDoc | null {
  return typeof document === 'undefined' ? null : (document as FullScreenDoc);
}

/** The element handed to the browser: the whole page, so nothing is cropped. */
function fullScreenTarget(): FullScreenEl | null {
  return (doc()?.documentElement as FullScreenEl | undefined) ?? null;
}

/** Whether this browser will put the page full screen at all. */
export function canBrowserFullScreen(): boolean {
  const d = doc();
  const el = fullScreenTarget();
  if (!d || !el) return false;
  // `fullscreenEnabled` is false in an iframe without the permission — exactly
  // the Reddit case — and undefined on the older prefixed API, where the
  // request is worth attempting anyway.
  const allowed = d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? true;
  const askable =
    typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
  return allowed !== false && askable;
}

/** Whether the browser is showing the page full screen right now. */
export function isBrowserFullScreen(): boolean {
  const d = doc();
  if (!d) return false;
  return (d.fullscreenElement ?? d.webkitFullscreenElement ?? null) !== null;
}

/** Whether the game has the whole screen, by either route. */
export function isFullScreen(): boolean {
  return isExpanded() || isBrowserFullScreen();
}

/**
 * Asks the browser for the screen. Says whether the request went out.
 *
 * `requestFullscreen` rejects rather than throws when a browser declines, and
 * declining is not worth interrupting anything for: the game simply stays in
 * the window, which is how it has always played.
 */
function requestBrowserFullScreen(): boolean {
  const el = fullScreenTarget();
  if (!el || !canBrowserFullScreen()) return false;
  try {
    const asked = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.();
    void Promise.resolve(asked).catch((err: unknown) => {
      console.warn('[clockshot] full screen refused', err);
    });
  } catch (err) {
    console.warn('[clockshot] full screen refused', err);
    return false;
  }
  return true;
}

/**
 * Takes over the screen, on the click that is happening now.
 *
 * Only a click the browser itself produced counts; Reddit rejects anything a
 * script dispatched, and so does this. Failure is not worth interrupting
 * anything for either: an older client, or a surface with no full-screen
 * presentation of any kind, simply leaves the game where it is.
 */
export function requestFullScreen(event: MouseEvent): void {
  if (!event.isTrusted || isFullScreen()) return;

  if (inWebView()) {
    // Inside a post the host owns the presentation, and the Fullscreen API is
    // not ours to call: the iframe does not carry the permission.
    try {
      expandInPlace(event);
    } catch (err) {
      console.warn('[clockshot] expanded mode refused', err);
      return;
    }
  } else if (!requestBrowserFullScreen()) {
    return;
  }

  settleViewport();
}

/**
 * Re-measures the canvas after the presentation changes.
 *
 * `initViewport` already resizes on every `resize` event, and a viewport going
 * full screen normally fires one. "Normally" is doing real work in that
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

/**
 * What a proxy needs from the thing it stands in for.
 *
 * `Button` satisfies this as it is, and so does anything else that can report
 * where it is on screen and be pressed — which is what lets the level editor,
 * whose controls are hand-drawn rectangles rather than `Button`s, take the
 * screen by exactly the same route the menu does.
 */
export interface TapTarget {
  /** The target's rectangle in game units. */
  bounds(): { x: number; y: number; w: number; h: number };
  readonly isEnabled: boolean;
  readonly isVisible: boolean;
  readonly caption: string;
  /** Drives the target's own pressed look, so a press still reads as one. */
  setPressed(on: boolean): unknown;
  /** Fires the target's action, exactly as a tap on it would. */
  click(): unknown;
}

/** A transparent DOM button that stands in for a canvas control. */
export class TapProxy {
  private readonly el: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private readonly button: TapTarget,
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
 * Lays a tap proxy over a control, for the taps that open something.
 *
 * Every screen that leads somewhere the player wants the whole display for —
 * starting a run, opening the builder, testing a level they just built — hangs
 * one of these on the control that leads there, because the trusted click that
 * asks for the screen can only be had from the DOM.
 *
 * Returns `null` — and changes nothing — when the game already has the whole
 * screen and the canvas can simply be tapped, or when this device offers no way
 * to take it: an iPhone browser, where the Fullscreen API covers video only.
 * The caller owns what it gets back: `sync()` it whenever the screen is laid
 * out, and `destroy()` it when the screen goes away.
 */
export function attachTapProxy(scene: Phaser.Scene, button: TapTarget): TapProxy | null {
  if (isFullScreen()) return null;
  if (!inWebView() && !canBrowserFullScreen()) return null;

  const parent = scene.game.canvas?.parentElement;
  if (!parent) return null;

  return new TapProxy(parent, button);
}
