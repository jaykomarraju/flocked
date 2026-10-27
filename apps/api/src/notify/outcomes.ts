// Outcome notices, enqueued where each mode's result becomes durable in D1 (spec "Notifications":
// `outcome`, `refunded`, `payout_claimable`). Daily rounds only: room rounds' results appear in the
// app only. Every entrant with an account gets a message; the consumer's dedupe keys decide what is
// sent, so these may run again (a retried settlement, a re-processed chain event) without repeats.
//   * `outcome` (`outcome:{gameDay}:{userId}`): each mode's result at its reveal: Free at apply or
//     refund (the post-final hook), Stakes at the confirmed `OutcomeProposed` (indexer), a void at
//     `applyVoid` and in the scheduler tick's sweep (a guardian void), and a Stakes `refundTooFew` /
//     `refundTimeout` at `RoundRefunded` when no proposal preceded it. The first to reach the consumer
//     is the user's combined message; later ones are app-only or, for a later-event refund,
//     `refunded` (consumer.ts `laterRefund`);
//   * `refunded` (`refunded:{roundId}:{mode}:{userId}`): a Stakes refund proposal finalized (any of
//     reasons 1, 2 and 3) or a vetoed settlement refunded (5);
//   * `payout_claimable` (`payout_claimable:{roundId}:stakes:{userId}`): a Stakes settlement final and
//     its claims open, to every account with a payout.
// Enqueue failures throw, so the caller's own retry (the settlement coordinator, the indexer entry,
// the RoundDO void) sends them again. This module also runs in Node (the e2e indexer tests import
// src/indexer/**): it must never import anything that pulls `cloudflare:workers`.
import { gameDayOf, type Mode, type NotifyMessage, type RefundReason } from '@flocked/shared';
import type { Env } from '../env.js';
import type { ModeFinalEvent } from '../settlement/hooks.js';

type OutcomeMessage = Extract<NotifyMessage, { event: 'outcome' }>;
type NotifyQueueEnv = Pick<Env, 'DB' | 'QUEUE_NOTIFY'>;

/** `sendBatch` takes at most 100 messages. */
const SEND_BATCH_MAX = 100;

const REFUNDED_STATUSES = new Set(['refund_proposed', 'refunded', 'voided']);
/** Stakes states that mirror a proposal the contract hasn't finalized yet (spec "Round lifecycle"). */
const PROPOSED_STATUSES = new Set(['settle_proposed', 'refund_proposed']);

interface ModeRow {
  kind: 'daily' | 'room';
  closes_at: number;
  status: string;
  refund_reason: number | null;
  claims_open_at: number | null;
  outcome: string | null;
  winners_json: string | null;
}

async function modeRow(db: D1Database, roundId: string, mode: Mode): Promise<ModeRow | null> {
  return db
    .prepare(
      `SELECT r.kind, r.closes_at, m.status, m.refund_reason, m.claims_open_at, s.outcome, s.winners_json
       FROM rounds r JOIN round_modes m ON m.round_id = r.id AND m.mode = ?2
       LEFT JOIN settlements s ON s.round_id = r.id AND s.mode = ?2 AND s.superseded_at IS NULL
       WHERE r.id = ?1`,
    )
    .bind(roundId, mode)
    .first<ModeRow>();
}

async function send(env: NotifyQueueEnv, messages: readonly NotifyMessage[]): Promise<number> {
  for (let i = 0; i < messages.length; i += SEND_BATCH_MAX) {
    await env.QUEUE_NOTIFY.sendBatch(
      messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })),
    );
  }
  return messages.length;
}

/** The daily round open at `closesAt` (the next question), if any. */
async function nextDailyRound(db: D1Database, roundId: string, closesAt: number) {
  const row = await db
    .prepare(
      `SELECT id FROM rounds
       WHERE kind = 'daily' AND id <> ?1 AND opens_at <= ?2 AND closes_at > ?2 AND status = 'open'
       ORDER BY opens_at DESC LIMIT 1`,
    )
    .bind(roundId, closesAt)
    .first<{ id: string }>();
  return row?.id ?? null;
}

interface EntrantRow {
  user_id: string;
  stake: number;
  option_index: 0 | 1 | null;
  valid: number | null;
  paid: number | null;
}

/**
 * The `outcome` messages for a daily mode's entrants, from what D1 holds now; none for a room round
 * or a mode without a result yet.
 */
export async function modeOutcomeMessages(
  db: D1Database,
  roundId: string,
  mode: Mode,
): Promise<OutcomeMessage[]> {
  const m = await modeRow(db, roundId, mode);
  if (!m || m.kind !== 'daily') return [];
  const refunded = REFUNDED_STATUSES.has(m.status);
  const settled = m.status === 'settled' || m.status === 'settle_proposed';
  if (!refunded && !settled) return [];
  // A Stakes proposal is not final: `provisional` tells the consumer that a refund told here is the
  // day's outcome only when it is the user's first, and `refunded` when it becomes final (R2).
  const provisional = PROPOSED_STATUSES.has(m.status);
  let winner: 0 | 1 | null = null;
  if (settled) {
    const w = m.winners_json ? (JSON.parse(m.winners_json) as { winner?: 0 | 1 | null }) : null;
    winner = w?.winner ?? null;
    if (winner === null) return [];
  }
  const { results } = await db
    .prepare(
      // One message per account: the first entry (a person enters a mode once).
      `SELECT e.user_id, e.stake, e.option_index, e.valid,
              (SELECT sum(p.amount) FROM payouts p
               WHERE p.round_id = e.round_id AND p.mode = e.mode AND p.user_id = e.user_id) AS paid
       FROM entries e
       WHERE e.round_id = ?1 AND e.mode = ?2 AND e.user_id IS NOT NULL
       GROUP BY e.user_id`,
    )
    .bind(roundId, mode)
    .all<EntrantRow>();
  const gameDay = gameDayOf(Math.floor(m.closes_at / 1000));
  const nextRoundId = await nextDailyRound(db, roundId, m.closes_at);
  return results.map((e): OutcomeMessage => {
    let result: OutcomeMessage['payload']['result'];
    let amount: string | null = null;
    if (refunded) result = 'refund';
    else if (e.valid === 0) result = 'void';
    else result = e.option_index === winner ? 'win' : 'loss';
    // Free shows its net points on a win; a Stakes payout is in the payout tree until RoundFinalized.
    if (result === 'win' && mode === 'free' && e.paid !== null) {
      amount = (BigInt(e.paid) - BigInt(e.stake)).toString();
    }
    return {
      event: 'outcome',
      userId: e.user_id,
      dedupeKey: `outcome:${gameDay}:${e.user_id}`,
      payload: {
        roundId,
        gameDay,
        mode,
        result,
        amount,
        nextRoundId,
        refundReason: result === 'refund' ? (m.refund_reason ?? 1) : null,
        ...(provisional ? { provisional: true } : {}),
      },
    };
  });
}

/** Enqueues each entrant's `outcome` for a daily mode. Returns how many were enqueued. */
export async function enqueueModeOutcome(
  env: NotifyQueueEnv,
  roundId: string,
  mode: Mode,
): Promise<number> {
  return send(env, await modeOutcomeMessages(env.DB, roundId, mode));
}

/**
 * Enqueues `outcome` (refund, reason 4) for every voided mode of a daily round (`applyVoid`; W4-Z: a
 * confirmed round void tells everyone who entered). It reads every voided mode, not only those voided
 * by this call, so a retried void sends what a failed attempt didn't (the consumer drops repeats).
 */
export async function enqueueVoidOutcomes(env: NotifyQueueEnv, roundId: string): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT mode FROM round_modes WHERE round_id = ?1 AND status = 'voided'",
  )
    .bind(roundId)
    .all<{ mode: Mode }>();
  let n = 0;
  for (const { mode } of results) n += await enqueueModeOutcome(env, roundId, mode);
  return n;
}

/** Enqueues `refunded` to each account that entered a daily mode. */
export async function enqueueRefunded(
  env: NotifyQueueEnv,
  roundId: string,
  mode: Mode,
  refundReason: RefundReason,
): Promise<number> {
  const m = await modeRow(env.DB, roundId, mode);
  if (!m || m.kind !== 'daily') return 0;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM entries
     WHERE round_id = ?1 AND mode = ?2 AND user_id IS NOT NULL`,
  )
    .bind(roundId, mode)
    .all<{ user_id: string }>();
  return send(
    env,
    results.map(({ user_id }): NotifyMessage => ({
      event: 'refunded',
      userId: user_id,
      dedupeKey: `refunded:${roundId}:${mode}:${user_id}`,
      payload: { roundId, mode, refundReason },
    })),
  );
}

/** Enqueues `payout_claimable` to each account with a payout in a final Stakes settlement. */
export async function enqueuePayoutClaimable(
  env: NotifyQueueEnv,
  roundId: string,
): Promise<number> {
  const m = await modeRow(env.DB, roundId, 'stakes');
  if (!m || m.kind !== 'daily' || m.status !== 'settled' || m.claims_open_at === null) return 0;
  const claimsOpenAt = m.claims_open_at;
  const { results } = await env.DB.prepare(
    `SELECT user_id, sum(amount) AS amount FROM payouts
     WHERE round_id = ?1 AND mode = 'stakes' GROUP BY user_id HAVING sum(amount) > 0`,
  )
    .bind(roundId)
    .all<{ user_id: string; amount: number }>();
  return send(
    env,
    results.map(({ user_id, amount }): NotifyMessage => ({
      event: 'payout_claimable',
      userId: user_id,
      dedupeKey: `payout_claimable:${roundId}:stakes:${user_id}`,
      payload: { roundId, mode: 'stakes', amount: String(amount), claimsOpenAt },
    })),
  );
}

/**
 * The post-final hook (src/settlement/hooks.ts): Free outcomes at apply and refund; for Stakes, which
 * is final at `RoundFinalized` / `RoundRefunded` after its outcome went out at the proposal, the
 * claim notice or the refund notice (and the outcome itself for a refund with no proposal).
 */
export async function notifyOnModeFinal(env: Env, event: ModeFinalEvent): Promise<void> {
  if (event.kind !== 'daily') return;
  if (event.mode === 'free') {
    // A void enqueues its own notices (applyVoid), and runs no post-final hooks.
    if (event.outcome !== 'voided') await enqueueModeOutcome(env, event.roundId, 'free');
    return;
  }
  if (event.outcome === 'settled') {
    await enqueuePayoutClaimable(env, event.roundId);
    return;
  }
  if (event.outcome !== 'refunded') return;
  const m = await modeRow(env.DB, event.roundId, 'stakes');
  const reason = (m?.refund_reason ?? 1) as RefundReason;
  // A refund the contract proposed first was already told at the proposal (the day's `outcome` when
  // it was the user's first mode outcome), so its finalization is `refunded` (spec "Notifications",
  // Oct 16, 2026; W9-F1 R2). A refund with no proposal is final when it happens, so it may still be
  // the user's first outcome: `refundTimeout` (6) never has a proposal, reasons 2, 3 and 5 always
  // have one, and only `refundTooFew` (1) is ambiguous, because VOID entries can leave too few valid
  // ones for a rule-1 proposal. `claims_open_at` tells them apart: only a proposal sets it.
  const proposed = reason !== 6 && (reason !== 1 || m?.claims_open_at != null);
  if (proposed) await enqueueRefunded(env, event.roundId, 'stakes', reason);
  else await enqueueModeOutcome(env, event.roundId, 'stakes');
}
