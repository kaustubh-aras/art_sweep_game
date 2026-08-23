import Phaser from 'phaser';
import { gameConfig } from './clockshot/game';
import { initViewport } from './ui/viewport';
import { sfx } from './clockshot/sfx';

// Single game instance. Inside Devvit Web this file is the webview entrypoint.
const game = new Phaser.Game(gameConfig);

// The canvas owns its own size from here on: device-ratio backing store, CSS
// box pinned to the container, and every viewport change handled without a
// reload — including the orientation changes a phone will throw at it.
initViewport(game, 'game');

/**
 * Audio may only start after a real user gesture, so the AudioContext is not
 * even constructed until the first touch — that way no browser ever logs an
 * autoplay warning.
 */
const unlock = (): void => {
  sfx.unlock();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock, { passive: true });
window.addEventListener('keydown', unlock);

/**
 * Backgrounding must not leave a sound hanging or burn battery on a hidden tab.
 *
 * Note what is deliberately *not* here: nothing pauses the game. A run is timed
 * against the server's clock, so switching apps can neither pause a run nor
 * extend it — coming back simply shows how far along it really is.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sfx.suspend();
  else sfx.resume();
});
window.addEventListener('blur', () => sfx.suspend());
window.addEventListener('focus', () => sfx.resume());

// Belt and braces against the browser trying to scroll or zoom the page: the
// canvas handles its own gestures, and nothing outside it is interactive.
document.addEventListener(
  'gesturestart',
  (e) => {
    e.preventDefault();
  },
  { passive: false },
);
document.addEventListener(
  'dblclick',
  (e) => {
    e.preventDefault();
  },
  { passive: false },
);

// Hand over from the HTML splash once Phaser has painted its first frame.
game.events.once(Phaser.Core.Events.READY, () => {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.classList.add('gone');
  window.setTimeout(() => splash.remove(), 400);
});
