import posterUrl from '@/assets/backdrop.jpg';
import webmUrl from '@/assets/backdrop.webm';
import mp4Url from '@/assets/backdrop.mp4';
import { reducedMotion } from './theme';

/**
 * The animated field behind everything.
 *
 * A `<video>` sitting under the canvas rather than a texture pumped through
 * Phaser. A video element is composited by the browser — on its own layer, on
 * the GPU, often on a decoder the CPU never touches — whereas a Phaser video
 * uploads a fresh 1280x720 frame to WebGL thirty times a second, next to a game
 * loop that has real work to do. The picture is identical and only one of them
 * costs anything.
 *
 * It is also why the canvas is transparent: the glass panels are meant to have
 * something moving behind them, and now they genuinely do.
 *
 * Everything here is about not paying for it twice:
 *
 * - The poster is a still of the source, shown instantly. If the loop is slow,
 *   or never arrives at all, the screen still has its backdrop.
 * - Nothing is fetched until the page is otherwise idle.
 * - A hidden tab decodes nothing.
 * - `prefers-reduced-motion` gets the still and no video element at all — not a
 *   paused one, which would still have been downloaded.
 *
 * There is deliberately no scrim over it any more. That means the interface
 * sits on raw video, whose brightness nothing controls — the glass palette was
 * solved against a known backdrop, so small text over a panel is no longer
 * guaranteed the 4.5:1 it was measured to have. Gameplay is unaffected: the
 * arena paints its own scrim inside the canvas (`PLAY_SCRIM`).
 */

let host: HTMLDivElement | null = null;

export function mountAmbient(): void {
  if (host?.isConnected) return;

  const parent = document.getElementById('game');
  if (!parent) return;

  host = document.createElement('div');
  host.id = 'cs-ambient';
  host.style.backgroundImage = `url(${posterUrl})`;

  // The still is the whole backdrop for anyone who has asked for less motion.
  // Returning early means the video is never even requested.
  if (reducedMotion()) {
    parent.prepend(host);
    return;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  // Chromium needs the attribute as well as the property for inline playback
  // inside a cross-origin frame, which is exactly where this runs.
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.preload = 'none';
  video.poster = posterUrl;

  for (const [src, type] of [
    [webmUrl, 'video/webm'],
    [mp4Url, 'video/mp4'],
  ]) {
    const source = document.createElement('source');
    source.src = src;
    source.type = type;
    video.append(source);
  }

  host.append(video);
  parent.prepend(host);

  // Deferred to idle: the first seconds belong to the game booting, and a
  // backdrop that arrives a moment late costs nobody anything.
  const begin = (): void => {
    video.preload = 'auto';
    video.load();
    void video.play().catch(() => {
      // Autoplay refused — a muted inline loop rarely is, but if it happens the
      // poster is already on screen and nothing needs saying.
    });
  };

  // `requestIdleCallback` is still missing from Safari, so it is felt for
  // rather than assumed.
  const idle = window.requestIdleCallback as typeof window.requestIdleCallback | undefined;
  if (typeof idle === 'function') idle(begin, { timeout: 2500 });
  else window.setTimeout(begin, 900);

  // A backgrounded post should not be decoding video. The browser does some of
  // this on its own, and does it inconsistently.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else void video.play().catch(() => {});
  });
}
