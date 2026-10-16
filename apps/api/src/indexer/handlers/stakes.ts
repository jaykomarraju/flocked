// Stakes outcome handlers for the chain indexer (spec "Round lifecycle" Stakes rows; wave-4 pinned
// interface: called once per event revision in chain order). The settlement coordinator posts the
// proposal and follows it onchain (src/do/settlement-do.ts); D1 moves only on what the chain says:
//   - `OutcomeProposed` → revealing → settle_proposed or refund_proposed, with claims_open_at,
//     revealed_at, the chain's bundle hash (round_modes.bundle_hash: only this handler writes it for
//     Stakes, W7-F1 R15) and the proposal's transaction, once its bundle hash and payout root are
//     the record's (R16); then, after that D1 commit (R6, decision A3), the RoundDO broadcasts
//     `revealed`, or `refunded` marked provisional;
//   - `ProposalVetoed`: on a settlement, the record is superseded (`RoundRefunded` reason 5 in the
//     same transaction refunds the mode); on a refund proposal, the round is Open again onchain, so
//     the record is superseded, the mode goes back to revealing, it alerts and opens a settlement
//     hold (reason `refund_vetoed`; owner decision O1, Oct 12): the coordinator proposes again only
//     once the guardian has released it, because the re-proposal is deterministic and would repeat
//     the same refund (`refundTimeout` stays the backstop); either way an audit_log row;
//   - `RoundFinalized` (Settled) → settled with final_at, and the `payouts` (win s + w, rebate r when
//     r > 0, void_refund s);
//   - `RoundRefunded` reasons 1 (refundTooFew), 2 and 3 (a refund proposal finalized), 5 (a vetoed
//     settlement) and 6 (refundTimeout) → refunded with final_at, and a `refund` payout per entry.
//     Reason 4 (void) is src/lifecycle/handlers.ts's.
// A foreign entry (no ticket, so no user) gets no `payouts` row: its payout lives only in the payout
// tree and the bundle, and its wallet claims onchain like any other (W2-Z carry-over; payouts.user_id
// stays NOT NULL). A removed event that isn't live again alerts and puts D1 back where it was before
// the event (W6-F1 R3), so a re-mined or replacing event finds what it needs: a proposal → revealing
// (the coordinator posts again); a veto → the vetoed record current again, and a vetoed refund
// proposal refund_proposed again (its hold stays for the guardian: only an admin action releases a
// hold); a refund → the state it refunded from, without its `refund` payouts; a settlement → settle_
// proposed, without its payouts. A proposal re-mined after its removal was handled puts its record
// back (R2). A vetoed record is put back by its number in the veto's audit row (W7-F1 R13), not by
// its superseded_at: a veto re-mined in another block within one poll keeps the first block's time
// there. Side effects outside D1 (the RoundDO) run at least once; RoundDO.onModeResult ignores a
// repeat, and a removal can't take one back (the alert covers it). Handlers never throw for a
// permanent condition.
import { newUlid } from '@flocked/shared';
import type { Hex } from 'viem';
import type { ModeResult, ModeTally } from '../../do/types.js';
import type { Env } from '../../env.js';
import { raiseAlert } from '../../lib/alert.js';
import { log } from '../../lib/log.js';
import type { HandlerRegistry } from '../registry.js';
import type { ChainEvent, EventHandler } from '../types.js';

/** FlockedEscrow `Status` values in events. */
const SETTLE_PROPOSED = 2;
const SETTLED = 4;
/** `RoundRefunded` reasons. */
const REASON_VOIDED = 4;
const REASON_VETOED = 5;
/** The payout root a refund proposal posts (its record has none). */
const ZERO_ROOT = `0x${'00'.repeat(32)}`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface StakesMode {
  roundId: string;
  status: string;
  claimsOpenAt: number | null;
}

async function stakesModeOf(db: D1Database, evt: ChainEvent): Promise<StakesMode | null> {
  const row = await db
    .prepare(
      `SELECT round_id, status, claims_open_at FROM round_modes
       WHERE mode = 'stakes' AND chain_round_id = ?1`,
    )
    .bind(String(evt.args.roundId))
    .first<{ round_id: string; status: string; claims_open_at: number | null }>();
  return row && { roundId: row.round_id, status: row.status, claimsOpenAt: row.claims_open_at };
}

/** The log is on the canonical chain again (re-mined elsewhere; removals are dispatched first). */
async function liveAgain(db: D1Database, evt: ChainEvent): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM chain_events WHERE chain_id = ?1 AND tx_hash = ?2 AND event = ?3
         AND removed = 0 LIMIT 1`,
    )
    .bind(evt.chainId, evt.txHash, evt.event)
    .first<{ ok: number }>();
  return row !== null;
}

interface Proposal {
  seq: number;
  outcome: string;
  bundleHash: string | null;
  /** Lowercase; null for a refund proposal (it posts ZERO_ROOT). */
  payoutRoot: string | null;
  tally: ModeTally;
  winners: {
    winner: 0 | 1 | null;
    refundReason: number | null;
    winPayout: string;
    rebatePayout: string;
  };
}

/** The current (not superseded) settlement record of the Stakes mode. */
function currentProposal(db: D1Database, roundId: string): Promise<Proposal | null> {
  return proposalWhere(db, roundId, 'superseded_at IS NULL', null);
}

/** R2: the latest superseded record of the bundle `bundleHash` (a proposal a reorg removed). */
function supersededProposal(
  db: D1Database,
  roundId: string,
  bundleHash: Hex,
): Promise<Proposal | null> {
  return proposalWhere(
    db,
    roundId,
    'superseded_at IS NOT NULL AND lower(bundle_hash) = ?2',
    bundleHash,
  );
}

async function proposalWhere(
  db: D1Database,
  roundId: string,
  where: string,
  bundleHash: Hex | null,
): Promise<Proposal | null> {
  const row = await db
    .prepare(
      `SELECT proposal_seq, outcome, bundle_hash, payout_root, tally_json, winners_json
       FROM settlements
       WHERE round_id = ?1 AND mode = 'stakes' AND ${where} ORDER BY proposal_seq DESC LIMIT 1`,
    )
    .bind(...(bundleHash === null ? [roundId] : [roundId, bundleHash]))
    .first<{
      proposal_seq: number;
      outcome: string;
      bundle_hash: string | null;
      payout_root: string | null;
      tally_json: string;
      winners_json: string | null;
    }>();
  if (!row) return null;
  return {
    seq: row.proposal_seq,
    outcome: row.outcome,
    bundleHash: row.bundle_hash?.toLowerCase() ?? null,
    payoutRoot: row.payout_root?.toLowerCase() ?? null,
    tally: JSON.parse(row.tally_json) as ModeTally,
    winners: JSON.parse(row.winners_json ?? '{}') as Proposal['winners'],
  };
}

/** RoundDO.onModeResult('stakes', …); a RoundDO that can't take it alerts (D1 is the record). */
async function notifyRound(env: Env, roundId: string, result: ModeResult, evt: ChainEvent) {
  try {
    await env.ROUND.get(env.ROUND.idFromName(roundId)).onModeResult('stakes', result);
  } catch (err) {
    const text = message(err);
    if (!(err instanceof RangeError) && !/^(not_found|onModeResult:)/.test(text)) throw err;
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'stakes_mode_result',
      error: text,
      txHash: evt.txHash,
    });
  }
}

/** A removed outcome event that is not live again: someone has to look (and a proposal is posted again). */
function reorged(env: Env, roundId: string, evt: ChainEvent, step: string): void {
  log.warn('stakes_event_reorged', { roundId, eventName: evt.event, txHash: evt.txHash });
  raiseAlert(env, 'ALERT_DO_ERROR', { roundId, step, txHash: evt.txHash });
}

const superseded = (db: D1Database, roundId: string, t: number) =>
  db
    .prepare(
      `UPDATE settlements SET superseded_at = ?2
       WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL`,
    )
    .bind(roundId, t);

/** No current record: the one superseded at `t` (by a veto, or a vetoed settlement's refund) is again. */
const unsupersededAt = (db: D1Database, roundId: string, t: number) =>
  db
    .prepare(
      `UPDATE settlements SET superseded_at = NULL
       WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at = ?2
         AND proposal_seq = (SELECT MAX(proposal_seq) FROM settlements
                             WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at = ?2)
         AND NOT EXISTS (SELECT 1 FROM settlements
                         WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL)`,
    )
    .bind(roundId, t);

/**
 * O1: the hold a vetoed refund proposal opens. A second veto of the same round reopens the row the
 * guardian released (PK (round_id, mode, reason)); an open one is left as it is. tx_hash stays NULL
 * (spec "Data model": only a foreign-entry hold carries one); the veto's transaction is in the
 * audit_log row and the alert.
 */
const refundVetoedHold = (db: D1Database, roundId: string, t: number) =>
  db
    .prepare(
      `INSERT INTO settlement_holds (round_id, mode, reason, tx_hash, created_at)
       VALUES (?1, 'stakes', 'refund_vetoed', NULL, ?2)
       ON CONFLICT (round_id, mode, reason) DO UPDATE
         SET created_at = excluded.created_at, released_at = NULL, released_by = NULL
         WHERE settlement_holds.released_at IS NOT NULL`,
    )
    .bind(roundId, t);

/**
 * What the newest audit row of the veto in `txHash` kept: the number of the record it superseded
 * (R13) and, for a refund proposal, its `claimsOpenAt` in ms (R3). Nulls without a row.
 */
async function vetoAudit(
  db: D1Database,
  roundId: string,
  txHash: string,
): Promise<{ seq: number | null; claimsOpenAt: number | null }> {
  const row = await db
    .prepare(
      `SELECT json_extract(data_json, '$.seq') AS seq, json_extract(data_json, '$.claimsOpenAt') AS at
       FROM audit_log
       WHERE target = ?1 AND action = 'proposal_vetoed' AND json_extract(data_json, '$.txHash') = ?2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(roundId, txHash)
    .first<{ seq: number | null; at: number | null }>();
  return { seq: row?.seq ?? null, claimsOpenAt: row?.at ?? null };
}

/**
 * R13: no current record: the one a removed veto superseded is again, found by its number in the
 * veto's audit row. Not by superseded_at: a veto re-mined in another block within one poll (its
 * removal skipped as live again) keeps the first block's time there, so a later removal's time
 * matches nothing. Without a number (no audit row), the record superseded at `t`.
 */
const unsupersedeVetoed = (db: D1Database, roundId: string, seq: number | null, t: number) =>
  seq === null
    ? unsupersededAt(db, roundId, t)
    : db
        .prepare(
          `UPDATE settlements SET superseded_at = NULL
           WHERE round_id = ?1 AND mode = 'stakes' AND proposal_seq = ?2
             AND superseded_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM settlements
                             WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL)`,
        )
        .bind(roundId, seq);

const auditRow = (db: D1Database, evt: ChainEvent, action: string, roundId: string, data: object) =>
  db
    .prepare(
      `INSERT INTO audit_log (id, actor, actor_user_id, action, target, data_json, created_at)
       VALUES (?1, 'system', NULL, ?2, ?3, ?4, ?5)`,
    )
    .bind(
      newUlid(evt.blockTimestampSec * 1000),
      action,
      roundId,
      JSON.stringify({ ...data, txHash: evt.txHash, blockNumber: evt.blockNumber }),
      evt.blockTimestampSec * 1000,
    );

/** `OutcomeProposed` → settle_proposed or refund_proposed. */
export const outcomeProposedHandler: EventHandler = async (evt, env) => {
  if (evt.contractKind !== 'escrow') return;
  const db = env.DB;
  const mode = await stakesModeOf(db, evt);
  if (!mode) return;
  const { roundId } = mode;
  const bundleHash = String(evt.args.bundleHash).toLowerCase() as Hex;
  const t = evt.blockTimestampSec * 1000;
  if (evt.removed) {
    if (await liveAgain(db, evt)) return;
    reorged(env, roundId, evt, 'stakes_proposal_reorged');
    // Open again onchain: the coordinator posts the next proposal once this one is superseded.
    return [
      db
        .prepare(
          `UPDATE round_modes SET status = 'revealing', claims_open_at = NULL, refund_reason = NULL
           WHERE round_id = ?1 AND mode = 'stakes' AND status IN ('settle_proposed', 'refund_proposed')`,
        )
        .bind(roundId),
      db
        .prepare(
          `UPDATE settlements SET superseded_at = ?3
           WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL AND bundle_hash = ?2`,
        )
        .bind(roundId, bundleHash, t),
    ];
  }
  let p = await currentProposal(db, roundId);
  const restore: D1PreparedStatement[] = [];
  if (!p) {
    // R2: re-mined after its removal was handled (in an earlier poll), which superseded its record:
    // that record is the proposal onchain again, so RoundFinalized will find it.
    p = await supersededProposal(db, roundId, bundleHash);
    if (p) {
      log.warn('stakes_proposal_restored', { roundId, seq: p.seq, txHash: evt.txHash });
      restore.push(
        db
          .prepare(
            `UPDATE settlements SET superseded_at = NULL
             WHERE round_id = ?1 AND mode = 'stakes' AND proposal_seq = ?2
               AND NOT EXISTS (SELECT 1 FROM settlements
                               WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL)`,
          )
          .bind(roundId, p.seq),
      );
    }
  }
  if (!p || p.bundleHash !== bundleHash) {
    // Not the proposal the coordinator recorded (ALERT-8 covers a transaction we didn't send).
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'stakes_proposal_unknown',
      bundleHash,
      recorded: p?.bundleHash ?? null,
      txHash: evt.txHash,
    });
    return;
  }
  // R16: the root posted is the record's (a refund proposal posts the zero root). The bundle hash
  // binds it through the manifest, but a proposal the record doesn't describe is not confirmed:
  // reads serve proofs against the record's root.
  const payoutRoot = String(evt.args.payoutRoot).toLowerCase();
  if (payoutRoot !== (p.payoutRoot ?? ZERO_ROOT)) {
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'stakes_proposal_root_mismatch',
      payoutRoot,
      recorded: p.payoutRoot,
      bundleHash,
      txHash: evt.txHash,
    });
    return;
  }
  const settle = Number(evt.args.status) === SETTLE_PROPOSED;
  const claimsOpenAt = Number(evt.args.claimsOpenAt) * 1000;
  const refundReason = settle ? null : (p.winners.refundReason ?? 1);
  if (settle && p.winners.winner === null) {
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'stakes_proposal_no_winner',
      txHash: evt.txHash,
    });
    return;
  }
  // R6 (decision A3): D1 first, then the RoundDO. These statements commit here rather than in the
  // dispatcher's batch after this handler returns, so viewers get `revealed` only once revealed_at
  // and the status are in D1, and a batch that fails throws before the RoundDO hears anything. Each
  // is conditional, so a replay (the dispatcher's handled mark failed after this commit) changes
  // nothing and calls the RoundDO again, which ignores the repeat.
  await db.batch([
    ...restore,
    db
      .prepare(
        `UPDATE round_modes SET status = ?2, claims_open_at = ?3, refund_reason = ?4,
           bundle_hash = ?5, revealed_at = COALESCE(revealed_at, ?6)
         WHERE round_id = ?1 AND mode = 'stakes' AND status IN ('pending', 'revealing')`,
      )
      .bind(
        roundId,
        settle ? 'settle_proposed' : 'refund_proposed',
        claimsOpenAt,
        refundReason,
        bundleHash,
        t,
      ),
    db
      .prepare(
        `UPDATE settlements SET tx_hash = ?2
         WHERE round_id = ?1 AND mode = 'stakes' AND proposal_seq = ?3 AND tx_hash IS NOT ?2`,
      )
      .bind(roundId, evt.txHash, p.seq),
  ]);
  log.info('stakes_proposal_confirmed', { roundId, settle, seq: p.seq, txHash: evt.txHash });
  await notifyRound(
    env,
    roundId,
    settle
      ? {
          outcome: 'revealed',
          winningOption: p.winners.winner as 0 | 1,
          tally: p.tally,
          bundleHash,
          revealedAt: t,
          claimsOpenAt,
        }
      : {
          outcome: 'refunded',
          reason: refundReason as Extract<ModeResult, { outcome: 'refunded' }>['reason'],
          provisional: true,
          claimsOpenAt,
          bundleHash,
        },
    evt,
  );
};

/** `ProposalVetoed`: a vetoed settlement is refunded by its `RoundRefunded`; a vetoed refund proposal settles again. */
export const proposalVetoedHandler: EventHandler = async (evt, env) => {
  if (evt.contractKind !== 'escrow') return;
  const db = env.DB;
  const mode = await stakesModeOf(db, evt);
  if (!mode) return;
  const { roundId, status } = mode;
  const t = evt.blockTimestampSec * 1000;
  if (evt.removed) {
    if (await liveAgain(db, evt)) return;
    reorged(env, roundId, evt, 'stakes_veto_reorged');
    // R3: the vetoed record is the proposal onchain again (R13: by its number in the veto's audit
    // row). A vetoed refund proposal is refund_proposed again (claimsOpenAt from the same row); a
    // vetoed settlement's state is its RoundRefunded (reason 5) removal's to put back.
    const audit = await vetoAudit(db, roundId, evt.txHash);
    return [
      unsupersedeVetoed(db, roundId, audit.seq, t),
      db
        .prepare(
          `UPDATE round_modes SET status = 'refund_proposed', claims_open_at = ?2,
             refund_reason = COALESCE((SELECT json_extract(s.winners_json, '$.refundReason')
               FROM settlements s WHERE s.round_id = ?1 AND s.mode = 'stakes'
                 AND s.superseded_at IS NULL), 1)
           WHERE round_id = ?1 AND mode = 'stakes' AND status = 'revealing'
             AND EXISTS (SELECT 1 FROM settlements s WHERE s.round_id = ?1 AND s.mode = 'stakes'
                           AND s.superseded_at IS NULL AND s.outcome = 'refunded')`,
        )
        .bind(roundId, audit.claimsOpenAt),
    ];
  }
  const evidenceHash = String(evt.args.evidenceHash);
  if (status === 'refund_proposed') {
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'refund_proposal_vetoed',
      evidenceHash,
      txHash: evt.txHash,
      hold: 'refund_vetoed',
    });
    log.warn('stakes_refund_proposal_vetoed', { roundId, txHash: evt.txHash });
    const vetoed = await currentProposal(db, roundId);
    return [
      superseded(db, roundId, t),
      db
        .prepare(
          `UPDATE round_modes SET status = 'revealing', claims_open_at = NULL, refund_reason = NULL
           WHERE round_id = ?1 AND mode = 'stakes' AND status = 'refund_proposed'`,
        )
        .bind(roundId),
      refundVetoedHold(db, roundId, t),
      auditRow(db, evt, 'proposal_vetoed', roundId, {
        proposal: 'refund',
        evidenceHash,
        seq: vetoed?.seq ?? null,
        claimsOpenAt: mode.claimsOpenAt,
      }),
    ];
  }
  if (status === 'settle_proposed') {
    log.warn('stakes_settlement_vetoed', { roundId, txHash: evt.txHash });
    const vetoed = await currentProposal(db, roundId);
    return [
      superseded(db, roundId, t),
      auditRow(db, evt, 'proposal_vetoed', roundId, {
        proposal: 'settlement',
        evidenceHash,
        seq: vetoed?.seq ?? null,
      }),
    ];
  }
  raiseAlert(env, 'ALERT_DO_ERROR', {
    roundId,
    step: 'stakes_veto_unexpected',
    status,
    txHash: evt.txHash,
  });
};

/** Every ticketed entry's payout of a settled round, from its outcome and the recorded amounts. */
const INSERT_PAYOUTS = `
  INSERT INTO payouts (round_id, mode, user_id, wallet, kind, amount, claimed_at, claim_tx)
  SELECT e.round_id, 'stakes', e.user_id, lower(e.wallet),
         CASE WHEN e.valid = 0 THEN 'void_refund' WHEN e.option_index = ?2 THEN 'win' ELSE 'rebate' END,
         CASE WHEN e.valid = 0 THEN e.stake WHEN e.option_index = ?2 THEN CAST(?3 AS INTEGER)
              ELSE CAST(?4 AS INTEGER) END,
         NULL, NULL
  FROM entries e
  WHERE e.round_id = ?1 AND e.mode = 'stakes' AND e.user_id IS NOT NULL AND e.valid IS NOT NULL
    AND (e.valid = 0 OR e.option_index = ?2 OR CAST(?4 AS INTEGER) > 0)
  ON CONFLICT DO NOTHING`;

/** A refund of every ticketed entry's stake. */
const INSERT_REFUNDS = `
  INSERT INTO payouts (round_id, mode, user_id, wallet, kind, amount, claimed_at, claim_tx)
  SELECT e.round_id, 'stakes', e.user_id, lower(e.wallet), 'refund', e.stake, NULL, NULL
  FROM entries e WHERE e.round_id = ?1 AND e.mode = 'stakes' AND e.user_id IS NOT NULL
  ON CONFLICT DO NOTHING`;

/** `RoundFinalized` (Settled) → settled, and the payouts. A finalized refund is RoundRefunded's. */
export const roundFinalizedHandler: EventHandler = async (evt, env) => {
  if (evt.contractKind !== 'escrow') return;
  const db = env.DB;
  const mode = await stakesModeOf(db, evt);
  if (!mode) return;
  const { roundId } = mode;
  const t = evt.blockTimestampSec * 1000;
  if (evt.removed) {
    if (await liveAgain(db, evt)) return;
    reorged(env, roundId, evt, 'stakes_finalize_reorged');
    // A finalized refund proposal is put back by its RoundRefunded's removal.
    if (Number(evt.args.status) !== SETTLED) return;
    // R3: settle_proposed again, without the payouts (a re-mined finalize writes them again). A
    // claimed one stays: the claim's removal, dispatched first (newest first), clears its mark.
    return [
      db
        .prepare(
          `UPDATE round_modes SET status = 'settle_proposed', final_at = NULL
           WHERE round_id = ?1 AND mode = 'stakes' AND status = 'settled'`,
        )
        .bind(roundId),
      db
        .prepare(
          `UPDATE settlements SET settled_at = NULL
           WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL AND settled_at = ?2`,
        )
        .bind(roundId, t),
      db
        .prepare(
          `DELETE FROM payouts WHERE round_id = ?1 AND mode = 'stakes'
             AND kind IN ('win', 'rebate', 'void_refund') AND claimed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM round_modes m
                             WHERE m.round_id = ?1 AND m.mode = 'stakes' AND m.status = 'settled')`,
        )
        .bind(roundId),
    ];
  }
  if (Number(evt.args.status) !== SETTLED) return;
  const p = await currentProposal(db, roundId);
  if (!p || p.outcome !== 'settled' || p.winners.winner === null) {
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'stakes_finalized_unknown',
      txHash: evt.txHash,
    });
    return;
  }
  // The RoundDO has the outcome from the proposal already.
  log.info('stakes_settled', { roundId, txHash: evt.txHash });
  return [
    db
      .prepare(
        `UPDATE round_modes SET status = 'settled', final_at = ?2
         WHERE round_id = ?1 AND mode = 'stakes' AND status IN ('revealing', 'settle_proposed')`,
      )
      .bind(roundId, t),
    db
      .prepare(
        `UPDATE settlements SET settled_at = ?2
         WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL AND settled_at IS NULL`,
      )
      .bind(roundId, t),
    db
      .prepare(INSERT_PAYOUTS)
      .bind(roundId, p.winners.winner, p.winners.winPayout, p.winners.rebatePayout),
  ];
};

/** `RoundRefunded` (any reason but 4) → refunded, and a refund payout per entry. */
export const roundRefundedHandler: EventHandler = async (evt, env) => {
  const reason = Number(evt.args.reason);
  if (evt.contractKind !== 'escrow' || reason === REASON_VOIDED) return;
  const db = env.DB;
  const mode = await stakesModeOf(db, evt);
  if (!mode) return;
  const { roundId } = mode;
  const t = evt.blockTimestampSec * 1000;
  if (evt.removed) {
    if (await liveAgain(db, evt)) return;
    reorged(env, roundId, evt, 'stakes_refund_reorged');
    return refundRemoved(db, roundId, reason, t);
  }
  if (
    !['pending', 'revealing', 'settle_proposed', 'refund_proposed', 'refunded'].includes(
      mode.status,
    )
  ) {
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'stakes_refund_unexpected',
      status: mode.status,
      reason,
      txHash: evt.txHash,
    });
    return;
  }
  const refunded: ModeResult = {
    outcome: 'refunded',
    reason: reason as Extract<ModeResult, { outcome: 'refunded' }>['reason'],
    provisional: false,
  };
  await notifyRound(env, roundId, refunded, evt);
  log.warn('stakes_refunded', { roundId, reason, txHash: evt.txHash });
  return [
    db
      .prepare(
        `UPDATE round_modes SET status = 'refunded', refund_reason = ?2, final_at = ?3
         WHERE round_id = ?1 AND mode = 'stakes'
           AND status IN ('pending', 'revealing', 'settle_proposed', 'refund_proposed')`,
      )
      .bind(roundId, reason, t),
    ...(reason === REASON_VETOED ? [superseded(db, roundId, t)] : []),
    db.prepare(INSERT_REFUNDS).bind(roundId),
  ];
};

/**
 * R3: a `RoundRefunded` (not reason 4) left the chain: the mode goes back to the state it was refunded
 * from, without its `refund` payouts (unclaimed; a claim's removal comes first), so the refund
 * re-mined, or what replaces it (a finalize, a proposal), applies as it would have:
 *   - reason 5 (a vetoed settlement): settle_proposed, its record current again (the veto's own
 *     removal, dispatched next, puts it back by its number when this time no longer matches: R13);
 *   - a finalized refund proposal (its record current, claims_open_at set): refund_proposed;
 *   - refundTooFew or refundTimeout (the round was Open): revealing once anything was revealed or
 *     proposed, pending otherwise.
 */
function refundRemoved(
  db: D1Database,
  roundId: string,
  reason: number,
  t: number,
): D1PreparedStatement[] {
  const refundProposal = `claims_open_at IS NOT NULL AND EXISTS (SELECT 1 FROM settlements s
      WHERE s.round_id = ?1 AND s.mode = 'stakes' AND s.superseded_at IS NULL AND s.outcome = 'refunded')`;
  return [
    ...(reason === REASON_VETOED ? [unsupersededAt(db, roundId, t)] : []),
    db
      .prepare(
        `UPDATE round_modes SET
           status = CASE
             WHEN ?2 = ${REASON_VETOED} THEN 'settle_proposed'
             WHEN ${refundProposal} THEN 'refund_proposed'
             WHEN revealed_at IS NOT NULL OR EXISTS (SELECT 1 FROM settlements s
               WHERE s.round_id = ?1 AND s.mode = 'stakes') THEN 'revealing'
             ELSE 'pending' END,
           refund_reason = CASE WHEN ?2 <> ${REASON_VETOED} AND ${refundProposal}
             THEN refund_reason ELSE NULL END,
           final_at = NULL
         WHERE round_id = ?1 AND mode = 'stakes' AND status = 'refunded' AND refund_reason = ?2`,
      )
      .bind(roundId, reason),
    db
      .prepare(
        `DELETE FROM payouts WHERE round_id = ?1 AND mode = 'stakes' AND kind = 'refund'
           AND claimed_at IS NULL
           AND EXISTS (SELECT 1 FROM round_modes m WHERE m.round_id = ?1 AND m.mode = 'stakes'
                         AND m.status NOT IN ('refunded', 'voided'))`,
      )
      .bind(roundId),
  ];
}

/**
 * Registers the Stakes outcome handlers on `registry`. Names are stable (chain_event_handled). The
 * lifecycle registry calls it (src/lifecycle/handlers.ts), so the default registry has them.
 */
export function registerStakesHandlers(registry: HandlerRegistry): HandlerRegistry {
  registry.register('OutcomeProposed', 'stakes-proposal', outcomeProposedHandler);
  registry.register('ProposalVetoed', 'stakes-veto', proposalVetoedHandler);
  registry.register('RoundFinalized', 'stakes-finalized', roundFinalizedHandler);
  registry.register('RoundRefunded', 'stakes-refunded', roundRefundedHandler);
  return registry;
}
