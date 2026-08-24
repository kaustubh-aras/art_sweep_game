import type { LevelPostResponse } from '@/shared/api';

/**
 * The level this post carries, if it carries one.
 *
 * Fetched once by the boot screen and kept here rather than threaded through
 * every scene that might want it. Three different screens ask the same question
 * — "am I a level post?" — at three different moments: the play scene wants the
 * arena, the results card wants the board to be that level's board, and the
 * editor wants to know whether PUBLISH would be creating a second post for a
 * level that already has one.
 *
 * Module state rather than a store subscription because the answer cannot
 * change. A post is one level for as long as it exists; there is nothing here
 * to keep in sync.
 */

let post: LevelPostResponse | null = null;

export function setLevelPost(next: LevelPostResponse | null): void {
  post = next;
}

/** The level this post is, or null on an ordinary Clockshot post. */
export function levelPost(): LevelPostResponse | null {
  return post?.level ? post : null;
}

/** Whether the player is looking at somebody's published level. */
export function isLevelPost(): boolean {
  return levelPost() !== null;
}
