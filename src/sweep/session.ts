import { Chain, type ChainLink } from './chain';
import { CHAIN_TARGET } from './tuning';

export interface SolveEntry {
  n: number;
  word: string;
  ms: number;
  points: number;
  bounty: number;
}

export interface DrawEntry {
  n: number;
  word: string;
  readability: number;
  solves: number;
  points: number;
}

export type Outcome = 'complete' | 'broken';

/**
 * One run = one walk along the chain (GDD §4).
 *
 * Solve a link, take the baton, draw the next one, repeat. Reaching
 * `CHAIN_TARGET` solves completes the chain; running out of guesses on a link
 * breaks it. Everything a restart must forget lives here and nowhere else, so
 * `reset()` is the whole story for "start again cleanly".
 */
class Run {
  active = false;
  solved: SolveEntry[] = [];
  drawn: DrawEntry[] = [];
  /** Links already served this run, so we never repeat one. */
  served: number[] = [];
  currentLinkN = -1;
  outcome: Outcome | null = null;
  failedWord = '';
  startedAt = 0;

  reset(): void {
    this.active = false;
    this.solved = [];
    this.drawn = [];
    this.served = [];
    this.currentLinkN = -1;
    this.outcome = null;
    this.failedWord = '';
    this.startedAt = 0;
  }

  start(): void {
    this.reset();
    this.active = true;
    this.startedAt = Date.now();
  }

  get linksSolved(): number {
    return this.solved.length;
  }

  get target(): number {
    return CHAIN_TARGET;
  }

  get score(): number {
    let n = 0;
    for (const s of this.solved) n += s.points + s.bounty;
    for (const d of this.drawn) n += d.points;
    return n;
  }

  get solveScore(): number {
    return this.solved.reduce((a, s) => a + s.points, 0);
  }

  get bountyScore(): number {
    return this.solved.reduce((a, s) => a + s.bounty, 0);
  }

  get drawScore(): number {
    return this.drawn.reduce((a, d) => a + d.points, 0);
  }

  get bestSolveMs(): number | null {
    if (this.solved.length === 0) return null;
    return Math.min(...this.solved.map((s) => s.ms));
  }

  serve(link: ChainLink): void {
    this.currentLinkN = link.n;
    if (!this.served.includes(link.n)) this.served.push(link.n);
  }

  finish(outcome: Outcome, failedWord = ''): void {
    this.active = false;
    this.outcome = outcome;
    this.failedWord = failedWord;
  }
}

export const run = new Run();

let chainRef: Chain | null = null;

/** The persisted chain. Loaded lazily so no storage is touched at import time. */
export function chain(): Chain {
  if (!chainRef) chainRef = Chain.load();
  return chainRef;
}

export function resetChain(): Chain {
  chainRef = Chain.reset();
  run.reset();
  return chainRef;
}
