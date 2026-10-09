// RateLimitDO: one token bucket per instance, named by the bucket key (spec "Architecture"; limits
// in "API" › Rate limits). State is deleted by an alarm as soon as the bucket is full again, so a
// per-IP bucket (whose key carries a hash of the IP) lives only for its window (spec "API", NFR-8).
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import type { RateLimitBucket, RateLimitDORpc, RateLimitDecision } from './types.js';

export interface BucketState {
  /** Tokens available at `at` (fractional while refilling). */
  tokens: number;
  /** Epoch ms of the last update. */
  at: number;
}

const STATE_KEY = 'bucket';

function checkBucket(bucket: RateLimitBucket, cost: number): void {
  if (!bucket.key) throw new TypeError('bucket key required');
  if (!Number.isSafeInteger(bucket.capacity) || bucket.capacity < 1) {
    throw new RangeError('bucket capacity must be a positive integer');
  }
  if (!Number.isSafeInteger(bucket.periodMs) || bucket.periodMs < 1) {
    throw new RangeError('bucket periodMs must be a positive integer');
  }
  if (!Number.isSafeInteger(cost) || cost < 0) throw new RangeError('cost must be >= 0');
}

/**
 * Refills `state` to `now` (capacity per `periodMs`, continuously) and takes `cost` tokens if
 * there are enough. A refused take leaves the tokens as they are. `fullAt` is when the bucket is
 * full again. Pure, for tests.
 */
export function takeFromBucket(
  state: BucketState | undefined,
  bucket: RateLimitBucket,
  cost: number,
  now: number,
): { state: BucketState; decision: RateLimitDecision; fullAt: number } {
  checkBucket(bucket, cost);
  const rate = bucket.capacity / bucket.periodMs;
  const elapsed = state ? Math.max(0, now - state.at) : 0;
  const before = state ? Math.min(bucket.capacity, state.tokens + elapsed * rate) : bucket.capacity;
  const allowed = cost <= before;
  const tokens = allowed ? before - cost : before;
  let retryAfterMs = 0;
  if (!allowed) {
    retryAfterMs =
      cost > bucket.capacity ? bucket.periodMs : Math.max(1, Math.ceil((cost - before) / rate));
  }
  return {
    state: { tokens, at: now },
    decision: { allowed, remaining: Math.floor(tokens), retryAfterMs },
    fullAt: now + Math.ceil((bucket.capacity - tokens) / rate),
  };
}

export class RateLimitDO extends DurableObject<Env> implements RateLimitDORpc {
  async take(bucket: RateLimitBucket, cost: number): Promise<RateLimitDecision> {
    const now = Date.now();
    const current = await this.ctx.storage.get<BucketState>(STATE_KEY);
    const next = takeFromBucket(current, bucket, cost, now);
    if (next.fullAt <= now) {
      // Still full (a zero-cost take): keep nothing.
      await this.ctx.storage.deleteAll();
      return next.decision;
    }
    await this.ctx.storage.put(STATE_KEY, next.state);
    await this.ctx.storage.setAlarm(next.fullAt);
    return next.decision;
  }

  /** The bucket is full again: drop its state, and with it any trace of the key's subject. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
