// The Stakes apply hook (wave-5 pinned interface; spec "Round lifecycle" Stakes rows, "Smart
// contract" › propose). SettlementDO calls it once the bundle is in R2 and no hold is open, and
// again on every retry, and after a proposal that landed has left the chain (a vetoed refund
// proposal, or one a reorg removed), to settle again:
//   1. the round is read onchain first: this bundle's proposal already there, or a final round,
//      means there is nothing to post; another bundle's proposal is an integrity failure;
//   2. the settlement record of this proposal: `proposal_seq` 0, then one more after each proposal
//      the indexer saw leave the chain (it supersedes the record), superseding the record before
//      it; each entry's option, validity and VOID reason; `round_modes.bundle_hash`;
//   3. `propose(n0, n1, nVoid, payoutRoot, bundleHash)` through the operator, at most once per
//      `propose:<roundId>:<seq>` (src/chain/operator.ts), so a retry polls the same transaction and
//      never posts twice. The payout tree's leaves are settle's payouts (win, rebate when r > 0,
//      void_refund; reduce.ts); a refund proposal posts a zero root.
// Payouts are written only when the outcome is final, by the indexer (src/indexer/handlers/
// stakes.ts: RoundFinalized, RoundRefunded).
import type { Hex } from 'viem';
import { propose, type OperatorDeps } from '../../chain/operator.js';
import type { ModeTally } from '../../do/types.js';
import type { Env } from '../../env.js';
import { now } from '../../lib/clock.js';
import { log } from '../../lib/log.js';
import { manifestKey } from '../keys.js';
import { IntegrityError } from '../prepare.js';
import {
  escrowOf,
  providerClient,
  readEscrowRound,
  type EscrowDeps,
  type EscrowRound,
} from '../stakes/escrow.js';
import type { TallyResult } from '../types.js';
import { APPLY_SIZES } from './free.js';

const ZERO_ROOT: Hex = `0x${'00'.repeat(32)}`;

export interface StakesApplyDeps {
  operator?: OperatorDeps;
  escrow?: EscrowDeps;
}

/** The proposal is sent and not mined yet; SettlementDO calls again (the same transaction). */
export class ProposalPendingError extends Error {}

/** Per option `{headcount, total}` (the API's `TallySchema`; also `settlements.tally_json`). */
export function stakesTally(result: TallyResult): ModeTally {
  const { n, w } = result.record;
  return [
    { headcount: Number(n[0]), total: w[0].toString() },
    { headcount: Number(n[1]), total: w[1].toString() },
  ];
}

/** The onchain round is past this bundle: proposed with it already, or final. */
function alreadyThere(onchain: EscrowRound, bundleHash: Hex): boolean {
  if (onchain.status === 'Settled' || onchain.status === 'Refunded') return true;
  if (onchain.status !== 'SettleProposed' && onchain.status !== 'RefundProposed') return false;
  if (onchain.bundleHash !== bundleHash) {
    throw new IntegrityError(`another bundle (${onchain.bundleHash}) is proposed onchain`);
  }
  return true;
}

/**
 * The proposal number to post: the latest record's, or the next one once the indexer has marked it
 * superseded (a vetoed refund proposal, or one a reorg removed). Not on the chain's word alone: a
 * provider behind our mined proposal would answer Open, and the next proposal would be a second post.
 */
async function proposalSeq(db: D1Database, roundId: string): Promise<number> {
  const latest = await db
    .prepare(
      `SELECT proposal_seq AS seq, superseded_at AS superseded FROM settlements
       WHERE round_id = ?1 AND mode = 'stakes' ORDER BY proposal_seq DESC LIMIT 1`,
    )
    .bind(roundId)
    .first<{ seq: number; superseded: number | null }>();
  if (!latest) return 0;
  return latest.superseded !== null ? latest.seq + 1 : latest.seq;
}

const UPDATE_ENTRIES = `
  UPDATE entries SET option_index = x.o, valid = x.v, void_reason = x.r
  FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.o') AS o,
               json_extract(value, '$.v') AS v, json_extract(value, '$.r') AS r
        FROM json_each(?1)) AS x
  WHERE entries.id = x.id AND entries.round_id = ?2 AND entries.mode = 'stakes'`;

async function writeEntries(db: D1Database, result: TallyResult): Promise<void> {
  const roundId = result.manifest.roundId;
  const rows = result.entries.map((e) => ({
    id: e.entryId,
    o: e.option,
    v: e.option === null ? 0 : 1,
    r: e.voidReason,
  }));
  const { chunk, batch } = APPLY_SIZES;
  for (let i = 0; i < rows.length; i += chunk * batch) {
    const stmts: D1PreparedStatement[] = [];
    for (let j = i; j < Math.min(i + chunk * batch, rows.length); j += chunk) {
      stmts.push(
        db.prepare(UPDATE_ENTRIES).bind(JSON.stringify(rows.slice(j, j + chunk)), roundId),
      );
    }
    await db.batch(stmts);
  }
}

/** The settlement record of proposal `seq`, superseding the ones before it (once). */
async function writeRecord(db: D1Database, result: TallyResult, seq: number, t: number) {
  const { record, manifest, bundleHash, payouts } = result;
  const roundId = manifest.roundId;
  const amountOf = (kind: string) => payouts.find((p) => p.kind === kind)?.amount ?? 0n;
  // What the columns don't hold: the outcome's details, the VOIDs and the per-kind amounts the
  // contract derives (win s + w, rebate r, void_refund s).
  const winners = {
    winner: record.winner,
    refundReason: record.refundReason,
    voidCount: record.voidCount.toString(),
    voidStake: record.voidStake.toString(),
    total: record.total.toString(),
    winPayout: amountOf('win').toString(),
    rebatePayout: amountOf('rebate').toString(),
    chainRoundId: manifest.chainRoundId,
  };
  await db.batch([
    db
      .prepare(
        `UPDATE settlements SET superseded_at = ?3
         WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL AND proposal_seq < ?2`,
      )
      .bind(roundId, seq, t),
    db
      .prepare(
        `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json,
           winners_json, loss_pool, fee, creator_fee, distributable, rebate_pool, dust, payout_root,
           manifest_r2_key, bundle_hash, settled_at, tx_hash, superseded_at)
         VALUES (?1, 'stakes', ?2, ?3, ?4, ?5, ?6, CAST(?7 AS INTEGER), CAST(?8 AS INTEGER),
           CAST(?9 AS INTEGER), CAST(?10 AS INTEGER), CAST(?11 AS INTEGER), CAST(?12 AS INTEGER), ?13,
           ?14, ?15, NULL, NULL, NULL)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        roundId,
        seq,
        record.outcome,
        manifest.formulaVersion,
        JSON.stringify(stakesTally(result)),
        JSON.stringify(winners),
        record.lossPool.toString(),
        record.fee.toString(),
        record.creatorFee.toString(),
        record.distributable.toString(),
        record.rebatePool.toString(),
        record.dust.toString(),
        manifest.payoutRoot,
        manifestKey(roundId, 'stakes'),
        bundleHash,
      ),
    db
      .prepare("UPDATE round_modes SET bundle_hash = ?2 WHERE round_id = ?1 AND mode = 'stakes'")
      .bind(roundId, bundleHash),
  ]);
  const row = await db
    .prepare(
      "SELECT bundle_hash, superseded_at FROM settlements WHERE round_id = ?1 AND mode = 'stakes' AND proposal_seq = ?2",
    )
    .bind(roundId, seq)
    .first<{ bundle_hash: string | null; superseded_at: number | null }>();
  if (row?.bundle_hash !== bundleHash) {
    throw new IntegrityError(`stakes proposal ${seq} of ${roundId} is for another bundle`);
  }
}

/** Posts a Stakes mode's proposal (see the header). Idempotent. */
export async function applyStakes(
  env: Env,
  result: TallyResult,
  deps: StakesApplyDeps = {},
): Promise<void> {
  const db = env.DB;
  const { manifest, record, bundleHash } = result;
  const roundId = manifest.roundId;
  const chainRoundId = manifest.chainRoundId;
  if (manifest.mode !== 'stakes' || chainRoundId === null) {
    throw new IntegrityError('applyStakes got a result without a Stakes round');
  }
  const client = providerClient(env, 'primary', deps.escrow);
  if (!client) throw new Error('no RPC provider');
  const escrow = escrowOf(env);
  const read = () => readEscrowRound(client, escrow, chainRoundId);
  if (alreadyThere(await read(), bundleHash)) {
    log.info('stakes_proposal_known', { roundId, bundleHash });
    return;
  }

  const seq = await proposalSeq(db, roundId);
  await writeRecord(db, result, seq, now(env));
  await writeEntries(db, result);
  const r = await propose(env, deps.operator ?? {}, {
    roundId,
    chainRoundId,
    attempt: seq,
    n0: Number(record.n[0]),
    n1: Number(record.n[1]),
    nVoid: Number(record.voidCount),
    payoutRoot: manifest.payoutRoot ?? ZERO_ROOT,
    bundleHash,
  });
  switch (r.status) {
    case 'mined':
      await db
        .prepare(
          "UPDATE settlements SET tx_hash = ?3 WHERE round_id = ?1 AND mode = 'stakes' AND proposal_seq = ?2 AND tx_hash IS NULL",
        )
        .bind(roundId, seq, r.txHash)
        .run();
      log.info('stakes_proposed', { roundId, seq, outcome: record.outcome, txHash: r.txHash });
      return;
    case 'pending':
      throw new ProposalPendingError(`propose ${seq} is pending (${r.txHash})`);
    case 'cancelled':
      throw new IntegrityError(`propose ${seq} was cancelled`);
    case 'refused':
    case 'reverted':
      // The proposal may have landed another way (a re-mined earlier one): the chain decides.
      if (alreadyThere(await read(), bundleHash)) return;
      if (r.status === 'reverted')
        throw new IntegrityError(`propose ${seq} reverted (${r.txHash})`);
      throw new Error(`propose ${seq} refused: ${r.error}`);
  }
}
