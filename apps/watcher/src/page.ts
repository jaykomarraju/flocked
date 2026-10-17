// Paging the guardian signers (spec "Smart contract" › Challenge window, watcher and guardian:
// "Guardian signers are paged on any mismatch, unable-to-verify, or missing verdict 30 minutes
// after a proposal"). The real channel is the owner's (OA-18); here it is one webhook URL held as a
// secret, with the page kept in D1 until the webhook takes it, so an unreachable pager never loses
// a mismatch.
import {
  markPageDelivered,
  markPageFailed,
  putPage,
  undeliveredPages,
  type ProposalRow,
} from './db.js';
import type { Env } from './env.js';
import type { Verdict } from './verdict.js';

/** A verdict that is not a match pages once, under this key. */
export const verdictPageId = (v: Pick<Verdict, 'subject' | 'roundId'>): string =>
  `verdict:${v.subject}:${v.roundId}`;

/** A proposal with no verdict 30 minutes on pages once, under this key. */
export const missingPageId = (p: Pick<ProposalRow, 'roundId' | 'bundleHash'>): string =>
  `missing:${p.roundId}:${p.bundleHash}`;

/** How long after a proposal a still-missing verdict pages. */
export const MISSING_VERDICT_MS = 30 * 60 * 1000;

/** How many pages one tick tries to deliver. */
const FLUSH_LIMIT = 20;

/** How long one webhook POST may take. */
const PAGE_TIMEOUT_MS = 10_000;

export function queueVerdictPage(db: D1Database, v: Verdict, now: number): Promise<boolean> {
  return putPage(db, verdictPageId(v), 'verdict', { kind: 'verdict', verdict: v }, now);
}

export function queueMissingVerdictPage(
  db: D1Database,
  p: ProposalRow,
  now: number,
): Promise<boolean> {
  return putPage(
    db,
    missingPageId(p),
    'missing_verdict',
    {
      kind: 'missing_verdict',
      roundId: p.roundId,
      mode: 'stakes',
      chainRoundId: p.chainRoundId,
      bundleHash: p.bundleHash,
      txHash: p.txHash,
      proposedAt: p.proposedAt * 1000,
      noVerdictAfterMs: MISSING_VERDICT_MS,
    },
    now,
  );
}

/**
 * Posts every undelivered page to `PAGER_WEBHOOK_URL`. Without the secret the pages stay queued and
 * the watcher logs that the channel is missing: a page is never dropped and never mocked in a
 * deployed environment (plan.md 2.6).
 */
export async function flushPages(
  env: Env,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ delivered: number; failed: number; queued: number }> {
  const pending = await undeliveredPages(env.DB, FLUSH_LIMIT);
  if (pending.length === 0) return { delivered: 0, failed: 0, queued: 0 };
  const url = env.PAGER_WEBHOOK_URL;
  if (!url) {
    // Never log the URL itself; here there is none to log.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'pager_not_configured',
        queued: pending.length,
      }),
    );
    return { delivered: 0, failed: 0, queued: pending.length };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.PAGER_WEBHOOK_TOKEN) headers.authorization = `Bearer ${env.PAGER_WEBHOOK_TOKEN}`;

  let delivered = 0;
  let failed = 0;
  for (const page of pending) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: page.body,
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await markPageDelivered(env.DB, page.id, now);
      delivered += 1;
    } catch (e) {
      await markPageFailed(env.DB, page.id, (e as Error).message);
      failed += 1;
    }
  }
  return { delivered, failed, queued: pending.length - delivered };
}
