// SettlementDO: one per (round, mode). Tracks decrypt chunks and triggers the reduce step when all
// are done, idempotently (spec "Architecture"). Every step runs from the alarm, one at a time:
//
//   preparing  → Stakes, from close (the RoundDO starts the job then): the entry set streamed from
//                the chain up to the close block and reconciled once the safe head has passed it
//                (src/settlement/stakes/entry-set.ts; a final mismatch posts nothing), and
//                `refundTooFew` when it has fewer than minEntrants. Free: the anchored commitment
//                (rule 7 if the AnchorDO gave up). Then the beacon from the relays, verified for
//                exactly beaconRound (every 3 s for 10 min, then ALERT_BEACON_LATE and every 60 s);
//                Stakes: the safe-head predicate. Then pending → revealing in D1, the verified
//                beacon and the decrypt chunks in R2, one queue message per chunk.
//   decrypting → chunkDone() records each chunk once; the last one schedules the reduce. A stalled
//                chunk is re-sent every 5 min (the consumers are idempotent), and alerts after 3.
//   reducing   → settle, the payout tree and the write-once bundle; ALERT_VOID_RATE and a
//                `void_rate` hold when a mode's VOIDs exceed 2 % and number ≥ 10.
//   applying   → waits while settlementHold(round, mode) is open, then calls applyFree / applyStakes.
//   proposing  → Stakes: follows the proposal onchain until the round is final: `finalize` once
//                claimsOpenAt has passed, and the proposal posted again when the one that landed is
//                gone (a vetoed refund proposal, or a reorg). Every Stakes job that hasn't ended the
//                round (a failed one included) calls `refundTimeout` once closesAt + 72 h has passed.
//   done | failed.
//
// An integrity failure (a root that doesn't match D1, a reconciliation mismatch, a bundle object
// that already exists with other bytes) fails the job and pages (ALERT_SETTLEMENT_FAILED). Any other
// error retries with backoff and pages after 5 attempts in a row. The relay that served the beacon
// is logged, never stored in the bundle, so a retry from another relay writes the same bytes.
import { DurableObject } from 'cloudflare:workers';
import type { Mode, ModeStatus } from '@flocked/shared';
import { beaconTime, chainFromEnv, type DrandChain } from '@flocked/tlock';
import type { Hex } from 'viem';
import { finalize, refundTimeout, refundTooFew, type OperatorTxResult } from '../chain/operator.js';
import type { Env } from '../env.js';
import { settlementHold } from '../indexer/holds.js';
import { operatorDeps } from '../lifecycle/sent.js';
import { raiseAlert } from '../lib/alert.js';
import { now } from '../lib/clock.js';
import { isNotImplemented } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { settleKey } from '../rounds/schedule.js';
import { applyFree, refundFree } from '../settlement/apply/free.js';
import {
  ProposalPendingError,
  applyStakes,
  type StakesApplyDeps,
} from '../settlement/apply/stakes.js';
import {
  beaconRetryMs,
  fetchVerifiedBeacon,
  isBeaconLate,
  relaysFor,
} from '../settlement/beacon.js';
import { BundleConflictError } from '../settlement/bundle.js';
import type { BeaconFile } from '../settlement/decrypt.js';
import {
  BUNDLE_CHUNK_SIZE,
  DECRYPT_CHUNK_SIZE,
  beaconKey,
  decryptOutputKey,
} from '../settlement/keys.js';
import {
  EntrySetPendingError,
  IntegrityError,
  anchoredCommitment,
  loadRound,
  prepareChunks,
  type SettlementRound,
} from '../settlement/prepare.js';
import { reduce } from '../settlement/reduce.js';
import { safeHeadReady } from '../settlement/safe-head.js';
import {
  advanceEntrySet,
  newEntrySet,
  type EntrySetState,
} from '../settlement/stakes/entry-set.js';
import { escrowOf, providerClient, readEscrowRound } from '../settlement/stakes/escrow.js';
import type { TallyResult } from '../settlement/types.js';
import { anomalousVoidRate, holdForVoidRate } from '../settlement/void-rate.js';
import type {
  DecryptChunkResult,
  SettlementDORpc,
  SettlementKey,
  SettlementPhase,
  SettlementStatus,
} from './types.js';

/** The instance name for a (round, mode): `env.SETTLEMENT.idFromName(settlementName(...))`. */
export function settlementName(roundId: string, mode: Mode): string {
  return `${roundId}:${mode}`;
}

/** No chunk progress for this long (wall time) re-sends the missing chunks. */
export const DECRYPT_STALL_MS = 5 * 60_000;
export const DECRYPT_WATCH_MS = 60_000;
/** Re-sends before ALERT_SETTLEMENT_FAILED (the job keeps going). */
export const DECRYPT_RESENDS_BEFORE_ALERT = 3;
/** How often a held settlement checks whether its hold was released. */
export const HOLD_POLL_MS = 60_000;
/** Consecutive failed attempts of a step before ALERT_SETTLEMENT_FAILED. */
export const ATTEMPTS_BEFORE_ALERT = 5;
/** How often a Stakes proposal is checked onchain until its round is final (a veto, claimsOpenAt). */
export const FOLLOW_MS = 60_000;
/** D1 still without the streamed entry set this long (wall time) alerts once. */
export const ENTRY_SET_ALERT_MS = 10 * 60_000;
/** A pending operator transaction (propose, finalize, a refund) is polled again after this long. */
const TX_PENDING_MS = 3_000;
/** FlockedEscrow REFUND_TIMEOUT: `refundTimeout` is open to anyone from closesAt + 72 h. */
export const REFUND_TIMEOUT_MS = 72 * 3_600_000;
const STAKES_TERMINAL: readonly ModeStatus[] = ['settled', 'refunded', 'voided'];
const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 60_000;
/** sendBatch takes at most 100 messages. */
const SEND_BATCH = 100;

interface Job {
  roundId: string;
  mode: Mode;
  idempotencyKey: string;
  phase: SettlementPhase;
  startedAt: number;
  updatedAt: number;
  error: string | null;
  /** Consecutive failed attempts of the current step. */
  attempts: number;
  /** Where the next beacon attempt starts in the relay list. */
  relayCursor: number;
  /** Free: the commitment check is done (`anchored` null means no entries). */
  anchorChecked: boolean;
  anchored: { root: Hex; txHash: Hex; entryCount: number | null } | null;
  signature: string | null;
  chunkKeys: string[];
  chunksDone: number;
  /** Wall-clock ms of the last chunkDone (or of the fan-out). */
  lastProgressAt: number;
  lastSendAt: number | null;
  resends: number;
  bundleHash: Hex | null;
  /** Fixed at start, so a restart can't change the bundle's bytes. */
  sizes: { decrypt: number; bundle: number };
  alerted: {
    beaconLate?: boolean;
    stalled?: boolean;
    failing?: boolean;
    voidRate?: boolean;
    entrySet?: boolean;
  };
  /** Stakes: the entry set streamed from the chain (src/settlement/stakes/entry-set.ts). */
  entrySet?: EntrySetState;
  /** Stakes: `tooFew` once refundTooFew is the way the round ends (fewer than minEntrants). */
  stakesPath?: 'propose' | 'tooFew';
  /** Stakes: since when (wall ms) D1 hasn't held the reconciled entry set. */
  entrySetWaitSince?: number;
}

const JOB = 'job';
const chunkResultKey = (index: number) => `chunk:${index}`;

export class SettlementDO extends DurableObject<Env> implements SettlementDORpc {
  /** Tests: replaces `fetch` for the drand relays. */
  relayFetch: typeof fetch | undefined;
  /** Tests run every alarm by hand (`runDurableObjectAlarm`): alarms are set an hour later. */
  manualAlarms = false;
  /** Tests: smaller chunks, read when a job starts. */
  chunkSizes = { decrypt: DECRYPT_CHUNK_SIZE, bundle: BUNDLE_CHUNK_SIZE };
  /** Tests: observe or replace the mode hooks. */
  hooks = { applyFree, applyStakes, refundFree, safeHeadReady, stakesEntrySet: advanceEntrySet };
  /** Tests point the Stakes chain calls (reads, the operator) at a fake RPC. Not an RPC method. */
  stakesDeps: StakesApplyDeps | undefined;

  private job: Job | null | undefined;
  private running: Promise<void> | null = null;

  // ---- RPC ----------------------------------------------------------------------------------------

  async start(key: SettlementKey): Promise<{ started: boolean; status: SettlementStatus }> {
    const existing = await this.load();
    if (existing) return { started: false, status: statusOf(existing) };
    if (key.idempotencyKey !== settleKey(key.roundId, key.mode)) {
      log.error('settlement_bad_key', { ...key });
      return { started: false, status: statusOf(null) };
    }
    const t = Date.now();
    const job: Job = {
      roundId: key.roundId,
      mode: key.mode,
      idempotencyKey: key.idempotencyKey,
      phase: 'preparing',
      startedAt: t,
      updatedAt: t,
      error: null,
      attempts: 0,
      relayCursor: 0,
      anchorChecked: false,
      anchored: null,
      signature: null,
      chunkKeys: [],
      chunksDone: 0,
      lastProgressAt: t,
      lastSendAt: null,
      resends: 0,
      bundleHash: null,
      sizes: { ...this.chunkSizes },
      alerted: {},
    };
    await this.save(job);
    await this.wake(0);
    log.info('settlement_started', { roundId: key.roundId, mode: key.mode });
    return { started: true, status: statusOf(job) };
  }

  async chunkDone(chunkKey: string, result: DecryptChunkResult): Promise<SettlementStatus> {
    const job = await this.load();
    if (!job) return statusOf(null);
    const index = job.chunkKeys.indexOf(chunkKey);
    if (index < 0 || result.resultKey !== decryptOutputKey(job.roundId, job.mode, index)) {
      log.warn('settlement_unknown_chunk', { roundId: job.roundId, mode: job.mode, chunkKey });
      return statusOf(job);
    }
    // A re-delivered message, or a re-sent chunk that finished twice: counted once.
    if ((await this.ctx.storage.get(chunkResultKey(index))) !== undefined) return statusOf(job);
    await this.ctx.storage.put(chunkResultKey(index), result);
    job.chunksDone += 1;
    job.lastProgressAt = Date.now();
    if (job.phase === 'decrypting' && job.chunksDone === job.chunkKeys.length) {
      job.phase = 'reducing';
      await this.wake(0);
    }
    await this.save(job);
    return statusOf(job);
  }

  async status(): Promise<SettlementStatus> {
    return statusOf(await this.load());
  }

  override async alarm(): Promise<void> {
    await this.advance();
  }

  // ---- Steps --------------------------------------------------------------------------------------

  /** Runs the current step; one pass at a time. */
  private advance(): Promise<void> {
    this.running ??= this.step().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async step(): Promise<void> {
    const job = await this.load();
    if (!job) return;
    try {
      if (job.mode === 'stakes' && (await this.timedOut(job))) {
        // The refund timeout has passed with the round still unsettled: refundTimeout ends it.
        job.phase = 'proposing';
        await this.save(job);
      }
      switch (job.phase) {
        case 'preparing':
          return await this.prepare(job);
        case 'decrypting':
          return await this.watchDecrypt(job);
        case 'reducing':
        case 'applying':
          return await this.reduceAndApply(job);
        case 'proposing':
          return await this.follow(job);
        case 'failed':
          return job.mode === 'stakes' ? await this.backstop(job) : undefined;
        default:
          return;
      }
    } catch (err) {
      if (err instanceof EntrySetPendingError) return this.entrySetPending(job, err);
      if (err instanceof ProposalPendingError) {
        log.info('settlement_waiting', { roundId: job.roundId, mode: job.mode, why: err.message });
        return this.retryIn(job, TX_PENDING_MS);
      }
      await this.failed(job, err);
    }
  }

  /**
   * D1 doesn't hold the reconciled entry set yet (the indexer is behind): wait, and alert once when
   * it still doesn't after ENTRY_SET_ALERT_MS.
   */
  private async entrySetPending(job: Job, err: EntrySetPendingError): Promise<void> {
    log.info('settlement_waiting', { roundId: job.roundId, mode: job.mode, why: err.message });
    job.entrySetWaitSince ??= Date.now();
    if (Date.now() - job.entrySetWaitSince >= ENTRY_SET_ALERT_MS && !job.alerted.entrySet) {
      job.alerted.entrySet = true;
      raiseAlert(this.env, 'ALERT_SETTLEMENT_FAILED', {
        roundId: job.roundId,
        mode: job.mode,
        step: 'entry_set_not_ingested',
        error: err.message,
      });
    }
    return this.retryIn(job, TX_PENDING_MS);
  }

  /** Stakes chain access: the env's providers and the operator, every send recorded. */
  private stakesChain(): Required<StakesApplyDeps> {
    return {
      operator: this.stakesDeps?.operator ?? operatorDeps(this.env),
      escrow: this.stakesDeps?.escrow ?? {},
    };
  }

  private chain(): DrandChain {
    return chainFromEnv(this.env as unknown as Record<string, string | undefined>);
  }

  private async round(job: Job): Promise<SettlementRound> {
    const round = await loadRound(this.env.DB, job.roundId, job.mode);
    if (!round) throw new IntegrityError('no locked round with this mode');
    return round;
  }

  private async prepare(job: Job): Promise<void> {
    const round = await this.round(job);
    if (round.status !== 'pending' && round.status !== 'revealing') {
      // Our rule-7 refund failed after its pending → refunded update: finish it (refundFree is
      // idempotent).
      if (job.mode === 'free' && round.status === 'refunded' && round.refundReason === 7) {
        return this.refundUnanchored(job, 'retrying the rule-7 refund');
      }
      // Voided, or refunded by rule 8: nothing to settle.
      return this.stop(job, `mode is ${round.status}`, 'failed');
    }
    const chain = this.chain();
    const beaconSec = beaconTime(chain, round.beaconRound);
    const t = now(this.env);
    if (job.mode === 'stakes' && !(await this.stakesEntrySet(job, round, beaconSec, t))) return;
    if (t < beaconSec * 1000) return this.retryIn(job, beaconSec * 1000 - t);

    if (job.mode === 'free' && !job.anchorChecked) {
      const a = await anchoredCommitment(this.env, round);
      if (a.state === 'waiting') {
        log.info('settlement_waiting', { roundId: job.roundId, mode: job.mode, why: a.detail });
        return this.retryIn(job, beaconRetryMs(t, beaconSec));
      }
      if (a.state === 'missing') return this.refundUnanchored(job, a.detail);
      job.anchored =
        a.state === 'anchored'
          ? { root: a.root, txHash: a.txHash, entryCount: a.entryCount }
          : null;
      job.anchorChecked = true;
      await this.save(job);
    }

    if (job.signature === null) {
      const relays = relaysFor(this.env, chain);
      if (relays instanceof Error) throw relays;
      const got = await fetchVerifiedBeacon({
        chain,
        round: round.beaconRound,
        relays,
        fetch: this.relayFetch ?? ((input, init) => fetch(input, init)),
        start: job.relayCursor,
      });
      if (!got.ok) {
        job.relayCursor += 1;
        log.warn('settlement_beacon_unavailable', {
          roundId: job.roundId,
          mode: job.mode,
          beaconRound: round.beaconRound,
          failures: got.failures,
        });
        if (isBeaconLate(t, beaconSec) && !job.alerted.beaconLate) {
          job.alerted.beaconLate = true;
          raiseAlert(this.env, 'ALERT_BEACON_LATE', {
            roundId: job.roundId,
            mode: job.mode,
            beaconRound: round.beaconRound,
            beaconTime: beaconSec,
          });
        }
        return this.retryIn(job, beaconRetryMs(t, beaconSec));
      }
      // The relay goes to the log only: the bundle must not depend on which relay answered.
      log.info('settlement_beacon', {
        roundId: job.roundId,
        mode: job.mode,
        beaconRound: round.beaconRound,
        relay: got.beacon.relay,
        failures: got.failures,
      });
      job.signature = got.beacon.signature;
      await this.save(job);
    }

    const safe = await this.hooks.safeHeadReady(
      this.env,
      job.roundId,
      job.mode,
      this.stakesChain().escrow,
    );
    if (!safe) return this.retryIn(job, beaconRetryMs(t, beaconSec));

    // pending → revealing (spec "Round lifecycle"); conditional, so a rule-8 refund wins a race.
    await this.env.DB.prepare(
      "UPDATE round_modes SET status = 'revealing' WHERE round_id = ?1 AND mode = ?2 AND status = 'pending'",
    )
      .bind(job.roundId, job.mode)
      .run();
    const after = await this.round(job);
    if (after.status !== 'revealing') return this.stop(job, `mode is ${after.status}`, 'failed');

    const beacon: BeaconFile = { round: round.beaconRound, signature: job.signature };
    await this.env.BUCKET.put(beaconKey(job.roundId, job.mode), JSON.stringify(beacon));
    const set = job.entrySet;
    const prepared = await prepareChunks(
      this.env,
      round,
      job.anchored ? { state: 'anchored', ...job.anchored } : null,
      job.sizes.decrypt,
      set?.reconciled ? { files: set.files, count: set.count } : null,
    );
    if (job.anchored && job.anchored.entryCount === null) {
      job.anchored.entryCount = prepared.entryCount;
    }
    job.chunkKeys = prepared.keys;
    job.chunksDone = 0;
    job.phase = prepared.keys.length === 0 ? 'reducing' : 'decrypting';
    job.lastProgressAt = Date.now();
    job.attempts = 0;
    job.error = null;
    await this.save(job);
    log.info('settlement_fanout', {
      roundId: job.roundId,
      mode: job.mode,
      entries: prepared.entryCount,
      chunks: prepared.keys.length,
    });
    if (job.phase === 'reducing') return this.wake(0);
    await this.sendMissing(job, round.kind === 'room');
    return this.wakeWhileDecrypting(job);
  }

  /**
   * The watchdog alarm, unless the last chunkDone arrived while this step awaited I/O and moved the
   * job on: then the reduce runs now.
   */
  private wakeWhileDecrypting(job: Job): Promise<void> {
    return this.wake(job.phase === 'decrypting' ? DECRYPT_WATCH_MS : 0);
  }

  /** Sends a decrypt message for every chunk without a result. */
  private async sendMissing(job: Job, room: boolean): Promise<string[]> {
    const done = await this.ctx.storage.get(job.chunkKeys.map((_, i) => chunkResultKey(i)));
    const missing = job.chunkKeys.filter((_, i) => !done.has(chunkResultKey(i)));
    const queue = room ? this.env.QUEUE_DECRYPT_ROOMS : this.env.QUEUE_DECRYPT_DAILY;
    for (let i = 0; i < missing.length; i += SEND_BATCH) {
      await queue.sendBatch(
        missing.slice(i, i + SEND_BATCH).map((chunkKey) => ({
          body: { roundId: job.roundId, mode: job.mode, chunkKey },
        })),
      );
    }
    job.lastSendAt = Date.now();
    await this.save(job);
    return missing;
  }

  private async watchDecrypt(job: Job): Promise<void> {
    if (job.chunksDone === job.chunkKeys.length) {
      job.phase = 'reducing';
      await this.save(job);
      return this.reduceAndApply(job);
    }
    const t = Date.now();
    const quietSince = Math.max(job.lastProgressAt, job.lastSendAt ?? 0);
    if (job.lastSendAt === null || t - quietSince >= DECRYPT_STALL_MS) {
      const resend = job.lastSendAt !== null;
      const round = await this.round(job);
      const missing = await this.sendMissing(job, round.kind === 'room');
      if (missing.length === 0) {
        // Every chunk has its result, but the job write after the last one was lost.
        job.chunksDone = job.chunkKeys.length;
        job.phase = 'reducing';
        await this.save(job);
        return this.reduceAndApply(job);
      }
      if (resend) {
        job.resends += 1;
        log.warn('settlement_chunks_resent', {
          roundId: job.roundId,
          mode: job.mode,
          missing: missing.length,
          resends: job.resends,
        });
      }
      if (job.resends >= DECRYPT_RESENDS_BEFORE_ALERT && !job.alerted.stalled) {
        job.alerted.stalled = true;
        raiseAlert(this.env, 'ALERT_SETTLEMENT_FAILED', {
          roundId: job.roundId,
          mode: job.mode,
          step: 'decrypt_stalled',
          missing: missing.length,
        });
      }
      await this.save(job);
    }
    return this.wakeWhileDecrypting(job);
  }

  private async reduceAndApply(job: Job): Promise<void> {
    let result: TallyResult | null = null;
    if (job.phase === 'reducing') {
      result = await this.reduce(job);
      job.bundleHash = result.bundleHash;
      log.info('settlement_bundle', {
        roundId: job.roundId,
        mode: job.mode,
        bundleHash: result.bundleHash,
        entries: result.entries.length,
        chunks: result.chunks.length,
      });
      const voids = Number(result.record.voidCount);
      if (anomalousVoidRate(voids, result.entries.length)) {
        await holdForVoidRate(this.env.DB, job.roundId, job.mode, now(this.env));
        if (!job.alerted.voidRate) {
          job.alerted.voidRate = true;
          raiseAlert(this.env, 'ALERT_VOID_RATE', {
            roundId: job.roundId,
            mode: job.mode,
            voids,
            entries: result.entries.length,
            byReason: result.manifest.voids,
            bundleHash: result.bundleHash,
          });
        }
      }
      job.phase = 'applying';
      job.attempts = 0;
      job.error = null;
      await this.save(job);
    }

    // Nothing posts while a hold is open (a foreign Stakes entry, or the VOID rate); the guardian's
    // admin action releases it (W11-A).
    const hold = await settlementHold(this.env.DB, job.roundId, job.mode);
    if (hold) {
      if (job.error !== `held:${hold.reason}`) {
        log.warn('settlement_held', { roundId: job.roundId, mode: job.mode, reason: hold.reason });
        job.error = `held:${hold.reason}`;
        await this.save(job);
      }
      return this.wake(HOLD_POLL_MS);
    }

    // After a hold or a restart the result is rebuilt; reduce is deterministic and write-once.
    result ??= await this.reduce(job);
    if (result.bundleHash !== job.bundleHash) {
      throw new IntegrityError(`bundle hash changed: ${job.bundleHash} → ${result.bundleHash}`);
    }
    try {
      if (job.mode === 'free') await this.hooks.applyFree(this.env, result);
      else await this.hooks.applyStakes(this.env, result, this.stakesChain());
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
      log.warn('settlement_apply_not_implemented', { roundId: job.roundId, mode: job.mode });
      return this.stop(job, errorMessage(err), 'failed');
    }
    if (job.mode === 'stakes') {
      // Posted: follow it onchain until the round is final.
      job.phase = 'proposing';
      job.stakesPath = 'propose';
      job.error = null;
      job.attempts = 0;
      await this.save(job);
      log.info('settlement_proposed', { roundId: job.roundId, bundleHash: job.bundleHash });
      return this.wake(FOLLOW_MS);
    }
    job.phase = 'done';
    job.error = null;
    job.attempts = 0;
    await this.save(job);
    log.info('settlement_done', {
      roundId: job.roundId,
      mode: job.mode,
      bundleHash: job.bundleHash,
    });
  }

  private async reduce(job: Job): Promise<TallyResult> {
    if (job.signature === null) throw new Error('reduce before the beacon');
    const round = await this.round(job);
    const results = await this.ctx.storage.get<DecryptChunkResult>(
      job.chunkKeys.map((_, i) => chunkResultKey(i)),
    );
    const partials: DecryptChunkResult[] = [];
    job.chunkKeys.forEach((_, i) => {
      const p = results.get(chunkResultKey(i));
      if (!p) throw new IntegrityError(`chunk ${i} has no result`);
      partials.push(p);
    });
    const a = job.anchored;
    return reduce(this.env, {
      round,
      chainHash: this.chain().chainHash,
      signature: job.signature,
      anchored: a ? { root: a.root, txHash: a.txHash, entryCount: a.entryCount ?? 0 } : null,
      closeBlock: job.entrySet?.closeBlock ?? null,
      chunks: job.chunkKeys.length,
      partials,
      bundleChunkSize: job.sizes.bundle,
    });
  }

  /** Rule 7: the Free commitment was not anchored before the beacon. */
  private async refundUnanchored(job: Job, detail: string): Promise<void> {
    log.warn('settlement_not_anchored', { roundId: job.roundId, detail });
    try {
      await this.hooks.refundFree(this.env, job.roundId, 7);
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
      return this.stop(job, `${errorMessage(err)} (rule 7: ${detail})`, 'failed');
    }
    return this.stop(job, null, 'done');
  }

  // ---- Stakes -------------------------------------------------------------------------------------

  /**
   * One step of the entry set (from close). True once it is reconciled with at least minEntrants
   * entries; otherwise the job waits, ends (a final mismatch, alerted), or goes on to refundTooFew.
   */
  private async stakesEntrySet(
    job: Job,
    round: SettlementRound,
    beaconSec: number,
    t: number,
  ): Promise<boolean> {
    job.entrySet ??= newEntrySet();
    const step = await this.hooks.stakesEntrySet(this.env, round, job.entrySet, {
      nowMs: t,
      beaconTimeSec: beaconSec,
      deps: this.stakesChain().escrow,
    });
    await this.save(job);
    if (step.status === 'wait') {
      await this.retryIn(job, step.ms);
      return false;
    }
    if (step.status === 'mismatch') {
      await this.stop(job, step.detail, 'failed');
      return false;
    }
    const min = round.config.stakes?.minEntrants ?? 1;
    if (step.count >= min) return true;
    // Too few entries: no reveal; refundTooFew (reason 1) is open from closesAt.
    log.info('settlement_too_few', {
      roundId: job.roundId,
      entries: step.count,
      minEntrants: min,
    });
    job.stakesPath = 'tooFew';
    job.phase = 'proposing';
    await this.save(job);
    await this.wake(0);
    return false;
  }

  private async escrowRound(round: SettlementRound) {
    const client = providerClient(this.env, 'primary', this.stakesChain().escrow);
    if (!client || round.chainRoundId === null) throw new Error('no RPC provider or chain round');
    return readEscrowRound(client, escrowOf(this.env), round.chainRoundId);
  }

  /** True when the refund timeout has passed for a Stakes job still short of `proposing`. */
  private async timedOut(job: Job): Promise<boolean> {
    if (!['preparing', 'decrypting', 'reducing', 'applying'].includes(job.phase)) return false;
    const round = await loadRound(this.env.DB, job.roundId, job.mode);
    return round !== null && now(this.env) >= round.closesAt + REFUND_TIMEOUT_MS;
  }

  /** Stakes: one look at the round onchain, until it is final (see the header). */
  private async follow(job: Job): Promise<void> {
    const round = await this.round(job);
    if (STAKES_TERMINAL.includes(round.status)) return this.stop(job, null, 'done');
    const onchain = await this.escrowRound(round);
    const t = now(this.env);
    const { operator } = this.stakesChain();
    const ids = { roundId: job.roundId, chainRoundId: round.chainRoundId as string };
    switch (onchain.status) {
      case 'Settled':
      case 'Refunded':
        // Final onchain; the indexer moves D1 (RoundFinalized, RoundRefunded).
        return this.stop(job, null, 'done');
      case 'SettleProposed':
      case 'RefundProposed': {
        const at = onchain.claimsOpenAt * 1000;
        if (t < at) return this.wake(Math.min(FOLLOW_MS, at - t));
        return this.afterTx(job, 'finalize', await finalize(this.env, operator, ids));
      }
      case 'Open': {
        if (t >= round.closesAt + REFUND_TIMEOUT_MS) {
          return this.afterTx(job, 'refundTimeout', await refundTimeout(this.env, operator, ids));
        }
        if (job.stakesPath === 'tooFew') {
          return this.afterTx(job, 'refundTooFew', await refundTooFew(this.env, operator, ids));
        }
        // No proposal onchain: applyStakes polls one still pending, waits on one that landed until
        // the indexer marks it gone, and posts the next one after a veto or a reorg.
        if (await settlementHold(this.env.DB, job.roundId, job.mode))
          return this.wake(HOLD_POLL_MS);
        const result = await this.reduce(job);
        if (result.bundleHash !== job.bundleHash) {
          throw new IntegrityError(`bundle hash changed: ${job.bundleHash} → ${result.bundleHash}`);
        }
        await this.hooks.applyStakes(this.env, result, this.stakesChain());
        return this.wake(FOLLOW_MS);
      }
      default:
        throw new IntegrityError(`the escrow round is ${onchain.status}`);
    }
  }

  /** After an operator call of `follow`: look again once it is mined, or later. */
  private async afterTx(job: Job, call: string, r: OperatorTxResult): Promise<void> {
    if (r.status === 'mined') {
      log.info('settlement_tx_mined', { roundId: job.roundId, call, txHash: r.txHash });
      return this.wake(0);
    }
    if (r.status === 'pending') return this.wake(TX_PENDING_MS);
    // Refused (it would revert now: the chain's clock behind ours, say), reverted (someone else
    // moved the round first) or cancelled: the next look reads the round again.
    log.warn('settlement_tx_not_mined', {
      roundId: job.roundId,
      call,
      status: r.status,
      error: r.status === 'refused' ? r.error : null,
    });
    return this.wake(FOLLOW_MS);
  }

  /**
   * A failed Stakes job's one alarm: once closesAt + 72 h has passed, `refundTimeout` while the
   * round is still Open onchain. Errors only log: the job has alerted already.
   */
  private async backstop(job: Job): Promise<void> {
    try {
      const round = await this.round(job);
      const at = round.closesAt + REFUND_TIMEOUT_MS;
      const t = now(this.env);
      if (STAKES_TERMINAL.includes(round.status)) return await this.ctx.storage.deleteAlarm();
      if (t < at) return await this.wake(at - t);
      const onchain = await this.escrowRound(round);
      if (onchain.status !== 'Open') return await this.ctx.storage.deleteAlarm();
      const ids = { roundId: job.roundId, chainRoundId: round.chainRoundId as string };
      const r = await refundTimeout(this.env, this.stakesChain().operator, ids);
      log.warn('settlement_refund_timeout', { roundId: job.roundId, status: r.status });
      await this.wake(r.status === 'pending' ? TX_PENDING_MS : FOLLOW_MS);
    } catch (err) {
      log.warn('settlement_backstop_failed', { roundId: job.roundId, error: errorMessage(err) });
      await this.wake(FOLLOW_MS);
    }
  }

  // ---- Bookkeeping --------------------------------------------------------------------------------

  private async failed(job: Job, err: unknown): Promise<void> {
    const message = errorMessage(err);
    if (err instanceof IntegrityError || err instanceof BundleConflictError) {
      raiseAlert(this.env, 'ALERT_SETTLEMENT_FAILED', {
        roundId: job.roundId,
        mode: job.mode,
        phase: job.phase,
        error: message,
      });
      return this.stop(job, message, 'failed');
    }
    job.attempts += 1;
    job.error = message;
    log.warn('settlement_step_failed', {
      roundId: job.roundId,
      mode: job.mode,
      phase: job.phase,
      attempts: job.attempts,
      error: message,
    });
    if (job.attempts >= ATTEMPTS_BEFORE_ALERT && !job.alerted.failing) {
      job.alerted.failing = true;
      raiseAlert(this.env, 'ALERT_SETTLEMENT_FAILED', {
        roundId: job.roundId,
        mode: job.mode,
        phase: job.phase,
        attempts: job.attempts,
        error: message,
      });
    }
    await this.save(job);
    await this.wake(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (job.attempts - 1)));
  }

  /**
   * Ends the job (no alarm). A `failed` stop without an alert is expected (voided, refunded). A
   * failed Stakes job keeps one alarm, at the refund timeout (see `backstop`).
   */
  private async stop(job: Job, error: string | null, phase: SettlementPhase): Promise<void> {
    job.phase = phase;
    job.error = error;
    await this.save(job);
    await this.ctx.storage.deleteAlarm();
    log.info('settlement_stopped', { roundId: job.roundId, mode: job.mode, phase, error });
    if (job.mode === 'stakes' && phase === 'failed') {
      const round = await loadRound(this.env.DB, job.roundId, job.mode);
      if (round && !STAKES_TERMINAL.includes(round.status)) {
        await this.wake(Math.max(FOLLOW_MS, round.closesAt + REFUND_TIMEOUT_MS - now(this.env)));
      }
    }
  }

  private async retryIn(job: Job, ms: number): Promise<void> {
    job.attempts = 0;
    await this.save(job);
    await this.wake(ms);
  }

  private async load(): Promise<Job | null> {
    if (this.job === undefined) this.job = (await this.ctx.storage.get<Job>(JOB)) ?? null;
    return this.job;
  }

  private async save(job: Job): Promise<void> {
    job.updatedAt = Date.now();
    this.job = job;
    await this.ctx.storage.put(JOB, job);
  }

  /** Sets the alarm `ms` of wall time from now (an hour later under `manualAlarms`). */
  private async wake(ms: number): Promise<void> {
    const extra = this.manualAlarms ? 3_600_000 : 0;
    await this.ctx.storage.setAlarm(Date.now() + Math.max(0, ms) + extra);
  }
}

function statusOf(job: Job | null): SettlementStatus {
  return {
    roundId: job?.roundId ?? null,
    mode: job?.mode ?? null,
    phase: job?.phase ?? 'idle',
    chunksTotal: job?.chunkKeys.length ?? 0,
    chunksDone: job?.chunksDone ?? 0,
    startedAt: job?.startedAt ?? null,
    updatedAt: job?.updatedAt ?? null,
    error: job?.error ?? null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
