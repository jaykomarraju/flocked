// Rate limits (spec "API" › Rate limits), enforced in RateLimitDO: one instance per bucket key.
// Per-user buckets are keyed by user ID; per-IP buckets by a hash of the IP, and RateLimitDO drops
// a bucket's state once it is full again, so IPs are kept only for the window.
import type { Context, MiddlewareHandler } from 'hono';
import type { RateLimitBucket, RateLimitDecision } from '../do/types.js';
import type { Env } from '../env.js';
import { getUser, type AppEnv } from '../lib/auth-context.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { sha256Hex } from './crypto.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Bucket sizes: capacity tokens per period, refilled continuously. */
export const RATE_LIMITS = {
  /** Per user (spec). */
  entries: { capacity: 10, periodMs: MINUTE },
  questions: { capacity: 3, periodMs: DAY },
  votes: { capacity: 60, periodMs: MINUTE },
  writes: { capacity: 30, periodMs: MINUTE },
  merges: { capacity: 1, periodMs: 30 * DAY },
  /** Per IP, shared by the unauthenticated auth endpoints (the spec leaves the size open). */
  authIp: { capacity: 30, periodMs: MINUTE },
  /** Per email address: "about 10 codes per hour". */
  emailCodes: { capacity: 10, periodMs: HOUR },
} as const satisfies Record<string, Omit<RateLimitBucket, 'key'>>;

export type RateLimitName = keyof typeof RATE_LIMITS;
export type UserRateLimit = 'entries' | 'questions' | 'votes' | 'writes' | 'merges';

export function userBucket(userId: string, name: UserRateLimit): RateLimitBucket {
  return { key: `user:${userId}:${name}`, ...RATE_LIMITS[name] };
}

/** The client IP Cloudflare saw; `unknown` when absent (local requests without the header). */
export function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}

/** The per-IP auth bucket. The key holds a hash of the IP, never the IP itself. */
export async function ipAuthBucket(ip: string): Promise<RateLimitBucket> {
  return { key: `ip:${await sha256Hex(`ip:${ip}`)}:auth`, ...RATE_LIMITS.authIp };
}

export function emailCodeBucket(emailHash: string): RateLimitBucket {
  return { key: `email:${emailHash}:codes`, ...RATE_LIMITS.emailCodes };
}

/**
 * Takes `cost` tokens. A RateLimitDO failure lets the request through (logged): the limits that
 * guard secrets, such as 5 attempts per email code, are counted in AuthDO instead.
 */
export async function take(
  env: Pick<Env, 'RATE_LIMIT'>,
  bucket: RateLimitBucket,
  cost = 1,
): Promise<RateLimitDecision> {
  try {
    const stub = env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(bucket.key));
    return await stub.take(bucket, cost);
  } catch (err) {
    log.error('rate_limit_unavailable', {
      bucket: bucket.key.split(':')[0],
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, remaining: 0, retryAfterMs: 0 };
  }
}

/** Takes from `bucket` or throws 429 `rate_limited` with a Retry-After header. */
export async function enforce(c: Context<AppEnv>, bucket: RateLimitBucket, cost = 1) {
  const decision = await take(c.env, bucket, cost);
  if (!decision.allowed) {
    c.header('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
    throw new HttpError('rate_limited', 'Too many requests; try again later');
  }
}

/** Middleware: one token from the caller's per-IP auth bucket. */
export const limitAuthIp: MiddlewareHandler<AppEnv> = async (c, next) => {
  await enforce(c, await ipAuthBucket(clientIp(c)));
  await next();
};

/** Middleware: one token from the signed-in user's `name` bucket (after `requireUser`). */
export function limitUser(name: UserRateLimit): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await enforce(c, userBucket(getUser(c).id, name));
    await next();
  };
}
