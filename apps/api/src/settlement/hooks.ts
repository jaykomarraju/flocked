// Post-final hooks (wave-8 pinned interface; W8-B owns this file in wave 8). A mode is final when it
// reaches `settled`, `refunded` or `voided` (spec "Data model" › round_modes.final_at): Free at
// apply or refund (src/settlement/apply/free.ts), Stakes at `RoundFinalized` (the indexer's Stakes
// handler; wired by W8-D). Stats, streaks and referrals (W8-B) and the question's split quality and
// `question_used` notice (W8-A, registered by W8-D) run here.
//
// Every handler must be idempotent: a retried settlement, or a re-processed chain event, calls them
// all again. `runModeFinal` runs each one, logs every failure and then throws, so the caller's own
// retry (SettlementDO's applying phase, the settle queue, the indexer) runs them again; nothing is
// lost and nothing counts twice.
//
// This module and what it imports also run in Node (the e2e indexer tests import src/indexer/**):
// never import anything that pulls `cloudflare:workers` here.
import type { Mode, RoundKind } from '@flocked/shared';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { onQuestionModeFinal } from '../questions/final.js';
import { referralsOnModeFinal } from '../referrals/reward.js';
import { statsOnModeFinal } from '../stats/apply.js';

/** A daily- or room-round mode that just became final. */
export interface ModeFinalEvent {
  roundId: string;
  mode: Mode;
  kind: RoundKind;
  outcome: 'settled' | 'refunded' | 'voided';
}

export type ModeFinalHandler = (env: Env, event: ModeFinalEvent) => Promise<void>;

const handlers: ModeFinalHandler[] = [];

/** Registers a post-final handler; returns a function that removes it (tests). */
export function onModeFinal(handler: ModeFinalHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/**
 * Runs every handler for `event`, all of them even when one fails, then throws if any failed. The
 * handlers see D1 as the mode's final writes left it.
 */
export async function runModeFinal(env: Env, event: ModeFinalEvent): Promise<void> {
  const results = await Promise.allSettled(handlers.map((h) => h(env, event)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const f of failed) {
    log.error('mode_final_hook_failed', {
      ...event,
      error: f.reason instanceof Error ? f.reason.message : String(f.reason),
    });
  }
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} mode-final hook(s) failed for ${event.roundId}:${event.mode}`,
    );
  }
}

// W8-B: stats and streaks (daily rounds, both modes), referrals (daily Free). W8-A: split quality
// and the author's `question_used` notice (daily rounds; it credits nothing), registered by W8-D.
onModeFinal(statsOnModeFinal);
onModeFinal(referralsOnModeFinal);
onModeFinal(onQuestionModeFinal);
