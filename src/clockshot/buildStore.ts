/**
 * Where a player's own levels live.
 *
 * On this device, and nowhere else. Clockshot's server is the authority on runs
 * and scores and knows nothing about layout — arenas are shipped in the client
 * — so there is no endpoint a built level could be posted to. Rather than
 * pretend otherwise, the library is honest local storage: your levels are yours,
 * on this browser, until there is somewhere to send them.
 *
 * Every read is defensive. Storage can be full, disabled, or hold something
 * another version of the game wrote, and none of those may stop the editor
 * opening — the worst case is an empty shelf.
 */

import { cloneLevel, reviveLevel, type BuildLevel } from './build';

const KEY_LIBRARY = 'clockshot.levels.v1';
/** The level currently being edited, saved or not. Survives a reload. */
const KEY_DRAFT = 'clockshot.draft.v1';

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    // Touching it is the only way to know: Safari's private mode hands back a
    // real object and throws on write.
    const probe = '__cs__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** True when levels written here will still be here next time. */
export function canPersist(): boolean {
  return storage() !== null;
}

/** Every saved level, newest first. */
export function loadLibrary(): BuildLevel[] {
  const raw = readJson(KEY_LIBRARY);
  if (!Array.isArray(raw)) return [];
  const out: BuildLevel[] = [];
  for (const item of raw) {
    const level = reviveLevel(item);
    if (level) out.push(level);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeLibrary(levels: BuildLevel[]): boolean {
  return writeJson(KEY_LIBRARY, levels);
}

/**
 * Saves a level, replacing any earlier version of it.
 *
 * Identity is the level's id, not its name: renaming a level keeps it the same
 * level, and two levels called MY ARENA are still two levels.
 */
export function saveLevel(level: BuildLevel): boolean {
  const stamped = { ...cloneLevel(level), updatedAt: Date.now() };
  const rest = loadLibrary().filter((l) => l.id !== stamped.id);
  return writeLibrary([stamped, ...rest]);
}

export function deleteLevel(id: string): boolean {
  return writeLibrary(loadLibrary().filter((l) => l.id !== id));
}

export function findLevel(id: string): BuildLevel | null {
  return loadLibrary().find((l) => l.id === id) ?? null;
}

/** True when this exact id is already on the shelf. */
export function isSaved(id: string): boolean {
  return loadLibrary().some((l) => l.id === id);
}

/* -------------------------------------------------------------------------- */
/* The draft                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The draft is written on every edit, which is what makes closing the post
 * mid-build survivable. It is separate from the library on purpose: work in
 * progress is not a level anyone should be able to play yet.
 */
export function saveDraft(level: BuildLevel): void {
  writeJson(KEY_DRAFT, level);
}

export function loadDraft(): BuildLevel | null {
  return reviveLevel(readJson(KEY_DRAFT));
}

export function clearDraft(): void {
  const s = storage();
  try {
    s?.removeItem(KEY_DRAFT);
  } catch {
    // Nothing to do: a draft that cannot be cleared is merely stale.
  }
}
