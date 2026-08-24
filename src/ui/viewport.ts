import Phaser from 'phaser';

/** GDD §11: cap the device pixel ratio at 2 so mobile webviews stay smooth. */
export const MAX_DPR = 2;

let currentDpr = 1;

/** Backing-store scale in use. Game units are device pixels; `44 * dpr()` is a
 *  44 CSS-pixel tap target. */
export function dpr(): number {
  return currentDpr;
}

/** CSS pixels -> game units. */
export function px(cssPx: number): number {
  return cssPx * currentDpr;
}

/**
 * Owns the canvas size.
 *
 * Phaser's RESIZE mode sizes the backing store in CSS pixels, which is soft on
 * a 3x phone screen. Instead the game runs in `Scale.NONE` at
 * `deviceRatio` game units with `zoom = 1 / deviceRatio`, so the canvas is
 * crisp while its CSS box still measures exactly the container — meaning the
 * canvas can never overflow and produce a scrollbar.
 *
 * Sizing follows `visualViewport` where available, which is what actually
 * changes when a mobile browser's address bar slides away — so the layout
 * settles without a reload and without the page ever scrolling.
 */
export function initViewport(game: Phaser.Game, parentId: string): void {
  const parent = document.getElementById(parentId);
  if (!parent) return;

  let queued = false;

  const apply = (): void => {
    queued = false;
    const nextDpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    const rect = parent.getBoundingClientRect();
    const cssW = Math.max(160, Math.floor(rect.width));
    const cssH = Math.max(160, Math.floor(rect.height));

    if (nextDpr !== currentDpr) {
      currentDpr = nextDpr;
      game.scale.setZoom(1 / currentDpr);
    }
    const w = Math.round(cssW * currentDpr);
    const h = Math.round(cssH * currentDpr);
    if (game.scale.width !== w || game.scale.height !== h) {
      game.scale.resize(w, h);
    }

    // Phaser's `resize()` only writes the canvas CSS box when the zoomed size
    // differs from the game size — at zoom 1 (any DPR-1 display, i.e. most
    // desktops) that check fails and the canvas keeps whatever CSS width it
    // booted with, leaving the game squashed into a corner of its container.
    // The CSS box must always be exactly the container, so pin it here.
    const canvas = game.canvas;
    if (canvas) {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
  };

  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(apply);
  };

  currentDpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
  game.scale.setZoom(1 / currentDpr);
  apply();

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', () => {
    // iOS reports the old size for a beat after the rotation animation starts.
    schedule();
    setTimeout(schedule, 120);
    setTimeout(schedule, 420);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', schedule);
    window.visualViewport.addEventListener('scroll', schedule);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule();
  });
  window.addEventListener('pageshow', schedule);

  // Entering or leaving full screen changes the viewport, and some browsers
  // animate the transition — reporting the old size for a beat, exactly like an
  // iOS rotation. Measure again over the next half second so the game is never
  // laid out for the window it has just left.
  const settle = (): void => {
    schedule();
    setTimeout(schedule, 120);
    setTimeout(schedule, 420);
  };
  document.addEventListener('fullscreenchange', settle);
  document.addEventListener('webkitfullscreenchange', settle);
}
