import { ART_WORDS } from './art';
import { hashString, mulberry32, synthesizeWord } from './synth';
import { findWord, type Tier } from './words';
import { bountyFor, solverPoints } from './scoring';
import type { Recording } from './strokes';
import { HEAT_GRID } from './tuning';

/** Handles for the simulated sub. Ordinary-looking, invented for the jam. */
export const HANDLES = [
  'marbles',
  'tinyoak',
  'nine_volt',
  'slow_tuesday',
  'quartzhands',
  'paperkite',
  'brass_owl',
  'mothlight',
  'half_past',
  'dune_static',
  'pocketfox',
  'lentil_hex',
  'grey_lantern',
  'twelve_ply',
  'sundog',
  'reef_and_rust',
];

export interface Solver {
  name: string;
  ms: number;
  cell: number;
  points: number;
}

/** One post in the chain. Mirrors the `post:{id}` hash in GDD §9. */
export interface ChainLink {
  n: number;
  word: string;
  tier: Tier;
  category: string;
  drawer: string;
  byPlayer: boolean;
  /** Seed for the synthesized community drawing. */
  seed: number;
  /** Real captured strokes — only kept for links the player drew. */
  strokes?: Recording;
  createdAt: number;
  upvotes: number;
  solvers: Solver[];
  heat: Record<number, number>;
  crackedBy?: string;
  crackedAfterMs?: number;
  /** True once the player themself has solved it. */
  playerSolved?: boolean;
}

export interface Profile {
  points: number;
  solves: number;
  draws: number;
  bestChain: number;
  runs: number;
  fastestSolveMs: number | null;
  biggestBounty: number;
}

export interface ChainState {
  version: 1;
  links: ChainLink[];
  profile: Profile;
  seenTutorial: boolean;
  muted: boolean;
}

const KEY = 'sweep.chain.v1';
/** Player recordings are the only bulky thing we persist; keep the last few. */
const KEEP_PLAYER_RECORDINGS = 6;

function emptyProfile(): Profile {
  return {
    points: 0,
    solves: 0,
    draws: 0,
    bestChain: 0,
    runs: 0,
    fastestSolveMs: null,
    biggestBounty: 0,
  };
}

/**
 * The chain, and the community traces on it (GDD §4, §6).
 *
 * The GDD puts this in Redis behind Devvit endpoints. This build has no
 * backend, so the same model lives in localStorage and the sub is simulated:
 * seeded links carry ages, bounties and solver walls so the very first screen
 * already shows that somebody was here — which is the pillar the whole design
 * hangs on.
 */
export class Chain {
  private state: ChainState;

  private constructor(state: ChainState) {
    this.state = state;
  }

  static load(): Chain {
    let state: ChainState | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ChainState;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.links)) state = parsed;
      }
    } catch {
      // Private mode, quota, or corrupt data — fall through to a fresh seed.
      state = null;
    }
    if (!state) state = seedChain();
    state.profile = { ...emptyProfile(), ...state.profile };
    return new Chain(state);
  }

  save(): void {
    try {
      // Trim bulky player recordings before writing so we never hit quota.
      const withStrokes = this.state.links.filter((l) => l.strokes);
      const drop = withStrokes.slice(0, Math.max(0, withStrokes.length - KEEP_PLAYER_RECORDINGS));
      for (const l of drop) delete l.strokes;
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      // Storage unavailable: the session still plays, it just will not persist.
    }
  }

  get links(): ChainLink[] {
    return this.state.links;
  }

  get profile(): Profile {
    return this.state.profile;
  }

  get seenTutorial(): boolean {
    return this.state.seenTutorial;
  }

  markTutorialSeen(): void {
    this.state.seenTutorial = true;
    this.save();
  }

  get muted(): boolean {
    return this.state.muted;
  }

  setMuted(m: boolean): void {
    this.state.muted = m;
    this.save();
  }

  /** Newest link first. */
  head(): ChainLink {
    return this.state.links[this.state.links.length - 1];
  }

  /** How long the chain has been alive. */
  aliveMs(): number {
    const first = this.state.links[0];
    return first ? Date.now() - first.createdAt : 0;
  }

  /** Live bounty for a link: grows while it is uncracked (GDD §6). */
  bounty(link: ChainLink): number {
    if (link.crackedBy) return 0;
    return bountyFor(Date.now() - link.createdAt, link.upvotes);
  }

  /** The next community link the player has not solved yet. */
  nextForPlayer(exclude: number[] = []): ChainLink | null {
    const pool = this.state.links.filter(
      (l) => !l.byPlayer && !l.playerSolved && !exclude.includes(l.n),
    );
    if (pool.length > 0) return pool[pool.length - 1];
    // Everything is solved: mint a fresh community link so the chain never ends.
    return this.appendCommunityLink();
  }

  /** Strokes for a link, synthesized on demand for community drawings. */
  recordingFor(link: ChainLink): Recording {
    if (link.strokes) return link.strokes;
    return synthesizeWord(link.word, link.seed) ?? { length: 60_000, strokes: [] };
  }

  /** Record the player's solve: stamp the wall, take the bounty, bank points. */
  registerSolve(link: ChainLink, ms: number, cell: number, points: number, bounty: number): void {
    link.playerSolved = true;
    link.solvers.push({ name: 'you', ms, cell, points });
    link.heat[cell] = (link.heat[cell] ?? 0) + 1;
    if (!link.crackedBy) {
      link.crackedBy = 'you';
      link.crackedAfterMs = Date.now() - link.createdAt;
    }
    const p = this.state.profile;
    p.solves++;
    p.points += points + bounty;
    p.fastestSolveMs = p.fastestSolveMs === null ? ms : Math.min(p.fastestSolveMs, ms);
    p.biggestBounty = Math.max(p.biggestBounty, bounty);
    this.save();
  }

  /** Post the player's drawing as the next link in the chain. */
  appendPlayerLink(word: string, tier: Tier, category: string, rec: Recording): ChainLink {
    const link: ChainLink = {
      n: this.head().n + 1,
      word,
      tier,
      category,
      drawer: 'you',
      byPlayer: true,
      seed: hashString(word + Date.now()),
      strokes: rec,
      createdAt: Date.now(),
      upvotes: 0,
      solvers: [],
      heat: {},
    };
    this.state.links.push(link);
    this.state.profile.draws++;
    this.save();
    return link;
  }

  /** Attribute the simulated sub's solves to a link the player drew. */
  registerDrawTake(link: ChainLink, solvers: Solver[], points: number): void {
    link.solvers.push(...solvers);
    for (const s of solvers) link.heat[s.cell] = (link.heat[s.cell] ?? 0) + 1;
    if (solvers.length > 0 && !link.crackedBy) {
      link.crackedBy = solvers[0].name;
      link.crackedAfterMs = solvers[0].ms;
    }
    this.state.profile.points += points;
    this.save();
  }

  finishRun(chainLength: number): void {
    const p = this.state.profile;
    p.runs++;
    p.bestChain = Math.max(p.bestChain, chainLength);
    this.save();
  }

  /** Mint a new community link on top of the chain. */
  appendCommunityLink(): ChainLink {
    const n = this.head().n + 1;
    const rand = mulberry32(hashString(`link:${n}:${Date.now()}`));
    const link = makeCommunityLink(n, rand, Date.now() - 3_600_000 * (1 + rand() * 5));
    this.state.links.push(link);
    this.save();
    return link;
  }

  /** Wipe local progress (used by the Reset action on the menu). */
  static reset(): Chain {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
    return new Chain(seedChain());
  }
}

// ---- seeding -------------------------------------------------------------

function makeCommunityLink(n: number, rand: () => number, createdAt: number): ChainLink {
  const word = ART_WORDS[Math.floor(rand() * ART_WORDS.length)];
  const meta = findWord(word);
  const drawer = HANDLES[Math.floor(rand() * HANDLES.length)];
  const solvers: Solver[] = [];
  const heat: Record<number, number> = {};

  // A few redditors already looked at it, and some of them cracked it.
  const lookers = 2 + Math.floor(rand() * 7);
  for (let i = 0; i < lookers; i++) {
    const cell = Math.floor(rand() * HEAT_GRID * HEAT_GRID);
    heat[cell] = (heat[cell] ?? 0) + 1;
  }

  return {
    n,
    word,
    tier: meta?.tier ?? 'easy',
    category: meta?.category ?? 'object',
    drawer,
    byPlayer: false,
    seed: hashString(`${word}:${n}:${drawer}`),
    createdAt,
    upvotes: Math.floor(rand() * 9),
    solvers,
    heat,
  };
}

/** A chain that already has history the first time the game is opened. */
function seedChain(): ChainState {
  const rand = mulberry32(0x5eed);
  const links: ChainLink[] = [];
  const now = Date.now();
  const count = 11;

  for (let i = 0; i < count; i++) {
    // Oldest link is about four days back; they thin out toward now.
    const age = (count - i) * (5 + rand() * 9) * 3_600_000;
    const link = makeCommunityLink(37 + i, rand, now - age);

    // Older links have already been cracked by the sub; the newest is open.
    if (i < count - 1) {
      const solves = 1 + Math.floor(rand() * 5);
      for (let s = 0; s < solves; s++) {
        const ms = Math.round(12_000 + rand() * 48_000);
        link.solvers.push({
          name: HANDLES[Math.floor(rand() * HANDLES.length)],
          ms,
          cell: Math.floor(rand() * HEAT_GRID * HEAT_GRID),
          points: solverPoints(ms),
        });
      }
      link.crackedBy = link.solvers[0].name;
      link.crackedAfterMs = Math.round(age * (0.2 + rand() * 0.6));
    }
    links.push(link);
  }

  return {
    version: 1,
    links,
    profile: emptyProfile(),
    seenTutorial: false,
    muted: false,
  };
}
