import Phaser from 'phaser';
import { gameConfig } from './clockshot/game';
import { initViewport } from './ui/viewport';
import { sfx } from './clockshot/sfx';
import { mountSplash } from './clockshot/splash';
import { choose } from './clockshot/choice';

// Single game instance. Inside Devvit Web this file is the webview entrypoint.
const game = new Phaser.Game(gameConfig);

// The canvas owns its own size from here on: device-ratio backing store, CSS
// box pinned to the container, and every viewport change handled without a
// reload — including the orientation changes a phone will throw at it.
initViewport(game, 'game');

/**
 * Hand the keyboard back to real text fields.
 *
 * `Controls` registers A, D, SPACE, W, E, P, ESC and the arrows with Phaser's
 * keyboard manager, and capture calls `preventDefault` on every one of them —
 * at the window, for the whole page, and for as long as the game is running
 * rather than only during a run. Focus a DOM `<input>`, like the field that
 * names a level, and those keys are swallowed before the browser can type
 * them: "z" and "y" land, "a", "d" and space do not.
 *
 * Toggling capture off while a text field has focus is Phaser's own documented
 * answer. It is delegated on the document rather than bound to one field, so
 * every input the game grows later is covered without anyone remembering to.
 */
const isTextEntry = (node: EventTarget | null): boolean =>
  node instanceof HTMLInputElement ||
  node instanceof HTMLTextAreaElement ||
  (node instanceof HTMLElement && node.isContentEditable);

const setKeyCapture = (capturing: boolean): void => {
  const keyboard = game.input.keyboard;
  if (keyboard) keyboard.preventDefault = capturing;
};

document.addEventListener('focusin', (event) => {
  if (isTextEntry(event.target)) setKeyCapture(false);
});
document.addEventListener('focusout', (event) => {
  if (isTextEntry(event.target)) setKeyCapture(true);
});

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

/**
 * The splash card holds the screen until the player asks for the game.
 *
 * Phaser boots underneath it either way, so the menu is already drawn and the
 * board already fetched by the time the card comes away — the tap opens
 * something finished rather than starting a load.
 *
 * If the card itself fails there is no world in which a player should be left
 * looking at a spinner, so the overlay goes regardless.
 */
void mountSplash().catch((err: unknown) => {
  console.warn('[clockshot] splash failed', err);
  document.getElementById('splash')?.remove();
  // The card is gone, so the door it would have asked about is answered here.
  choose('run');
});
