/**
 * The one gate between the post and the run.
 *
 * The splash card is a Reddit post: it is on screen before Phaser has drawn
 * anything, and the tap on TAKE THE RUN is the only trusted click the game is
 * promised. That tap now has to mean "play", not "show me a menu" — so the
 * boot screen waits here instead of starting a scene, and the card opens the
 * gate on the way out.
 *
 * It is a promise rather than an event because the two sides race: the card can
 * be tapped before the community state has landed, and the boot screen can be
 * ready long before anyone taps. A promise resolves that either way round — the
 * waiter gets the open the moment both are true, whichever happened first.
 */

let opened = false;
let release: (() => void) | null = null;

const opening = new Promise<void>((resolve) => {
  release = resolve;
});

/** Opens the gate. Safe to call more than once; only the first one counts. */
export function openGate(): void {
  if (opened) return;
  opened = true;
  release?.();
}

/** Resolves once the player has asked for the game. */
export function whenOpened(): Promise<void> {
  return opening;
}

/** Whether the player has already asked. */
export function isOpen(): boolean {
  return opened;
}
