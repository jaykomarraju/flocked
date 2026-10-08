// RateLimitDO: per-user and per-IP token buckets (spec "Architecture"; limits in "API" › Rate
// limits). Stub; W3-A implements it.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { notImplemented } from './stub.js';
import type { RateLimitBucket, RateLimitDORpc, RateLimitDecision } from './types.js';

export class RateLimitDO extends DurableObject<Env> implements RateLimitDORpc {
  take(_bucket: RateLimitBucket, _cost: number): Promise<RateLimitDecision> {
    return notImplemented('RateLimitDO.take');
  }
}
