// src/read/cache.ts (spec "API": unauthenticated reads are cached at the edge for 5 s; W6-D): only
// anonymous requests read or fill the cache, members-only bodies are never stored and say so, and the
// local environment (tests, the stack) caches nothing. A fake Cache stands in for caches.default.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import type { AppEnv } from '../../src/lib/auth-context.js';
import {
  EDGE_CACHE_SECONDS,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
  cachedRead,
  readResponse,
  type EdgeCacheDeps,
} from '../../src/read/cache.js';
import { fakeUser, withSession } from '../helpers/index.js';

/** An in-memory Cache API: match/put by URL, with call counts. */
function fakeCache() {
  const store = new Map<string, Response>();
  const calls = { cache: 0, match: 0, put: 0 };
  const cache = {
    match: vi.fn((req: Request) => {
      calls.match += 1;
      return Promise.resolve(store.get(req.url)?.clone());
    }),
    put: vi.fn((req: Request, res: Response) => {
      calls.put += 1;
      store.set(req.url, res);
      return Promise.resolve();
    }),
  } as unknown as Cache;
  const deps: EdgeCacheDeps = {
    cache: () => {
      calls.cache += 1;
      return cache;
    },
  };
  return { store, calls, deps };
}

/** A read route as the real ones are built: the cache first, then the body. */
function readApp(deps: EdgeCacheDeps, membersOnly: boolean) {
  let served = 0;
  const sub = new Hono<AppEnv>();
  sub.get('/thing', async (c) => {
    if (!membersOnly) {
      const cached = await cachedRead(c, deps);
      if (cached) return cached;
    }
    served += 1;
    return readResponse(c, { served }, { membersOnly }, deps);
  });
  return { sub, served: () => served };
}

const URL = 'https://flocked.test/thing';
const staging = (): Env => ({ ...(env as Env), ENVIRONMENT: 'staging' });

describe('edge cache for reads', () => {
  it('stores an anonymous public read and serves the next anonymous request from it', async () => {
    const f = fakeCache();
    const r = readApp(f.deps, false);
    const app = withSession(r.sub);
    const first = await app.request(URL, {}, staging());
    expect(first.headers.get('Cache-Control')).toBe(PUBLIC_CACHE_CONTROL);
    expect(PUBLIC_CACHE_CONTROL).toBe(`public, max-age=${EDGE_CACHE_SECONDS}`);
    expect(EDGE_CACHE_SECONDS).toBe(5);
    expect(await first.json()).toEqual({ served: 1 });
    expect(f.calls.put).toBe(1);
    expect([...f.store.keys()]).toEqual([URL]);

    const second = await app.request(URL, {}, staging());
    expect(await second.json()).toEqual({ served: 1 });
    expect(r.served()).toBe(1);
    expect(f.calls.put).toBe(1);
  });

  it('hands the put to waitUntil when there is an execution context', async () => {
    const f = fakeCache();
    const app = withSession(readApp(f.deps, false).sub);
    const waitUntil = vi.fn();
    const ctx = {
      waitUntil,
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    await app.request(URL, {}, staging(), ctx);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(f.calls.put).toBe(1);
  });

  it('never reads or fills the cache for a signed-in request', async () => {
    const f = fakeCache();
    const r = readApp(f.deps, false);
    // Something anonymous is cached already: a signed-in caller still gets a fresh answer.
    await withSession(r.sub).request(URL, {}, staging());
    f.calls.cache = 0;
    f.calls.match = 0;
    f.calls.put = 0;
    const app = withSession(r.sub, fakeUser());
    const res = await app.request(URL, {}, staging());
    expect(await res.json()).toEqual({ served: 2 });
    expect(res.headers.get('Cache-Control')).toBe(PUBLIC_CACHE_CONTROL);
    expect(f.calls).toEqual({ cache: 0, match: 0, put: 0 });
  });

  it('never stores a members-only body, and marks it private, no-store', async () => {
    const f = fakeCache();
    const r = readApp(f.deps, true);
    for (const app of [withSession(r.sub), withSession(r.sub, fakeUser())]) {
      const res = await app.request(URL, {}, staging());
      expect(res.headers.get('Cache-Control')).toBe(PRIVATE_CACHE_CONTROL);
      expect(PRIVATE_CACHE_CONTROL).toBe('private, no-store');
    }
    expect(r.served()).toBe(2);
    expect(f.calls.put).toBe(0);
    expect(f.store.size).toBe(0);
  });

  it('is off on the local environment', async () => {
    const f = fakeCache();
    const r = readApp(f.deps, false);
    const app = withSession(r.sub);
    const local: Env = { ...(env as Env), ENVIRONMENT: 'local' };
    for (let i = 1; i <= 2; i++) {
      const res = await app.request(URL, {}, local);
      expect(await res.json()).toEqual({ served: i });
      expect(res.headers.get('Cache-Control')).toBe(PUBLIC_CACHE_CONTROL);
    }
    expect(f.calls).toEqual({ cache: 0, match: 0, put: 0 });
  });
});
