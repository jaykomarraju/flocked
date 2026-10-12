// Edge caching for public reads (spec "API": unauthenticated reads are cached at the edge for 5 s).
//
// Only anonymous requests read or fill the cache, and only public responses are stored: a room
// round's response (members only) is marked `private, no-store` and never put, so no cached entry
// for a URL can be a room round's. Signed-in requests are always answered fresh (`GET /rounds/today`
// also runs the caller's daily grant). Workers responses are not cached by the CDN on their own, so
// this goes through the Cache API (`caches.default`).
//
// The key is the path plus the route's validated query, sorted (W6-F1 R7): a parameter the route's
// schema doesn't know is dropped, so `?x=<random>` can't miss the cache (and make `/claims?wallet=`
// rebuild payout trees on every request). A route with no query schema keys on its path alone.
//
// Off on the local environment (tests and the stack): there the game clock can be pinned and moved,
// and a response cached on wall time would hide a change the next request should see.
import type { Context } from 'hono';
import type { Env } from '../env.js';
import type { AppEnv } from '../lib/auth-context.js';

/** Seconds a public read stays in the edge cache. */
export const EDGE_CACHE_SECONDS = 5;

export const PUBLIC_CACHE_CONTROL = `public, max-age=${EDGE_CACHE_SECONDS}`;
export const PRIVATE_CACHE_CONTROL = 'private, no-store';

/** The cache to use, or null when caching is off for this request. */
export interface EdgeCacheDeps {
  cache: () => Cache | null;
}

export const EDGE_CACHE_DEPS: EdgeCacheDeps = {
  cache: () => (typeof caches === 'undefined' ? null : caches.default),
};

function cacheFor(
  env: Pick<Env, 'ENVIRONMENT'>,
  anonymous: boolean,
  deps: EdgeCacheDeps,
): Cache | null {
  if (!anonymous || env.ENVIRONMENT === 'local') return null;
  return deps.cache();
}

/** One validated query value as it goes into the key. */
function keyValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

/**
 * The edge cache key for a read: origin and path, then the route's validated query (what its zod
 * schema kept: unknown parameters dropped), sorted by name. Undefined values are left out.
 */
export function cacheKey(c: Context<AppEnv>): Request {
  const url = new URL(c.req.url);
  // The validator's output for `query`, or undefined when the route has none.
  const valid = (c.req as unknown as { valid(target: 'query'): unknown }).valid('query');
  const params = new URLSearchParams();
  if (valid !== null && typeof valid === 'object') {
    const query = valid as Record<string, unknown>;
    for (const name of Object.keys(query).sort()) {
      const v = query[name];
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? (v as unknown[]) : [v]) {
        params.append(name, keyValue(item));
      }
    }
  }
  const search = params.toString();
  return new Request(`${url.origin}${url.pathname}${search ? `?${search}` : ''}`, {
    method: 'GET',
  });
}

/** A cached response for an anonymous request, if any. */
export async function cachedRead(
  c: Context<AppEnv>,
  deps: EdgeCacheDeps = EDGE_CACHE_DEPS,
): Promise<Response | null> {
  const cache = cacheFor(c.env, c.get('user') === undefined, deps);
  if (!cache) return null;
  return (await cache.match(cacheKey(c))) ?? null;
}

/**
 * Answers `body` as JSON. A public body gets `Cache-Control: public, max-age=5` and, for an
 * anonymous request, is put in the edge cache; a members-only body is `private, no-store`.
 */
export function readResponse(
  c: Context<AppEnv>,
  body: unknown,
  opts: { membersOnly: boolean },
  deps: EdgeCacheDeps = EDGE_CACHE_DEPS,
): Response {
  const res = c.json(body as object, 200, {
    'Cache-Control': opts.membersOnly ? PRIVATE_CACHE_CONTROL : PUBLIC_CACHE_CONTROL,
  });
  if (opts.membersOnly) return res;
  const cache = cacheFor(c.env, c.get('user') === undefined, deps);
  if (cache) {
    const put = cache.put(cacheKey(c), res.clone());
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      // No execution context (app.request in tests): the put still runs.
      void put;
    }
  }
  return res;
}
