// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Button } from '@/clockshot/ui';
import {
  attachTapProxy,
  isExpanded,
  isFullScreen,
  requestFullScreen,
  TapProxy,
} from '@/clockshot/immersive';

/**
 * Full-screen presentation is the one part of the client that playing the game
 * locally cannot fully exercise, and it has two implementations: an effect on
 * the wire inside a Reddit web view, and the browser's own Fullscreen API
 * everywhere else. The web-view tests drive the real `@devvit/web/client` and
 * read what it posts to the host; the browser tests install the Fullscreen API
 * that jsdom does not have, which is also what makes "this device cannot do it"
 * the default here — the case an iPhone browser is in.
 */

/** `WebViewImmersiveMode` from the effect protocol. */
const INLINE = 1;
const IMMERSIVE = 2;

type Posted = { immersiveMode?: { immersiveMode: number; entryUrl?: string } };

let post: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.fn>;

function enterWebView(mode: number = INLINE): void {
  (globalThis as { devvit?: unknown }).devvit = { webViewMode: mode, entrypoints: {}, token: 'tok' };
}

/** Every immersive-mode effect posted to the host so far. */
function modeEffects(): NonNullable<Posted['immersiveMode']>[] {
  return post.mock.calls
    .map(([msg]) => (msg as Posted).immersiveMode)
    .filter((m): m is NonNullable<Posted['immersiveMode']> => m != null);
}

/**
 * A click the browser really produced.
 *
 * `isTrusted` is unforgeable by specification — jsdom will not let a test build
 * an event that claims to be a user gesture, which is the entire point of the
 * flag — so the handler under test is handed one directly.
 */
function realClick(): MouseEvent {
  return { type: 'click', isTrusted: true, target: document.body } as MouseEvent;
}

/** The mutable state behind a stand-in button, so a test can move or hide it. */
interface FakeState {
  enabled: boolean;
  visible: boolean;
  rect: { x: number; y: number; w: number; h: number };
  clicks: number;
  pressed: boolean[];
}

/** A stand-in for the canvas button a proxy is laid over. */
function fakeButton(over: Partial<FakeState> = {}): { button: Button; state: FakeState } {
  const state: FakeState = {
    enabled: true,
    visible: true,
    rect: { x: 40, y: 200, w: 240, h: 52 },
    clicks: 0,
    pressed: [],
    ...over,
  };
  const button = {
    caption: 'PLAY',
    get isEnabled() {
      return state.enabled;
    },
    get isVisible() {
      return state.visible;
    },
    bounds: () => state.rect,
    click: () => (state.clicks += 1),
    setPressed: (on: boolean) => state.pressed.push(on),
  } as unknown as Button;
  return { button, state };
}

/** A scene: as much of one as `attachTapProxy` ever looks at. */
function fakeScene(canvas: HTMLCanvasElement | null): Parameters<typeof attachTapProxy>[0] {
  return { game: { canvas } } as unknown as Parameters<typeof attachTapProxy>[0];
}

function mountCanvas(): HTMLCanvasElement {
  const parent = document.createElement('div');
  parent.id = 'game';
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  return canvas;
}

function proxyElement(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.tap-proxy');
  if (!el) throw new Error('no tap proxy in the document');
  return el;
}

function rectOf(el: HTMLElement): string[] {
  return [el.style.left, el.style.top, el.style.width, el.style.height];
}

/** Property names put on the document by `withFullScreenApi`, for cleanup. */
const installed: [object, string][] = [];

function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
  installed.push([target, name]);
}

/**
 * Gives jsdom the Fullscreen API, which it does not implement.
 *
 * Returns the request spy, so a test can assert the page really was handed to
 * the browser rather than merely that nothing threw.
 */
function withFullScreenApi(opts: { enabled?: boolean; active?: boolean } = {}): {
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(() => Promise.resolve());
  define(document, 'fullscreenEnabled', opts.enabled ?? true);
  define(document, 'fullscreenElement', opts.active ? document.documentElement : null);
  define(document.documentElement, 'requestFullscreen', request);
  return { request };
}

beforeEach(() => {
  post = vi.fn();
  warn = vi.fn();
  vi.spyOn(window.parent, 'postMessage').mockImplementation(post);
  vi.spyOn(console, 'warn').mockImplementation(warn);
});

afterEach(() => {
  for (const [target, name] of installed.splice(0)) {
    delete (target as Record<string, unknown>)[name];
  }
  delete (globalThis as { devvit?: unknown }).devvit;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('asking for full screen', () => {
  it('asks the host to expand what is already loaded', () => {
    enterWebView();
    requestFullScreen(realClick());

    // The effect contract: "When specified, clients must unconditionally load
    // or reload the target web view. When unspecified, clients must never
    // reload the target web view." A reload here would restart the game at the
    // menu, on the very tap that asked to play.
    expect(modeEffects()).toEqual([{ immersiveMode: IMMERSIVE, entryUrl: undefined }]);
  });

  it('says nothing on a device that cannot do it at all', () => {
    // jsdom has no Fullscreen API, which is the iPhone-browser case: there is
    // no host to ask and nothing to call, so the game stays as it is.
    requestFullScreen(realClick());

    expect(isExpanded()).toBe(false);
    expect(post).not.toHaveBeenCalled();
    // Silence, not a caught exception: the Devvit client reads a global that
    // only a web view defines, so it may not be called at all out here.
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks the browser for the screen outside a Reddit web view', () => {
    const { request } = withFullScreenApi();

    requestFullScreen(realClick());

    expect(request).toHaveBeenCalledTimes(1);
    // Nothing goes on the wire: there is no host out here to send it to.
    expect(post).not.toHaveBeenCalled();
  });

  it('asks the host, not the browser, inside a Reddit web view', () => {
    // A post is an iframe without the full-screen permission, so the browser
    // API is not ours to call even on a client that defines it.
    const { request } = withFullScreenApi({ enabled: false });
    enterWebView();

    requestFullScreen(realClick());

    expect(modeEffects()).toEqual([{ immersiveMode: IMMERSIVE, entryUrl: undefined }]);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not ask again when the browser is already full screen', () => {
    const { request } = withFullScreenApi({ active: true });
    expect(isFullScreen()).toBe(true);

    requestFullScreen(realClick());

    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a browser click no user made', () => {
    const { request } = withFullScreenApi();

    requestFullScreen({ type: 'click', isTrusted: false, target: document.body } as MouseEvent);

    expect(request).not.toHaveBeenCalled();
  });

  it('re-measures the viewport after the browser hands over the screen', () => {
    vi.useFakeTimers();
    try {
      withFullScreenApi();
      const resized = vi.fn();
      window.addEventListener('resize', resized);

      requestFullScreen(realClick());
      vi.advanceTimersByTime(1000);
      window.removeEventListener('resize', resized);

      // Browsers animate the transition, reporting the old size for a beat.
      expect(resized.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a click no user made', () => {
    enterWebView();
    requestFullScreen({ type: 'click', isTrusted: false, target: document.body } as MouseEvent);

    expect(modeEffects()).toEqual([]);
  });

  it('does not ask again when the post is already full screen', () => {
    enterWebView(IMMERSIVE);
    expect(isExpanded()).toBe(true);

    requestFullScreen(realClick());
    expect(modeEffects()).toEqual([]);
  });

  it('re-measures the viewport, more than once', () => {
    vi.useFakeTimers();
    try {
      enterWebView();
      const resized = vi.fn();
      window.addEventListener('resize', resized);

      requestFullScreen(realClick());
      vi.advanceTimersByTime(1000);
      window.removeEventListener('resize', resized);

      // The modal animates open on some clients, which report the old size for
      // a beat; a single measurement would lay the game out for the panel it
      // has just left.
      expect(resized.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the tap proxy', () => {
  it('is not created where the screen cannot be taken', () => {
    // No web view and no Fullscreen API: there is nothing for a trusted click
    // to do, so the canvas is left to handle its own taps.
    const { button } = fakeButton();

    expect(attachTapProxy(fakeScene(mountCanvas()), button)).toBeNull();
    expect(document.querySelector('.tap-proxy')).toBeNull();
  });

  it('is created outside a Reddit web view when the browser can full-screen', () => {
    withFullScreenApi();
    const { button } = fakeButton();

    expect(attachTapProxy(fakeScene(mountCanvas()), button)).not.toBeNull();
    expect(document.querySelector('.tap-proxy')).not.toBeNull();
  });

  it('is not created when the browser is already full screen', () => {
    withFullScreenApi({ active: true });
    const { button } = fakeButton();

    expect(attachTapProxy(fakeScene(mountCanvas()), button)).toBeNull();
  });

  it('is not created when the post is already full screen', () => {
    enterWebView(IMMERSIVE);
    const { button } = fakeButton();

    expect(attachTapProxy(fakeScene(mountCanvas()), button)).toBeNull();
  });

  it('is not created before there is a canvas to sit over', () => {
    enterWebView();
    const { button } = fakeButton();

    expect(attachTapProxy(fakeScene(null), button)).toBeNull();
  });

  it('covers the button it stands for, in CSS pixels', () => {
    enterWebView();
    const { button } = fakeButton();
    attachTapProxy(fakeScene(mountCanvas()), button);

    // Game units are device pixels; the DOM is not. A proxy that skipped the
    // conversion would be twice the size of its button on a 2x phone.
    const el = proxyElement();
    expect(el.parentElement?.id).toBe('game');
    expect(el.getAttribute('aria-label')).toBe('PLAY');
    expect(rectOf(el)).toEqual(['40px', '200px', '240px', '52px']);
  });

  it('presses and releases the button under it', () => {
    enterWebView();
    const { button, state } = fakeButton();
    attachTapProxy(fakeScene(mountCanvas()), button);

    proxyElement().dispatchEvent(new Event('pointerdown'));
    proxyElement().dispatchEvent(new Event('pointerup'));

    expect(state.pressed).toEqual([true, false]);
  });

  it('runs the button action on a click', () => {
    enterWebView();
    const { button, state } = fakeButton();
    attachTapProxy(fakeScene(mountCanvas()), button);

    proxyElement().click();

    expect(state.clicks).toBe(1);
  });

  it('leaves a disabled button alone', () => {
    enterWebView();
    const { button, state } = fakeButton({ enabled: false });
    attachTapProxy(fakeScene(mountCanvas()), button);

    proxyElement().click();

    expect(state.clicks).toBe(0);
    expect(modeEffects()).toEqual([]);
  });

  it('keeps the events Phaser listens for off the window', () => {
    enterWebView();
    const { button } = fakeButton();
    attachTapProxy(fakeScene(mountCanvas()), button);

    // Phaser hit-tests window-level touches against the canvas, so anything
    // that reached the window here would press the button underneath a second
    // time — and on a phone the emulated mouse events would make that a third.
    const seen: string[] = [];
    for (const type of ['touchstart', 'touchend', 'touchcancel', 'mousedown', 'mouseup']) {
      window.addEventListener(type, () => seen.push(type));
      proxyElement().dispatchEvent(new Event(type, { bubbles: true }));
    }

    expect(seen).toEqual([]);
  });

  it('follows the button when the screen is laid out again', () => {
    enterWebView();
    const { button, state } = fakeButton();
    const proxy = attachTapProxy(fakeScene(mountCanvas()), button) as TapProxy;

    state.rect = { x: 10, y: 500, w: 300, h: 60 };
    proxy.sync();

    expect(rectOf(proxyElement())).toEqual(['10px', '500px', '300px', '60px']);
  });

  it('hides itself with the button it stands for', () => {
    enterWebView();
    const { button, state } = fakeButton();
    const proxy = attachTapProxy(fakeScene(mountCanvas()), button) as TapProxy;
    expect(proxyElement().hidden).toBe(false);

    state.visible = false;
    proxy.sync();

    // The results screen swaps its button stack for a team choice; a stand-in
    // left behind would swallow taps meant for the team buttons.
    expect(proxyElement().hidden).toBe(true);
  });

  it('leaves nothing behind when the screen goes away', () => {
    enterWebView();
    const { button } = fakeButton();
    const proxy = attachTapProxy(fakeScene(mountCanvas()), button) as TapProxy;

    proxy.destroy();

    expect(document.querySelector('.tap-proxy')).toBeNull();
  });
});
