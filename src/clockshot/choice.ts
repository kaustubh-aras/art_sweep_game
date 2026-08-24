/**
 * What the player asked the post for.
 *
 * The splash card now offers two doors — take the run, or build one of your
 * own — and the card is DOM while the thing that has to act on the answer is a
 * Phaser scene. This carries the answer between them.
 *
 * It is a promise rather than an event because the two sides race: the card can
 * be tapped before the community state has landed, and the boot screen can be
 * ready long before anyone taps. A promise settles that either way round — the
 * waiter gets the answer the moment both are true, whichever happened first.
 */

export type Choice = 'run' | 'build';

let chosen: Choice | null = null;
let settle: ((choice: Choice) => void) | null = null;

const choosing = new Promise<Choice>((resolve) => {
  settle = resolve;
});

/** Records the door taken. Only the first call counts. */
export function choose(choice: Choice): void {
  if (chosen !== null) return;
  chosen = choice;
  settle?.(choice);
}

/** Resolves once the player has picked a door. */
export function whenChosen(): Promise<Choice> {
  return choosing;
}

/** What was picked, or null while the card is still up. */
export function choiceMade(): Choice | null {
  return chosen;
}
