/**
 * Stands in for `@devvit/web/server` in the local dev/test server.
 *
 * The point of this file is fidelity: the bundle it produces runs the *real*
 * `src/server/index.ts` — the same routing, validation and scoring that ships —
 * against an in-memory Redis. So a browser playing against this is exercising
 * the actual server logic, not a second implementation of it that could drift.
 *
 * Identity comes from an `x-dev-user` header, which is how a test plays as two
 * different Reddit accounts against one shared world.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer as nodeCreateServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fakeRedis } from './fakeRedis';

export const redis = fakeRedis;

interface DevContext {
  userId: string | undefined;
  username: string | undefined;
  subredditName: string;
  /** Milliseconds to shift this request's view of the clock. */
  timeOffset: number;
}

const als = new AsyncLocalStorage<DevContext>();

const ANON: DevContext = {
  userId: undefined,
  username: undefined,
  subredditName: 'clockshotdev',
  timeOffset: 0,
};

/**
 * Lets a test say "pretend it is thirty seconds later".
 *
 * The server reads the clock through `Date.now()`, so shifting it here is what
 * makes it possible to exercise run expiry and round rollover without a test
 * that actually sleeps for ten minutes. This lives in the dev harness on
 * purpose — the shipped server has no such hook.
 */
const realNow = Date.now.bind(Date);

/**
 * A whole-process clock shift, on top of the per-request one.
 *
 * Rounds — and therefore which arena is in play — are a pure function of the
 * wall clock, so this is how you stand the server up inside a specific round
 * without waiting for it. Dev harness only; the shipped server has no such hook.
 */
const BASE_OFFSET = Number(process.env.CLOCKSHOT_TIME_OFFSET ?? 0) || 0;

Date.now = () => realNow() + BASE_OFFSET + (als.getStore()?.timeOffset ?? 0);

/** Reads whichever user this request is acting as. */
export const context = new Proxy({} as Record<string, unknown>, {
  get(_t, prop: string) {
    const ctx = als.getStore() ?? ANON;
    if (prop in ctx) return (ctx as unknown as Record<string, unknown>)[prop];
    // Fields the server never branches on in these tests.
    const rest: Record<string, unknown> = {
      subredditId: 't5_dev',
      appName: 'clockshot',
      appSlug: 'clockshot',
      appVersion: '0.0.1',
      postId: undefined,
      commentId: undefined,
      postData: undefined,
      snoovatar: undefined,
      loid: undefined,
      metadata: {},
    };
    return rest[prop];
  },
});

export const reddit = {
  submitCustomPost: async () => ({
    url: 'https://reddit.com/r/clockshotdev/comments/dev',
    permalink: '/r/clockshotdev/comments/dev',
  }),
};

export function getServerPort(): number {
  return Number(process.env.CLOCKSHOT_PORT ?? 39700);
}

const CLIENT_ROOT = process.env.CLOCKSHOT_CLIENT ?? 'dist/client';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Wraps the app's request handler so API calls run inside a request context,
 * and anything else falls through to the built client — one origin, exactly
 * like the real web view.
 */
let created: ReturnType<typeof nodeCreateServer> | null = null;

/** The server most recently created, so a test can close it when it is done. */
export function currentServer(): ReturnType<typeof nodeCreateServer> | null {
  return created;
}

export function createServer(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
) {
  created = nodeCreateServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (path.startsWith('/api/') || path.startsWith('/internal/')) {
      const raw = req.headers['x-dev-user'];
      const name = Array.isArray(raw) ? raw[0] : raw;
      const rawOffset = req.headers['x-dev-time-offset'];
      const offset = Number(Array.isArray(rawOffset) ? rawOffset[0] : rawOffset) || 0;

      // A browser sends no header, so it plays as a default account; a test
      // asks for a logged-out viewer by saying "anon" explicitly.
      const who = name ?? process.env.CLOCKSHOT_USER ?? 'devplayer';
      const ctx: DevContext =
        who === 'anon'
          ? { ...ANON, timeOffset: offset }
          : {
              userId: `t2_${who}`,
              username: who,
              subredditName: 'clockshotdev',
              timeOffset: offset,
            };

      als.run(ctx, () => {
        void handler(req, res);
      });
      return;
    }

    void serveStatic(path, res);
  });
  return created;
}

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const rel = path === '/' ? '/index.html' : path;
  try {
    const buf = await readFile(join(CLIENT_ROOT, normalize(rel)));
    res.writeHead(200, {
      'content-type': MIME[extname(rel)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}
