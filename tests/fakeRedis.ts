/**
 * An in-memory stand-in for the Devvit Redis client.
 *
 * It copies the real client's *semantics*, not just its shape — in particular
 * `set` with `nx` resolves to the empty string when the write is refused, which
 * is what the duplicate-run guard keys off. Getting that wrong here would make
 * the tests agree with a bug instead of catching it.
 */

interface ZEntry {
  member: string;
  score: number;
}

export class FakeRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, ZEntry[]>();
  private ttls = new Map<string, number>();

  /** Set by tests to make an operation blow up, for failure-path coverage. */
  failNext: string | null = null;

  private trip(op: string): void {
    if (this.failNext === op) {
      this.failNext = null;
      throw new Error(`fake redis: ${op} failed`);
    }
  }

  reset(): void {
    this.strings.clear();
    this.hashes.clear();
    this.zsets.clear();
    this.ttls.clear();
    this.failNext = null;
  }

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  private zset(key: string): ZEntry[] {
    let z = this.zsets.get(key);
    if (!z) {
      z = [];
      this.zsets.set(key, z);
    }
    return z;
  }

  async get(key: string): Promise<string | undefined> {
    this.trip('get');
    return this.strings.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; xx?: boolean; expiration?: Date },
  ): Promise<string> {
    this.trip('set');
    const exists = this.strings.has(key);
    // The real client returns the proto default (an empty string) when the
    // conditional write does not happen.
    if (options?.nx && exists) return '';
    if (options?.xx && !exists) return '';
    this.strings.set(key, value);
    if (options?.expiration) this.ttls.set(key, options.expiration.getTime());
    return 'OK';
  }

  async del(...keys: string[]): Promise<void> {
    this.trip('del');
    for (const k of keys) {
      this.strings.delete(k);
      this.hashes.delete(k);
      this.zsets.delete(k);
      this.ttls.delete(k);
    }
  }

  async exists(...keys: string[]): Promise<number> {
    this.trip('exists');
    return keys.filter(
      (k) => this.strings.has(k) || this.hashes.has(k) || this.zsets.has(k),
    ).length;
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.trip('expire');
    this.ttls.set(key, Date.now() + seconds * 1000);
  }

  async incrBy(key: string, value: number): Promise<number> {
    this.trip('incrBy');
    const next = Number(this.strings.get(key) ?? 0) + value;
    this.strings.set(key, String(next));
    return next;
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    this.trip('hGet');
    return this.hash(key).get(field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    this.trip('hGetAll');
    return Object.fromEntries(this.hash(key));
  }

  async hSet(key: string, fieldValues: Record<string, string>): Promise<number> {
    this.trip('hSet');
    const h = this.hash(key);
    let added = 0;
    for (const [f, v] of Object.entries(fieldValues)) {
      if (!h.has(f)) added++;
      h.set(f, String(v));
    }
    return added;
  }

  async hIncrBy(key: string, field: string, value: number): Promise<number> {
    this.trip('hIncrBy');
    const h = this.hash(key);
    const next = Number(h.get(field) ?? 0) + value;
    h.set(field, String(next));
    return next;
  }

  async zAdd(key: string, ...members: ZEntry[]): Promise<number> {
    this.trip('zAdd');
    const z = this.zset(key);
    let added = 0;
    for (const m of members) {
      const at = z.findIndex((e) => e.member === m.member);
      if (at === -1) {
        z.push({ ...m });
        added++;
      } else {
        z[at]!.score = m.score;
      }
    }
    return added;
  }

  async zIncrBy(key: string, member: string, value: number): Promise<number> {
    this.trip('zIncrBy');
    const z = this.zset(key);
    const found = z.find((e) => e.member === member);
    if (found) {
      found.score += value;
      return found.score;
    }
    z.push({ member, score: value });
    return value;
  }

  async zScore(key: string, member: string): Promise<number | undefined> {
    this.trip('zScore');
    return this.zset(key).find((e) => e.member === member)?.score;
  }

  async zCard(key: string): Promise<number> {
    this.trip('zCard');
    return this.zset(key).length;
  }

  async zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: { by: 'score' | 'lex' | 'rank'; reverse?: boolean },
  ): Promise<ZEntry[]> {
    this.trip('zRange');
    // Ascending by score, ties broken by member, matching Redis ordering.
    const sorted = [...this.zset(key)].sort(
      (a, b) => a.score - b.score || (a.member < b.member ? -1 : 1),
    );
    const ordered = options?.reverse ? sorted.reverse() : sorted;
    const s = Number(start);
    const e = Number(stop);
    const end = e < 0 ? ordered.length + e : e;
    return ordered.slice(s, end + 1).map((x) => ({ ...x }));
  }

  async zRemRangeByRank(key: string, start: number, stop: number): Promise<number> {
    this.trip('zRemRangeByRank');
    const z = this.zset(key);
    const sorted = [...z].sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : 1));
    const s = start < 0 ? sorted.length + start : start;
    const e = stop < 0 ? sorted.length + stop : stop;
    if (e < s) return 0;
    const doomed = new Set(sorted.slice(s, e + 1).map((x) => x.member));
    this.zsets.set(key, z.filter((x) => !doomed.has(x.member)));
    return doomed.size;
  }

  /** Test helper: what TTL was last written for a key, if any. */
  ttlOf(key: string): number | undefined {
    return this.ttls.get(key);
  }
}

export const fakeRedis = new FakeRedis();
