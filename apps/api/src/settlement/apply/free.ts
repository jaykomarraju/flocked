// The Free apply hook (wave-5 pinned interface; spec "Round lifecycle" Free rows, "Settlement and
// payout math" › Refund rules and Normal case, "Data model" › Archival and Atomic points movements).
//
// applyFree(env, result), once the bundle is in R2 (SettlementDO's applying phase):
//   1. the settlement record (proposal_seq 0) is inserted once; its `settled_at` is the time every
//      later row uses, so a retry writes the same values;
//   2. each entry's option_index, valid and void_reason;
//   3. `revealed_at` (W6-D: before any balance moves, since a credit says which side won; the
//      credits are computed and checked before it, W6-F1 R6), then the payouts and their ledger credits (win → payout, rebate, void_refund, refund) plus the creator
//      award, chunked (APPLY_SIZES rows per statement, statements per D1 batch). A chunk's payouts,
//      ledger rows and balance credits commit together. Ledger rows are inserted ON CONFLICT DO
//      NOTHING with fresh IDs, and a balance moves only by the rows this attempt inserted, so the
//      ledger's unique key (user, scope, reason, ref) is what stops a retry from crediting twice.
//      Dust is burned: recorded in the record, credited to no one;
//   4. round_modes revealing → settled, or refunded (rules 1–3), with bundle_hash and revealed_at,
//      conditional on `revealing`, once every output above is durable;
//   5. RoundDO.onModeResult('free', …), which updates the DO and its broadcast only;
//   6. the manifest anchor through AnchorDO.submitManifest (write-once onchain; the AnchorDO retries
//      a manifest that reverts before beacon time);
//   7. ciphertext archival: each bundle chunk's entries lose their D1 ciphertext once the manifest
//      in R2 hashes to bundleHash and the chunk object exists.
// Every step is idempotent, so SettlementDO may call applyFree again after any failure.
//
// refundFree(env, roundId, 7 | 8): rule 7 (the commitment was not anchored before the beacon;
// SettlementDO) or rule 8 (the beacon is still unavailable 24 h after its round time; the settle
// consumer). The conditional pending → refunded update comes first and is the claim: only after it
// are the stakes refunded, so a mode that went on to reveal is never refunded. These modes have no
// bundle yet (W5-D handoff, spec issue), so their ciphertexts stay in D1.
//
// Rule 4 (void) refunds are written at void confirmation (src/lifecycle/void.ts); a voided mode never
// reaches either function: SettlementDO stops at a non-pending mode, applyFree refuses anything but
// `revealing` (or a retry of its own outcome), and refundFree refunds only what it moved itself.
import { newUlid, roundKey, type RoundKind } from '@flocked/shared';
import type { PayoutKind, RefundReason } from '@flocked/settle';
import { beaconTime, chainFromEnv } from '@flocked/tlock';
import { keccak256 } from 'viem';
import { ANCHOR_SINGLETON } from '../../chain/client.js';
import type { AnchorManifestItem, ModeResult, ModeTally } from '../../do/types.js';
import type { Env } from '../../env.js';
import { raiseAlert } from '../../lib/alert.js';
import { now } from '../../lib/clock.js';
import { log } from '../../lib/log.js';
import { GLOBAL_SCOPE, scopeForRound, type CreditReason } from '../../points/index.js';
import { manifestKey } from '../keys.js';
import { IntegrityError } from '../prepare.js';
import type { TallyResult } from '../types.js';

/**
 * Rows per json_each statement, and chunks per D1 batch (one transaction). 100,000 entries take
 * about 100 D1 calls. Tests shrink them to cross chunk boundaries with a few entries.
 */
export const APPLY_SIZES = { chunk: 500, batch: 4 };

/** The ledger reason for each payout kind ("Data model" points_ledger.reason). */
const LEDGER_REASON: Record<PayoutKind, CreditReason> = {
  win: 'payout',
  rebate: 'rebate',
  void_refund: 'void_refund',
  refund: 'refund',
};

/** The calls into other Durable Objects; tests replace them. */
export interface FreeApplyDeps {
  /** RoundDO.onModeResult('free', result). */
  notifyRound: (env: Env, roundId: string, result: ModeResult) => Promise<void>;
  /** Queues the manifest with the AnchorDO unless it already holds it. */
  anchorManifest: (env: Env, item: AnchorManifestItem) => Promise<void>;
}

export const FREE_APPLY_DEPS: FreeApplyDeps = {
  async notifyRound(env, roundId, result) {
    const stub = env.ROUND.get(env.ROUND.idFromName(roundId));
    try {
      await stub.onModeResult('free', result);
    } catch (err) {
      // A RoundDO that was never initialized, or has no Free mode, can't take the result now or
      // later (W4-F1 V3): alert and go on, since D1 is the record. Anything else is retried.
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof RangeError) && !message.startsWith('not_found')) throw err;
      log.error('mode_result_undeliverable', { roundId, error: message });
      raiseAlert(env, 'ALERT_DO_ERROR', { do: 'RoundDO', roundId, error: message });
    }
  },
  async anchorManifest(env, item) {
    const anchor = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
    const { manifest } = await anchor.status(item.roundKey);
    // Queued, sent or confirmed needs nothing. A failed one has paged already (ALERT_DO_ERROR in
    // the AnchorDO), and resubmitting a final state is a no-op.
    if (manifest.state !== 'none') {
      log.info('manifest_anchor_known', { roundId: item.roundId, state: manifest.state });
      return;
    }
    const ack = await anchor.submitManifest(item);
    log.info('manifest_anchor_submitted', {
      roundId: item.roundId,
      queued: ack.queued.length,
      alreadyAnchored: ack.alreadyAnchored.length,
    });
  },
};

interface ModeRow {
  kind: RoundKind;
  room_id: string | null;
  status: string;
  refund_reason: number | null;
  bundle_hash: string | null;
  final_at: number | null;
}

function loadMode(db: D1Database, roundId: string): Promise<ModeRow | null> {
  return db
    .prepare(
      `SELECT r.kind, r.room_id, m.status, m.refund_reason, m.bundle_hash, m.final_at
       FROM rounds r JOIN round_modes m ON m.round_id = r.id AND m.mode = 'free' WHERE r.id = ?1`,
    )
    .bind(roundId)
    .first<ModeRow>();
}

/** One credit: a ledger row, its balance move, and (except the award) its payouts row. */
interface Credit {
  /** Fresh ledger row ID for this attempt. */
  id: string;
  userId: string;
  reason: CreditReason;
  /** Decimal string (bigint), cast to INTEGER in SQL. */
  amount: string;
  /** The payouts row's kind; absent for the creator award (not a payout). */
  kind?: PayoutKind;
}

const INSERT_PAYOUTS = `
  INSERT INTO payouts (round_id, mode, user_id, wallet, kind, amount, claimed_at, claim_tx)
  SELECT ?2, 'free', json_extract(value, '$.userId'), NULL, json_extract(value, '$.kind'),
         CAST(json_extract(value, '$.amount') AS INTEGER), ?3, NULL
  FROM json_each(?1) WHERE json_extract(value, '$.kind') IS NOT NULL
  ON CONFLICT DO NOTHING`;

const INSERT_LEDGER = `
  INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at)
  SELECT json_extract(value, '$.id'), json_extract(value, '$.userId'), ?2,
         CAST(json_extract(value, '$.amount') AS INTEGER), json_extract(value, '$.reason'), ?3, ?4
  FROM json_each(?1) WHERE true
  ON CONFLICT DO NOTHING`;

// Only the ledger rows this attempt inserted (their fresh IDs) move a balance.
const CREDIT_BALANCES = `
  INSERT INTO point_balances (user_id, scope, balance, updated_at)
  SELECT l.user_id, l.scope, SUM(l.delta), ?2 FROM points_ledger l
  WHERE l.id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))
  GROUP BY l.user_id, l.scope
  ON CONFLICT (user_id, scope) DO UPDATE SET balance = balance + excluded.balance,
    updated_at = excluded.updated_at`;

/**
 * Writes credits for one (round, scope), all with ref_id = roundId and time `t`: payouts rows,
 * ledger rows and balance moves, chunked, each chunk atomic and idempotent. Returns the ledger rows
 * this call inserted.
 */
async function writeCredits(
  db: D1Database,
  roundId: string,
  scope: string,
  credits: Credit[],
  t: number,
): Promise<number> {
  let inserted = 0;
  const { chunk, batch } = APPLY_SIZES;
  const per = chunk * batch;
  for (let i = 0; i < credits.length; i += per) {
    const stmts: D1PreparedStatement[] = [];
    for (let j = i; j < Math.min(i + per, credits.length); j += chunk) {
      const json = JSON.stringify(credits.slice(j, j + chunk));
      stmts.push(
        db.prepare(INSERT_PAYOUTS).bind(json, roundId, t),
        db.prepare(INSERT_LEDGER).bind(json, scope, roundId, t),
        db.prepare(CREDIT_BALANCES).bind(json, t),
      );
    }
    const results = await db.batch(stmts);
    results.forEach((r, k) => {
      if (k % 3 === 1) inserted += r.meta.changes;
    });
  }
  return inserted;
}

const UPDATE_ENTRIES = `
  UPDATE entries SET option_index = x.o, valid = x.v, void_reason = x.r
  FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.o') AS o,
               json_extract(value, '$.v') AS v, json_extract(value, '$.r') AS r
        FROM json_each(?1)) AS x
  WHERE entries.id = x.id AND entries.round_id = ?2 AND entries.mode = 'free'`;

async function writeEntries(db: D1Database, result: TallyResult): Promise<void> {
  const roundId = result.manifest.roundId;
  const rows = result.entries.map((e) => ({
    id: e.entryId,
    o: e.option,
    v: e.option === null ? 0 : 1,
    r: e.voidReason,
  }));
  const { chunk, batch } = APPLY_SIZES;
  const per = chunk * batch;
  for (let i = 0; i < rows.length; i += per) {
    const stmts: D1PreparedStatement[] = [];
    for (let j = i; j < Math.min(i + per, rows.length); j += chunk) {
      const json = JSON.stringify(rows.slice(j, j + chunk));
      stmts.push(db.prepare(UPDATE_ENTRIES).bind(json, roundId));
    }
    await db.batch(stmts);
  }
}

/** Per option `{headcount, total}` (the API's `TallySchema`; also `settlements.tally_json`). */
function tallyOf(result: TallyResult): ModeTally {
  const { n, w } = result.record;
  return [
    { headcount: Number(n[0]), total: w[0].toString() },
    { headcount: Number(n[1]), total: w[1].toString() },
  ];
}

/**
 * Inserts the settlement record once and returns its time. A record for another bundle is an
 * integrity failure (the bundle is write-once, so it can't be a retry).
 */
async function writeRecord(
  db: D1Database,
  result: TallyResult,
  awardRecipient: string | null,
  t: number,
): Promise<number> {
  const { record, manifest, bundleHash } = result;
  const roundId = manifest.roundId;
  // What the columns don't hold: the outcome's details, the VOIDs and the creator award (Free:
  // house-minted, outside the invariant). Burned dust has its own column.
  const winners = {
    winner: record.winner,
    refundReason: record.refundReason,
    voidCount: record.voidCount.toString(),
    voidStake: record.voidStake.toString(),
    total: record.total.toString(),
    creatorAward: record.creatorAward.toString(),
    awardRecipient,
  };
  await db
    .prepare(
      `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json,
         winners_json, loss_pool, fee, creator_fee, distributable, rebate_pool, dust, payout_root,
         manifest_r2_key, bundle_hash, settled_at, tx_hash, superseded_at)
       VALUES (?1, 'free', 0, ?2, ?3, ?4, ?5, CAST(?6 AS INTEGER), CAST(?7 AS INTEGER),
         CAST(?8 AS INTEGER), CAST(?9 AS INTEGER), CAST(?10 AS INTEGER), CAST(?11 AS INTEGER), ?12,
         ?13, ?14, ?15, NULL, NULL)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      roundId,
      record.outcome,
      manifest.formulaVersion,
      JSON.stringify(tallyOf(result)),
      JSON.stringify(winners),
      record.lossPool.toString(),
      record.fee.toString(),
      record.creatorFee.toString(),
      record.distributable.toString(),
      record.rebatePool.toString(),
      record.dust.toString(),
      manifest.payoutRoot,
      manifestKey(roundId, 'free'),
      bundleHash,
      t,
    )
    .run();
  const row = await db
    .prepare(
      "SELECT bundle_hash, settled_at FROM settlements WHERE round_id = ?1 AND mode = 'free' AND superseded_at IS NULL",
    )
    .bind(roundId)
    .first<{ bundle_hash: string | null; settled_at: number | null }>();
  if (row?.bundle_hash !== bundleHash || row.settled_at === null) {
    throw new IntegrityError(
      `the settlement record of ${roundId} has bundle ${row?.bundle_hash ?? 'none'}, not ${bundleHash}`,
    );
  }
  return row.settled_at;
}

function creditsOf(result: TallyResult, awardRecipient: string | null, t: number): Credit[] {
  // userIdHash → userId (one entry per user).
  const users = new Map<string, string>();
  for (const e of result.entries) {
    if (e.userId === null) throw new IntegrityError(`free entry ${e.entryId} has no user`);
    users.set(e.account.toLowerCase(), e.userId);
  }
  const credits = result.payouts
    .filter((p) => p.amount > 0n)
    .map((p): Credit => {
      const userId = users.get(p.account.toLowerCase());
      if (!userId) throw new IntegrityError(`payout account ${p.account} has no entry`);
      return {
        id: newUlid(t),
        userId,
        reason: LEDGER_REASON[p.kind],
        amount: p.amount.toString(),
        kind: p.kind,
      };
    });
  const award = result.record.creatorAward;
  if (result.record.outcome === 'settled' && award > 0n && awardRecipient !== null) {
    credits.push({
      id: newUlid(t),
      userId: awardRecipient,
      reason: 'creator_award',
      amount: award.toString(),
    });
  }
  return credits;
}

/** The locked config's award recipient (null for house questions and rooms). */
function awardRecipientOf(result: TallyResult): string | null {
  const config = result.manifest.config as { free?: { awardRecipient?: string | null } };
  return config.free?.awardRecipient ?? null;
}

/** Applies a Free mode's settlement. Idempotent: SettlementDO calls it again on a retry. */
export async function applyFree(
  env: Env,
  result: TallyResult,
  deps: FreeApplyDeps = FREE_APPLY_DEPS,
): Promise<void> {
  const db = env.DB;
  const { manifest, record, bundleHash } = result;
  const roundId = manifest.roundId;
  if (manifest.mode !== 'free') throw new IntegrityError('applyFree got a Stakes result');
  const mode = await loadMode(db, roundId);
  if (!mode) throw new IntegrityError(`round ${roundId} has no free mode`);
  const outcome = record.outcome;
  const retry = mode.status === outcome && mode.bundle_hash === bundleHash;
  if (mode.status !== 'revealing' && !retry) {
    throw new IntegrityError(`the free mode of ${roundId} is ${mode.status}, not revealing`);
  }
  const scope = scopeForRound({ kind: mode.kind, roomId: mode.room_id });
  const awardRecipient = awardRecipientOf(result);
  if (scope !== GLOBAL_SCOPE && awardRecipient !== null) {
    throw new IntegrityError('a room round names a creator award recipient');
  }

  const t = await writeRecord(db, result, awardRecipient, now(env));
  // The credits and their integrity checks come before the reveal (W6-F1 R6): a bad result throws
  // with the round still unrevealed, not revealed and never paid.
  const credits = creditsOf(result, awardRecipient, t);
  await writeEntries(db, result);
  // The reveal comes before any balance moves: a credit says which side won (spec "API" › Reveal
  // gating), so `revealed_at` is set once the record and the outcomes are durable (W6-D).
  await db
    .prepare(
      `UPDATE round_modes SET revealed_at = ?2
       WHERE round_id = ?1 AND mode = 'free' AND status = 'revealing' AND revealed_at IS NULL`,
    )
    .bind(roundId, t)
    .run();
  const inserted = await writeCredits(db, roundId, scope, credits, t);

  // The outputs are durable: the mode is final (Free has no proposal stage).
  await db
    .prepare(
      `UPDATE round_modes SET status = ?2, refund_reason = ?3, bundle_hash = ?4, revealed_at = ?5,
         final_at = ?5
       WHERE round_id = ?1 AND mode = 'free' AND status = 'revealing'`,
    )
    .bind(roundId, outcome, record.refundReason, bundleHash, t)
    .run();
  const after = await loadMode(db, roundId);
  if (after?.status !== outcome || after.bundle_hash !== bundleHash) {
    throw new IntegrityError(`the free mode of ${roundId} did not become ${outcome}`);
  }
  log.info('free_applied', {
    roundId,
    outcome,
    refundReason: record.refundReason,
    payouts: result.payouts.length,
    ledgerRows: inserted,
    dust: record.dust.toString(),
    creatorAward: record.creatorAward.toString(),
    retry,
  });

  await deps.notifyRound(
    env,
    roundId,
    outcome === 'settled' && record.winner !== null
      ? {
          outcome: 'revealed',
          winningOption: record.winner,
          tally: tallyOf(result),
          bundleHash,
          revealedAt: t,
        }
      : {
          outcome: 'refunded',
          reason: record.refundReason ?? 1,
          provisional: false,
          bundleHash,
        },
  );

  await deps.anchorManifest(env, {
    roundKey: roundKey(roundId, 'free'),
    roundId,
    mode: 'free',
    manifestHash: bundleHash,
    beaconTimeSec: beaconTime(
      chainFromEnv(env as unknown as Record<string, string | undefined>),
      manifest.beaconRound,
    ),
  });

  await archiveCiphertexts(env, result);
}

/**
 * Removes the mode's ciphertexts from D1 (spec "Data model" › Archival), chunk by chunk, once the
 * R2 manifest is the bundle's bytes and each chunk object exists. Bundle chunk i holds exactly the
 * entries with seq (receipt_seq) in [firstSeq, lastSeq].
 */
async function archiveCiphertexts(env: Pick<Env, 'DB' | 'BUCKET'>, result: TallyResult) {
  const roundId = result.manifest.roundId;
  const stored = await env.BUCKET.get(manifestKey(roundId, 'free'));
  if (!stored) throw new IntegrityError(`the bundle manifest of ${roundId} is not in R2`);
  if (keccak256(new Uint8Array(await stored.arrayBuffer())) !== result.bundleHash) {
    throw new IntegrityError(`the bundle manifest of ${roundId} does not hash to its bundle`);
  }
  const stmts: D1PreparedStatement[] = [];
  for (const c of result.chunks) {
    if (!(await env.BUCKET.head(c.key))) {
      throw new IntegrityError(`bundle chunk ${c.key} is not in R2`);
    }
    stmts.push(
      env.DB.prepare(
        `UPDATE entries SET ciphertext = NULL WHERE round_id = ?1 AND mode = 'free'
           AND receipt_seq BETWEEN ?2 AND ?3 AND ciphertext IS NOT NULL`,
      ).bind(roundId, c.firstSeq, c.lastSeq),
    );
  }
  if (stmts.length === 0) return;
  const results = await env.DB.batch(stmts);
  const archived = results.reduce((s, r) => s + r.meta.changes, 0);
  log.info('free_archived', { roundId, chunks: stmts.length, archived });
}

/**
 * Refunds a Free mode that cannot settle: rule 7 (the commitment was not anchored before the
 * beacon; SettlementDO calls this at beacon time) or rule 8 (the beacon is still unavailable 24 h
 * after its round time; the settle consumer calls this for the RoundDO's rule-8 job). Applies only
 * while the mode is still pending; a retry after that update finishes the refunds.
 */
export async function refundFree(
  env: Env,
  roundId: string,
  reason: 7 | 8,
  deps: FreeApplyDeps = FREE_APPLY_DEPS,
): Promise<void> {
  const db = env.DB;
  await db
    .prepare(
      `UPDATE round_modes SET status = 'refunded', refund_reason = ?2, final_at = ?3
       WHERE round_id = ?1 AND mode = 'free' AND status = 'pending'`,
    )
    .bind(roundId, reason, now(env))
    .run();
  const mode = await loadMode(db, roundId);
  if (!mode) throw new Error(`refundFree: round ${roundId} has no free mode`);
  const ours = mode.refund_reason === 7 || mode.refund_reason === 8;
  if (mode.status !== 'refunded' || !ours || mode.final_at === null) {
    // It revealed, or was voided or refunded another way: that path owns the outcome.
    log.info('free_refund_skipped', { roundId, reason, status: mode.status });
    return;
  }
  const t = mode.final_at;
  const credits: Credit[] = [];
  let after = -1;
  for (;;) {
    const { results } = await db
      .prepare(
        `SELECT user_id, stake, receipt_seq FROM entries
         WHERE round_id = ?1 AND mode = 'free' AND receipt_seq > ?2 ORDER BY receipt_seq LIMIT 5000`,
      )
      .bind(roundId, after)
      .all<{ user_id: string; stake: number; receipt_seq: number }>();
    for (const e of results) {
      credits.push({
        id: newUlid(t),
        userId: e.user_id,
        reason: 'refund',
        amount: String(e.stake),
        kind: 'refund',
      });
    }
    const last = results[results.length - 1];
    if (!last || results.length < 5000) break;
    after = last.receipt_seq;
  }
  const scope = scopeForRound({ kind: mode.kind, roomId: mode.room_id });
  const inserted = await writeCredits(db, roundId, scope, credits, t);
  log.warn('free_refunded', {
    roundId,
    refundReason: mode.refund_reason,
    entries: credits.length,
    ledgerRows: inserted,
  });
  await deps.notifyRound(env, roundId, {
    outcome: 'refunded',
    reason: mode.refund_reason as RefundReason,
    provisional: false,
  });
}
