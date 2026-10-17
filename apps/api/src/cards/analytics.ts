// `share_landing` (spec "Analytics": server, roundId and shareId). One Analytics Engine data point
// per visit to a share page, with the sharer's referral code alongside, which is what a later
// `share_conversion` is matched against. Never throws: analytics must not fail a page.
import type { Env } from '../env.js';
import { log } from '../lib/log.js';

export type ShareAnalyticsEnv = Pick<Env, 'ANALYTICS' | 'ENVIRONMENT'>;

export interface ShareLanding {
  roundId: string;
  shareId: string;
  /** The card owner's referral code: the visit attributes to them (spec › Referral). */
  ref: string | null;
}

export function trackShareLanding(env: ShareAnalyticsEnv, event: ShareLanding): void {
  try {
    env.ANALYTICS.writeDataPoint({
      indexes: ['share_landing'],
      blobs: ['share_landing', env.ENVIRONMENT, event.roundId, event.shareId, event.ref ?? ''],
      doubles: [1],
    });
  } catch (err) {
    log.error('analytics_write_failed', {
      event: 'share_landing',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
