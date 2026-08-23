export type Tier = 'easy' | 'medium' | 'hard';

export interface Word {
  word: string;
  tier: Tier;
  category: string;
}

/**
 * The word bank (GDD §6): time-themed, three tiers, drawer picks one of three
 * (one per tier). Guessers only ever receive the letter pattern and category —
 * the word itself is resolved here and compared locally, mirroring the
 * server-side check the GDD specifies.
 */
export const WORDS: Word[] = [
  // ---- easy ----
  { word: 'clock', tier: 'easy', category: 'object' },
  { word: 'alarm', tier: 'easy', category: 'object' },
  { word: 'candle', tier: 'easy', category: 'object' },
  { word: 'sunrise', tier: 'easy', category: 'nature' },
  { word: 'sunset', tier: 'easy', category: 'nature' },
  { word: 'moon', tier: 'easy', category: 'nature' },
  { word: 'calendar', tier: 'easy', category: 'object' },
  { word: 'watch', tier: 'easy', category: 'object' },
  { word: 'bell', tier: 'easy', category: 'object' },
  { word: 'season', tier: 'easy', category: 'idea' },
  { word: 'birthday', tier: 'easy', category: 'event' },
  { word: 'midnight', tier: 'easy', category: 'idea' },
  { word: 'noon', tier: 'easy', category: 'idea' },
  { word: 'week', tier: 'easy', category: 'idea' },
  { word: 'minute', tier: 'easy', category: 'idea' },
  { word: 'morning', tier: 'easy', category: 'idea' },
  { word: 'night', tier: 'easy', category: 'idea' },
  { word: 'winter', tier: 'easy', category: 'nature' },
  { word: 'egg timer', tier: 'easy', category: 'object' },
  { word: 'sand', tier: 'easy', category: 'nature' },

  // ---- medium ----
  { word: 'hourglass', tier: 'medium', category: 'object' },
  { word: 'stopwatch', tier: 'medium', category: 'object' },
  { word: 'snooze', tier: 'medium', category: 'action' },
  { word: 'eclipse', tier: 'medium', category: 'nature' },
  { word: 'lighthouse', tier: 'medium', category: 'place' },
  { word: 'metronome', tier: 'medium', category: 'object' },
  { word: 'deadline', tier: 'medium', category: 'idea' },
  { word: 'countdown', tier: 'medium', category: 'idea' },
  { word: 'overtime', tier: 'medium', category: 'idea' },
  { word: 'sundial', tier: 'medium', category: 'object' },
  { word: 'pendulum', tier: 'medium', category: 'object' },
  { word: 'anniversary', tier: 'medium', category: 'event' },
  { word: 'fuse', tier: 'medium', category: 'object' },
  { word: 'traffic light', tier: 'medium', category: 'object' },
  { word: 'parking meter', tier: 'medium', category: 'object' },
  { word: 'microwave', tier: 'medium', category: 'object' },
  { word: 'sunflower', tier: 'medium', category: 'nature' },
  { word: 'tide', tier: 'medium', category: 'nature' },
  { word: 'shift', tier: 'medium', category: 'idea' },
  { word: 'halftime', tier: 'medium', category: 'event' },
  { word: 'boarding pass', tier: 'medium', category: 'object' },
  { word: 'kettle', tier: 'medium', category: 'object' },
  { word: 'hibernation', tier: 'medium', category: 'nature' },
  { word: 'rehearsal', tier: 'medium', category: 'event' },

  // ---- hard ----
  { word: 'jet lag', tier: 'hard', category: 'idea' },
  { word: 'procrastination', tier: 'hard', category: 'idea' },
  { word: 'leap year', tier: 'hard', category: 'idea' },
  { word: 'time capsule', tier: 'hard', category: 'object' },
  { word: 'rush hour', tier: 'hard', category: 'event' },
  { word: 'time zone', tier: 'hard', category: 'idea' },
  { word: 'groundhog day', tier: 'hard', category: 'event' },
  { word: 'half life', tier: 'hard', category: 'idea' },
  { word: 'last minute', tier: 'hard', category: 'idea' },
  { word: 'slow motion', tier: 'hard', category: 'idea' },
  { word: 'daylight saving', tier: 'hard', category: 'idea' },
  { word: 'growth ring', tier: 'hard', category: 'nature' },
  { word: 'carbon dating', tier: 'hard', category: 'idea' },
  { word: 'expiry date', tier: 'hard', category: 'object' },
  { word: 'grandfather clock', tier: 'hard', category: 'object' },
  { word: 'fossil', tier: 'hard', category: 'nature' },
  { word: 'relay race', tier: 'hard', category: 'event' },
  { word: 'countdown clock', tier: 'hard', category: 'object' },
  { word: 'long weekend', tier: 'hard', category: 'idea' },
  { word: 'shooting star', tier: 'hard', category: 'nature' },
];

const BY_TIER: Record<Tier, Word[]> = {
  easy: WORDS.filter((w) => w.tier === 'easy'),
  medium: WORDS.filter((w) => w.tier === 'medium'),
  hard: WORDS.filter((w) => w.tier === 'hard'),
};

export function wordsOfTier(tier: Tier): Word[] {
  return BY_TIER[tier];
}

export function findWord(word: string): Word | undefined {
  return WORDS.find((w) => w.word === word);
}

/** The drawer's three choices: one per tier (GDD §6). */
export function threeChoices(rand: () => number): Word[] {
  return (['easy', 'medium', 'hard'] as Tier[]).map((tier) => {
    const pool = BY_TIER[tier];
    return pool[Math.floor(rand() * pool.length)];
  });
}

/** Tier bonus applied to the drawer's take (GDD §6). */
export const TIER_BONUS: Record<Tier, number> = { easy: 0, medium: 0.1, hard: 0.25 };

/** The letter pattern a guesser sees: dashes for letters, gaps kept. */
export function letterPattern(word: string, revealed: string): string {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === ' ') out += '  ';
    else out += (revealed[i] ?? '_') + ' ';
  }
  return out.trimEnd();
}

/** Letters only, for the "9 letters" readout. */
export function letterCount(word: string): number {
  return word.replace(/[^a-z]/gi, '').length;
}

// ---- guess validation (GDD §6) ------------------------------------------

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Accept an exact match, a singular/plural variation, or (for words of 6+
 * letters) a single typo — GDD §6. Deliberately forgiving: a mobile keyboard
 * should not be the thing that loses you the link.
 */
export function isCorrect(guess: string, word: string): boolean {
  const g = normalize(guess);
  const w = normalize(word);
  if (!g) return false;
  if (g === w) return true;
  if (g === w + 's' || w === g + 's') return true;
  if (g === w + 'es' || w === g + 'es') return true;
  // Compound words may be typed with or without the space.
  if (g.replace(/ /g, '') === w.replace(/ /g, '')) return true;
  if (w.length >= 6 && levenshtein(g, w) <= 1) return true;
  return false;
}
