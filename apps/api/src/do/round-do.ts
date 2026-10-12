// RoundDO: one per round (spec "Real-time and the reveal" › RoundDO responsibilities). W3-B: init,
// the Free commit protocol (enterFree), getState and the alarm chain with close and the commitment
// root. W4-D: the two-phase void (requestVoid, then voidRound from the alarm; src/lifecycle/void.ts),
// the Stakes counters (ingestStakesEntry; W6-A builds the rest of Stakes ingestion) and the
// receiving side of onModeResult. Still a stub: the WebSocket hub in fetch (W7-A; `broadcast` in
// src/rounds/hooks.ts is its seam).
//
// Commit protocol (enterFree), first failure wins:
//   1. checks: initialized, open (opensAt ≤ now < closesAt), a Free mode, stake in the locked
//      range, ciphertext ≤ 2,048 bytes with a canonical header targeting beaconRound; then in D1
//      the user is active and not self-excluded, and a member for room rounds;
//   2. dedupe by user: a committed entry answers with its receipt (same stake and commitment) or
//      `already_entered`; a concurrent request from the same user waits for the first, then re-runs;
//   3. the daily grant (daily rounds), then the atomic stake batch with the entry insert, which
//      allocates `receipt_seq` inside D1's transaction (src/rounds/entry.ts `entryInsert`): seqs
//      are gap-free by construction and a rolled-back batch consumes none. On any batch failure
//      the user's entry is looked up first: a retried stake that already committed fails the
//      balance CHECK before it reaches the unique keys;
//   4. only after commit: record the leaf, update the counters, sign and return the receipt.
// Every accepted request is tracked in `inflight` from its first await to its answer, so close can
// drain them. Close then marks the round closed in D1 (after which no entry insert can commit),
// reconciles leaves against D1 and builds the root from D1's committed entries.
//
// Void: a requested void stops entries at once. The alarm then pushes `voidRound` (Stakes) until it
// is mined, which FlockedEscrow allows only in a block stamped before closesAt; a confirmed void
// refunds and voids every mode in D1 and ends the alarm chain. A void still unconfirmed at close is
// abandoned only on proof (the head stamped at or after closesAt, read first, then a definite final
// push; W4-F1 V1), its `voidRound` is cancelled, and the round closes normally.
import { DurableObject } from 'cloudflare:workers';
import {
  LockedConfigSchema,
  newUlid,
  roundKey,
  type Mode,
  type ModeStatus,
  type RoundStatus,
} from '@flocked/shared';
import { beaconTime, chainFromEnv, type DrandChain } from '@flocked/tlock';
import type { Hex } from 'viem';
import { cancelVoidRound, type OperatorDeps } from '../chain/operator.js';
import { receiptSigner, receiptUserIdHash, type ReceiptSigner } from '../crypto/receipt.js';
import type { Env } from '../env.js';
import { operatorDeps } from '../lifecycle/sent.js';
import {
  VOID_REFUND_REASON,
  applyVoid,
  chainHeadPastClose,
  pushVoid,
  voidAbandonable,
  type VoidStep,
} from '../lifecycle/void.js';
import { raiseAlert } from '../lib/alert.js';
import { now } from '../lib/clock.js';
import { isNotImplemented } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { classifyPointsError, scopeForRound, stakeMovement } from '../points/index.js';
import { buildFreeRoot, reconcile, type Leaf } from '../rounds/close.js';
import {
  checkEligibility,
  checkEntryBody,
  entryInsert,
  findFreeEntry,
  isRejection,
  isRoundSealedError,
  listFreeEntries,
  reject,
  type CheckedBody,
  type CommittedEntry,
  type EntryRejection,
} from '../rounds/entry.js';
import { applyDailyGrant } from '../rounds/grant.js';
import { broadcast, enqueueNotifications, type HookRound } from '../rounds/hooks.js';
import {
  roundEvents,
  rule8Key,
  settleKey,
  type RoundEvent,
  type RoundEventKind,
} from '../rounds/schedule.js';
import { ANCHOR_SINGLETON } from './anchor-do.js';
import { notImplementedResponse } from './stub.js';
import type {
  AnchorCommitItem,
  EnterFreeRequest,
  EnterFreeResponse,
  LockedRound,
  ModeResult,
  RoundDORpc,
  RoundState,
  RpcResult,
  StakesEntryEvent,
  StakesIngestResult,
  VoidRequestResult,
} from './types.js';

/** A failed alarm event is first retried after this long (game clock), doubling up to the cap. */
const EVENT_RETRY_MS = 10_000;
const EVENT_RETRY_MAX_MS = 10 * 60_000;
/** ALERT_DO_ERROR for one round and event at most this often while it keeps failing. */
const ALERT_THROTTLE_MS = 15 * 60_000;
/** A failed commit hand-off to the AnchorDO is retried after this long, until its deadline. */
const COMMIT_RETRY_MS = 5_000;
/** A pending void is pushed again after this long (about one Base block and a half). */
const VOID_RETRY_MS = 3_000;
/** A void whose `voidRound` is refused this many times in a row alerts once (V2). */
export const VOID_REFUSED_ALERT_AFTER = 5;

/** The retry delay after `attempt` consecutive failures of one event. */
export function eventRetryDelay(attempt: number): number {
  return Math.min(EVENT_RETRY_MS * 2 ** Math.max(0, attempt - 1), EVENT_RETRY_MAX_MS);
}

/** An event that is not done yet but has not failed either: retried after `afterMs`, no alert. */
class RetryLater extends Error {
  constructor(
    readonly afterMs: number,
    message: string,
  ) {
    super(message);
  }
}

/** The Free close record: the commitment root and its hand-off to the AnchorDO. */
export interface FreeCloseRecord {
  root: Hex | null;
  entryCount: number;
  totalStake: string;
  closedAt: number;
  /** `none`: no entries, nothing to anchor; `retrying`: the hand-off has not succeeded yet. */
  anchor: 'none' | 'queued' | 'already_anchored' | 'retrying' | 'not_implemented' | 'late';
  /** min(close + 90 s, beaconTime − 30 s), epoch ms (the commit deadline, `AnchorCommitItem`). */
  deadline: number;
  nextAttemptAt: number | null;
}

/** The two-phase void (spec "Round lifecycle" › Void). */
export interface VoidRecord {
  /** Epoch ms (game clock): entries stopped here. */
  requestedAt: number;
  /**
   * `requested`: entries are stopped and the void is not confirmed yet; `confirmed`: every mode is
   * voided (refund rule 4); `abandoned`: it did not confirm before closesAt, so the round closed
   * normally.
   */
  state: 'requested' | 'confirmed' | 'abandoned';
  /** Confirmed only: the D1 side (refunds, mode rows, sealed round) is done. */
  applied: boolean;
  txHash: Hex | null;
  /** Epoch ms (game clock) of the next push while `requested`. */
  retryAt: number;
  detail: string | null;
  /** Consecutive `refused` pushes (V2). Absent in records written before W4-F1. */
  refusals?: number;
  /** ALERT_DO_ERROR fired because the void can't confirm (V2), once. */
  alerted?: boolean;
}

interface Meta {
  locked: LockedRound;
  status: RoundStatus;
  modeStatus: Partial<Record<Mode, ModeStatus>>;
  done: RoundEventKind[];
  /** Per event kind: epoch ms (game clock) before which a failed event is not retried. */
  retryAt: Partial<Record<RoundEventKind, number>>;
  /** Per event kind: consecutive failures (the retry backs off). */
  attempts: Partial<Record<RoundEventKind, number>>;
  /** Per event kind: when ALERT_DO_ERROR last fired for it (throttled). */
  alertedAt: Partial<Record<RoundEventKind, number>>;
  freeClose: FreeCloseRecord | null;
  void: VoidRecord | null;
  /** The last result each mode handed back (onModeResult), so a repeat does not re-broadcast. */
  results: Partial<Record<Mode, ModeResult>>;
}

type StoredMeta = Omit<Meta, 'attempts' | 'alertedAt' | 'void' | 'results'> & Partial<Meta>;

/** Meta as stored, including by the W3 version of this class (before the W4-D fields). */
function normalizeMeta(m: StoredMeta | undefined): Meta | null {
  if (!m) return null;
  return {
    ...m,
    attempts: m.attempts ?? {},
    alertedAt: m.alertedAt ?? {},
    void: m.void ?? null,
    results: m.results ?? {},
  };
}

const TERMINAL: readonly ModeStatus[] = ['settled', 'refunded', 'voided'];

const ok = <T>(value: T): RpcResult<T> => ({ ok: true, value });
const fail = (r: EntryRejection): RpcResult<never> => ({ ok: false, ...r });

const LEAVES_DDL = `CREATE TABLE IF NOT EXISTS leaves (
  seq          INTEGER PRIMARY KEY,
  entry_id     TEXT    NOT NULL UNIQUE,
  user_id      TEXT    NOT NULL UNIQUE,
  stake        INTEGER NOT NULL,
  commitment   TEXT    NOT NULL,
  user_id_hash TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  -- 1 when recorded from D1 at close: committed, but its receipt was never returned
  recovered    INTEGER NOT NULL DEFAULT 0
)`;

/** Stakes `Entered` events counted so far, keyed like chain_events (W6-A adds the rest). */
const STAKES_DDL = `CREATE TABLE IF NOT EXISTS stakes_entries (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  player       TEXT    NOT NULL,
  user_id      TEXT,
  stake        TEXT    NOT NULL,
  commitment   TEXT    NOT NULL,
  block_number INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
)`;

type LeafRow = {
  seq: number;
  entry_id: string;
  user_id: string;
  stake: number;
  commitment: string;
  user_id_hash: string;
  created_at: number;
  recovered: number;
};

const toLeaf = (r: LeafRow): Leaf => ({
  seq: r.seq,
  id: r.entry_id,
  userId: r.user_id,
  stake: r.stake,
  commitment: r.commitment as Hex,
  userIdHash: r.user_id_hash as Hex,
  createdAt: r.created_at,
});

export class RoundDO extends DurableObject<Env> implements RoundDORpc {
  /** Tests hold an entry between its checks and its D1 batch (set through `runInDurableObject`). */
  beforeEntryBatch: (() => Promise<void>) | undefined;
  /** Tests point the void's `voidRound` at a fake RPC. Fields are not RPC methods. */
  operatorDeps: OperatorDeps | undefined;

  private meta: Meta | null = null;
  private counts = { entrantCount: 0, pool: 0n };
  private stakesCounts = { entrantCount: 0, pool: 0n };
  /** Entry requests between their first await and their answer, by user. */
  private readonly inflight = new Map<string, Promise<RpcResult<EnterFreeResponse>>>();
  /** The running alarm-chain pass, so init, a late entry and the alarm never overlap. */
  private running: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(LEAVES_DDL);
    ctx.storage.sql.exec(STAKES_DDL);
    void ctx.blockConcurrencyWhile(async () => {
      this.meta = normalizeMeta(await ctx.storage.get<StoredMeta>('meta'));
      this.recount();
      this.recountStakes();
    });
  }

  // ---- RPC ---------------------------------------------------------------------------------

  async init(locked: LockedRound): Promise<RoundState> {
    const config = LockedConfigSchema.parse(locked.config);
    if (beaconTime(this.chain(), locked.beaconRound) !== locked.beaconTimeSec) {
      throw new RangeError('init: beaconTimeSec does not match beaconRound on the pinned chain');
    }
    if (locked.modes.includes('free') !== (config.free !== undefined)) {
      throw new RangeError('init: the Free mode and the locked config disagree');
    }
    if ((locked.kind === 'room') !== (locked.roomId !== null)) {
      throw new RangeError('init: roomId is required for room rounds only');
    }
    if (this.meta) {
      // The scheduler re-inits every live round each tick: a stalled alarm chain restarts here.
      await this.adoptVoidedModes(this.meta, locked);
      await this.advance();
      return this.getState();
    }
    this.meta = {
      locked,
      status: 'scheduled',
      modeStatus: Object.fromEntries(locked.modes.map((m) => [m, 'pending'])),
      done: [],
      retryAt: {},
      attempts: {},
      alertedAt: {},
      freeClose: null,
      void: null,
      results: {},
    };
    await this.save();
    log.info('round_init', { roundId: locked.roundId, modes: locked.modes });
    await this.advance();
    return this.getState();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- RPC methods are async
  async getState(): Promise<RoundState> {
    const m = this.meta;
    if (!m) throw new Error('not_found: the round is not initialized');
    const l = m.locked;
    const modes: RoundState['modes'] = {};
    for (const mode of l.modes) {
      const c = mode === 'free' ? this.counts : this.stakesCounts;
      modes[mode] = {
        status: m.modeStatus[mode] ?? 'pending',
        entrantCount: c.entrantCount,
        pool: c.pool.toString(),
      };
    }
    return {
      roundId: l.roundId,
      status: m.status,
      voidRequested: voidPending(m),
      opensAt: l.opensAt,
      closesAt: l.closesAt,
      beaconRound: l.beaconRound,
      beaconTimeSec: l.beaconTimeSec,
      modes,
    };
  }

  async enterFree(req: EnterFreeRequest): Promise<RpcResult<EnterFreeResponse>> {
    const m = this.meta;
    if (m?.locked.roundId !== req.roundId) return fail(reject('not_found', 'no such round'));
    const t = now(this.env);
    // A late open alarm must not turn entries away.
    if (m.status === 'scheduled' && t >= m.locked.opensAt) await this.advance();

    const pending = this.inflight.get(req.userId);
    if (pending) {
      await pending.catch(() => undefined);
      return this.enterFree(req);
    }
    // The committed entry answers an identical retry even after close (or a void request), and
    // refuses a second entry while the round is open.
    const leaf = this.leafOf(req.userId);
    if (leaf) {
      const body = this.checkBody(m, req);
      if (!isRejection(body) && sameEntry(leaf, body)) return this.answerExisting(m, leaf, body);
    }
    const checked = this.checkSync(m, t, req);
    if (isRejection(checked)) return fail(checked);
    if (leaf) return this.answerExisting(m, leaf, checked);
    const signer = receiptSigner(this.env);
    if (signer instanceof Error) {
      log.error('receipt_signer_unavailable', { roundId: req.roundId, error: signer.message });
      return fail(reject('unavailable', 'entries are temporarily unavailable'));
    }
    // Registered before the first await, so a close that starts later waits for this entry.
    const run = this.commit(m, req, checked, signer, t);
    this.inflight.set(req.userId, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(req.userId);
    }
  }

  /**
   * Counts one mirrored Stakes `Entered` event (the indexer's handler, src/lifecycle/handlers.ts).
   * Idempotent by (txHash, logIndex): a replay or a re-index answers `counted: false`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- RPC methods are async
  async ingestStakesEntry(evt: StakesEntryEvent): Promise<StakesIngestResult> {
    const m = this.meta;
    if (!m) throw new Error('not_found: the round is not initialized');
    const l = m.locked;
    if (evt.roundId !== l.roundId) throw new RangeError('ingestStakesEntry: another round');
    if (!l.modes.includes('stakes')) throw new RangeError('ingestStakesEntry: no Stakes mode');
    if (l.chainRoundId !== undefined && evt.chainRoundId !== l.chainRoundId) {
      throw new RangeError('ingestStakesEntry: the chain round ID does not match');
    }
    if (!/^[0-9]+$/.test(evt.stake)) throw new RangeError('ingestStakesEntry: stake is not a uint');
    const sql = this.ctx.storage.sql;
    const txHash = evt.txHash.toLowerCase();
    // No await between the check and the insert, so the pair is atomic in the DO.
    const seen =
      sql
        .exec(
          'SELECT 1 FROM stakes_entries WHERE tx_hash = ? AND log_index = ?',
          txHash,
          evt.logIndex,
        )
        .toArray().length > 0;
    if (!seen) {
      sql.exec(
        'INSERT INTO stakes_entries (tx_hash, log_index, player, user_id, stake, commitment, block_number, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        txHash,
        evt.logIndex,
        evt.player.toLowerCase(),
        evt.userId,
        evt.stake,
        evt.commitment.toLowerCase(),
        evt.blockNumber,
        evt.blockTimestampSec * 1000,
      );
      this.stakesCounts = {
        entrantCount: this.stakesCounts.entrantCount + 1,
        pool: this.stakesCounts.pool + BigInt(evt.stake),
      };
      this.broadcastCounts(m);
    }
    return {
      counted: !seen,
      entrantCount: this.stakesCounts.entrantCount,
      pool: this.stakesCounts.pool.toString(),
    };
  }

  /**
   * A mode's outcome, from the settlement coordinator (wave 5) or the indexer (a guardian void):
   * mirrors the mode's status and broadcasts `revealed` or `refunded`. A repeat is a no-op.
   */
  async onModeResult(mode: Mode, result: ModeResult): Promise<void> {
    const m = this.meta;
    if (!m) throw new Error('not_found: the round is not initialized');
    const l = m.locked;
    if (!l.modes.includes(mode)) throw new RangeError(`onModeResult: no ${mode} mode`);
    if (JSON.stringify(m.results[mode]) === JSON.stringify(result)) return;
    m.results[mode] = result;
    m.modeStatus[mode] = modeStatusOf(mode, result);
    await this.save();
    log.info('mode_result', { roundId: l.roundId, mode, outcome: result.outcome });
    if (result.outcome === 'revealed') {
      broadcast(this.env, l.roundId, {
        type: 'revealed',
        roundId: l.roundId,
        mode,
        winningOption: result.winningOption,
        tally: result.tally,
        ...(mode === 'stakes' && result.claimsOpenAt !== undefined
          ? { claimsOpenAt: result.claimsOpenAt }
          : {}),
      });
    } else {
      broadcast(this.env, l.roundId, {
        type: 'refunded',
        roundId: l.roundId,
        mode,
        refundReason: result.reason,
      });
    }
  }

  /**
   * Phase 1 of a void: entries stop now and the alarm pushes phase 2 (`voidRound`). Refused once
   * closesAt has passed. A repeat answers the first request.
   */
  async requestVoid(): Promise<VoidRequestResult> {
    const m = this.meta;
    if (!m) throw new Error('not_found: the round is not initialized');
    const l = m.locked;
    if (m.void) {
      return { accepted: m.void.state !== 'abandoned', stoppedAt: m.void.requestedAt };
    }
    const t = now(this.env);
    if (m.status === 'closed' || t >= l.closesAt) {
      return { accepted: false, stoppedAt: Math.min(t, l.closesAt) };
    }
    m.void = {
      requestedAt: t,
      state: 'requested',
      applied: false,
      txHash: null,
      retryAt: t,
      detail: null,
    };
    await this.save();
    log.warn('void_requested', { roundId: l.roundId, modes: l.modes });
    await this.schedule(m);
    return { accepted: true, stoppedAt: t };
  }

  override fetch(_request: Request): Response {
    return notImplementedResponse('RoundDO.fetch');
  }

  override async alarm(): Promise<void> {
    await this.advance();
  }

  // ---- Commit protocol ---------------------------------------------------------------------

  private checkSync(m: Meta, t: number, req: EnterFreeRequest): CheckedBody | EntryRejection {
    const l = m.locked;
    if (t < l.opensAt || m.status === 'scheduled') {
      return reject('round_not_open', 'the round is not open yet');
    }
    if (m.status === 'closed' || t >= l.closesAt) {
      return reject('round_closed', 'the round is closed');
    }
    if (voidPending(m)) return reject('round_closed', 'the round is being voided');
    if (m.modeStatus.free === 'voided') {
      return reject('mode_unavailable', 'Free mode is not available in this round');
    }
    return this.checkBody(m, req);
  }

  private checkBody(m: Meta, req: EnterFreeRequest): CheckedBody | EntryRejection {
    const l = m.locked;
    if (!l.modes.includes('free') || !l.config.free) {
      return reject('mode_unavailable', 'Free mode is not available in this round');
    }
    return checkEntryBody(req.body, {
      free: l.config.free,
      beaconRound: l.beaconRound,
      chain: this.chain(),
    });
  }

  private async commit(
    m: Meta,
    req: EnterFreeRequest,
    body: CheckedBody,
    signer: ReceiptSigner,
    t: number,
  ): Promise<RpcResult<EnterFreeResponse>> {
    const l = m.locked;
    const db = this.env.DB;
    const denied = await checkEligibility(db, { userId: req.userId, roomId: l.roomId, now: t });
    if (denied) return fail(denied);

    if (l.kind === 'daily') {
      try {
        await applyDailyGrant(db, { userId: req.userId, roundId: l.roundId, now: t });
      } catch (err) {
        log.warn('daily_grant_failed', { roundId: l.roundId, error: String(err) });
      }
    }

    const entryId = newUlid(t);
    const stake = Number(body.stake);
    const movement = stakeMovement(db, {
      userId: req.userId,
      scope: scopeForRound(l),
      amount: stake,
      roundId: l.roundId,
      now: t,
      entryInsert: entryInsert(db, {
        id: entryId,
        roundId: l.roundId,
        userId: req.userId,
        stake,
        ciphertext: body.ciphertext,
        commitment: body.commitment,
        now: t,
      }),
    });
    let entry: CommittedEntry;
    try {
      await this.beforeEntryBatch?.();
      const results = await db.batch([...movement.statements]);
      const row = results[2]?.results[0] as { receipt_seq?: unknown } | undefined;
      if (typeof row?.receipt_seq !== 'number') throw new Error('entry insert returned no seq');
      entry = {
        id: entryId,
        userId: req.userId,
        stake,
        commitment: body.commitment,
        seq: row.receipt_seq,
        createdAt: t,
      };
    } catch (err) {
      // A retried stake that already committed fails the balance CHECK before the unique keys, and
      // a commit whose reply was lost throws too: the user's entry decides the answer.
      const existing = await findFreeEntry(db, l.roundId, req.userId);
      if (existing) return this.answerExisting(m, this.recordLeaf(l.roundId, existing), body);
      if (isRoundSealedError(err)) return fail(reject('round_closed', 'the round is closed'));
      if (classifyPointsError(err) === 'insufficient_balance') {
        // The balance CHECK fails before the seal check, so a sealed round is asked directly.
        if (await this.sealedInD1(l.roundId)) {
          return fail(reject('round_closed', 'the round is closed'));
        }
        return fail(reject('insufficient_balance', 'not enough points for this stake'));
      }
      throw err;
    }
    const leaf = this.recordLeaf(l.roundId, entry);
    this.broadcastCounts(m);
    return ok(await this.response(m, leaf, signer));
  }

  private async sealedInD1(roundId: string): Promise<boolean> {
    const row = await this.env.DB.prepare('SELECT status FROM rounds WHERE id = ?1')
      .bind(roundId)
      .first<{ status: string }>();
    return row?.status === 'closed';
  }

  /** The answer for a user who already has a committed entry. */
  private async answerExisting(
    m: Meta,
    leaf: Leaf,
    body: CheckedBody,
  ): Promise<RpcResult<EnterFreeResponse>> {
    if (!sameEntry(leaf, body)) {
      return fail(reject('already_entered', 'you already entered Free mode in this round'));
    }
    const signer = receiptSigner(this.env);
    if (signer instanceof Error) return fail(reject('unavailable', 'receipts are unavailable'));
    return ok(await this.response(m, leaf, signer));
  }

  private async response(m: Meta, leaf: Leaf, signer: ReceiptSigner): Promise<EnterFreeResponse> {
    const l = m.locked;
    const receipt = await signer.sign({
      roundId: l.roundId,
      userId: leaf.userId,
      stake: BigInt(leaf.stake),
      commitment: leaf.commitment,
      seq: leaf.seq,
      closesAtSec: Math.floor(l.closesAt / 1000),
      beaconRound: l.beaconRound,
    });
    return {
      entry: {
        id: leaf.id,
        roundId: l.roundId,
        mode: 'free',
        stake: String(leaf.stake),
        commitment: leaf.commitment,
        createdAt: leaf.createdAt,
      },
      receipt,
    };
  }

  // ---- Leaves and counters -----------------------------------------------------------------

  private leafOf(userId: string): Leaf | null {
    const rows = this.ctx.storage.sql
      .exec<LeafRow>('SELECT * FROM leaves WHERE user_id = ?', userId)
      .toArray();
    return rows[0] ? toLeaf(rows[0]) : null;
  }

  private leaves(): Leaf[] {
    return this.ctx.storage.sql
      .exec<LeafRow>('SELECT * FROM leaves ORDER BY seq')
      .toArray()
      .map(toLeaf);
  }

  /** Records a committed entry's leaf (idempotent) and refreshes the counters. */
  private recordLeaf(roundId: string, e: CommittedEntry, recovered = false): Leaf {
    const leaf: Leaf = { ...e, userIdHash: receiptUserIdHash(roundId, e.userId) };
    this.ctx.storage.sql.exec(
      'INSERT INTO leaves (seq, entry_id, user_id, stake, commitment, user_id_hash, created_at, recovered) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      leaf.seq,
      leaf.id,
      leaf.userId,
      leaf.stake,
      leaf.commitment,
      leaf.userIdHash,
      leaf.createdAt,
      recovered ? 1 : 0,
    );
    this.recount();
    return leaf;
  }

  private recount(): void {
    const row = this.ctx.storage.sql
      .exec<{ n: number; pool: number | null }>(
        'SELECT COUNT(*) AS n, SUM(stake) AS pool FROM leaves',
      )
      .one();
    this.counts = { entrantCount: row.n, pool: BigInt(row.pool ?? 0) };
  }

  /** USDC base units are summed as bigints (the column is text). */
  private recountStakes(): void {
    let entrantCount = 0;
    let pool = 0n;
    for (const r of this.ctx.storage.sql.exec<{ stake: string }>(
      'SELECT stake FROM stakes_entries',
    )) {
      entrantCount += 1;
      pool += BigInt(r.stake);
    }
    this.stakesCounts = { entrantCount, pool };
  }

  private broadcastCounts(m: Meta): void {
    const l = m.locked;
    const modes: Partial<Record<Mode, { entrantCount: number; pool: string }>> = {};
    if (l.modes.includes('free')) {
      modes.free = { entrantCount: this.counts.entrantCount, pool: this.counts.pool.toString() };
    }
    if (l.modes.includes('stakes')) {
      modes.stakes = {
        entrantCount: this.stakesCounts.entrantCount,
        pool: this.stakesCounts.pool.toString(),
      };
    }
    broadcast(this.env, l.roundId, { type: 'counts', roundId: l.roundId, modes });
  }

  // ---- Alarm chain -------------------------------------------------------------------------

  /** Runs every due event in order, then sets the alarm for the next one. One pass at a time. */
  private advance(): Promise<void> {
    this.running ??= this.runDue().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runDue(): Promise<void> {
    const m = this.meta;
    if (!m) return;
    const t = now(this.env);
    await this.runVoid(m, t);
    for (const ev of roundEvents(m.locked)) {
      if (m.done.includes(ev.kind)) continue;
      if (ev.at > t || (m.retryAt[ev.kind] ?? 0) > t) break;
      try {
        await this.runEvent(m, ev, t);
        // A void applied during close has already marked every event done.
        if (!m.done.includes(ev.kind)) m.done.push(ev.kind);
        delete m.retryAt[ev.kind];
        delete m.attempts[ev.kind];
        await this.save();
      } catch (err) {
        // Later events wait: settlement must never be enqueued before the round has closed.
        await this.eventFailed(m, ev.kind, t, err);
        break;
      }
    }
    await this.retryCommit(m, now(this.env));
    await this.schedule(m);
  }

  /** Backs a failed event off, and alerts at most once per ALERT_THROTTLE_MS for it. */
  private async eventFailed(m: Meta, kind: RoundEventKind, t: number, err: unknown) {
    if (err instanceof RetryLater) {
      m.retryAt[kind] = t + err.afterMs;
      await this.save();
      log.info('round_event_waiting', { roundId: m.locked.roundId, step: kind, why: err.message });
      return;
    }
    const attempt = (m.attempts[kind] ?? 0) + 1;
    m.attempts[kind] = attempt;
    m.retryAt[kind] = t + eventRetryDelay(attempt);
    const last = m.alertedAt[kind];
    const alert = last === undefined || t - last >= ALERT_THROTTLE_MS;
    if (alert) m.alertedAt[kind] = t;
    await this.save();
    const error = err instanceof Error ? err.message : String(err);
    log.error('round_event_failed', { roundId: m.locked.roundId, step: kind, attempt, error });
    if (alert) {
      raiseAlert(this.env, 'ALERT_DO_ERROR', {
        roundId: m.locked.roundId,
        step: kind,
        attempt,
        error,
      });
    }
  }

  // ---- Void --------------------------------------------------------------------------------

  /** Before close: pushes a requested void; finishes the D1 side of a confirmed one. */
  private async runVoid(m: Meta, t: number): Promise<void> {
    const v = m.void;
    if (!v) return;
    if (v.state === 'requested' && t < m.locked.closesAt && v.retryAt <= t) {
      await this.pushVoid(m, t);
    }
    if (v.state === 'confirmed' && !v.applied && v.retryAt <= t) {
      try {
        await this.applyVoid(m, t);
      } catch (err) {
        // Backs off like the close event it stands in for.
        await this.eventFailed(m, 'close', t, err);
        v.retryAt = m.retryAt.close ?? t + EVENT_RETRY_MS;
        await this.save();
      }
    }
  }

  /** One push of `voidRound`. Never throws: a thrown error is a pending, indefinite step. */
  private async pushVoid(
    m: Meta,
    t: number,
    deps = this.operatorDeps ?? operatorDeps(this.env),
  ): Promise<VoidStep> {
    const v = m.void as VoidRecord;
    let step: VoidStep;
    try {
      step = await pushVoid(this.env, deps, m.locked);
    } catch (err) {
      step = { status: 'pending', txHash: v.txHash, detail: String(err), definite: false };
    }
    v.txHash = step.txHash ?? v.txHash;
    if (step.status === 'confirmed') {
      v.state = 'confirmed';
      v.detail = null;
      log.warn('void_confirmed', { roundId: m.locked.roundId, txHash: v.txHash });
    } else {
      v.detail = step.detail;
      v.retryAt = t + VOID_RETRY_MS;
      v.refusals = step.outcome === 'refused' ? (v.refusals ?? 0) + 1 : 0;
      log.info('void_pending', { roundId: m.locked.roundId, detail: step.detail });
      // V2: retrying can't confirm a reverted voidRound (final for its purpose), nor, most likely,
      // one refused again and again, and Free entries stay stopped until close: someone must know.
      // At close the void is resolved instead.
      const stuck =
        step.outcome === 'reverted' ||
        step.outcome === 'cancelled' ||
        (v.refusals ?? 0) >= VOID_REFUSED_ALERT_AFTER;
      if (stuck && !v.alerted && t < m.locked.closesAt) {
        v.alerted = true;
        raiseAlert(this.env, 'ALERT_DO_ERROR', {
          roundId: m.locked.roundId,
          step: 'void_cannot_confirm',
          outcome: step.outcome ?? null,
          detail: step.detail,
          txHash: v.txHash,
        });
      }
    }
    await this.save();
    return step;
  }

  /**
   * At close, a void that is still `requested` is decided: confirmed if `voidRound` is mined, else
   * abandoned only on proof (src/lifecycle/void.ts voidAbandonable): the head is read first, then a
   * final push must answer definitely. Without proof close waits and retries. An abandoned void's
   * `voidRound` is cancelled (T4; the scheduler tick finishes the cancellation).
   */
  private async resolveVoidAtClose(m: Meta, t: number): Promise<void> {
    const v = m.void as VoidRecord;
    const deps = this.operatorDeps ?? operatorDeps(this.env);
    let head: bigint | null = null;
    if (m.locked.modes.includes('stakes')) {
      try {
        head = await chainHeadPastClose(this.env, deps, m.locked);
      } catch (err) {
        log.warn('void_head_unreadable', { roundId: m.locked.roundId, error: String(err) });
      }
    }
    // The nonce is read at that head (W5-F1 C1): a node behind it can't answer "not mined".
    const step = await this.pushVoid(m, t, head === null ? deps : { ...deps, nonceBlock: head });
    if (step.status === 'confirmed') return;
    if (!voidAbandonable(this.env, m.locked, t, head !== null, step)) {
      throw new RetryLater(
        VOID_RETRY_MS,
        'the void is unresolved until the chain proves it missed',
      );
    }
    v.state = 'abandoned';
    await this.save();
    log.warn('void_abandoned', { roundId: m.locked.roundId, detail: v.detail });
    try {
      await cancelVoidRound(this.env, deps, m.locked.roundId);
    } catch (err) {
      log.warn('void_cancel_failed', { roundId: m.locked.roundId, error: String(err) });
    }
  }

  /** A confirmed void: drain entries, refund and void every mode in D1, end the alarm chain. */
  private async applyVoid(m: Meta, t: number): Promise<void> {
    const l = m.locked;
    const v = m.void as VoidRecord;
    if (m.status !== 'closed') {
      m.status = 'closed';
      await this.save();
    }
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
    await applyVoid(this.env, l, t);
    v.applied = true;
    for (const mode of l.modes) {
      if (!TERMINAL.includes(m.modeStatus[mode] ?? 'pending')) m.modeStatus[mode] = 'voided';
    }
    // Nothing is left to run: no close work, no settlement, no rule 8.
    m.done = roundEvents(l).map((e) => e.kind);
    m.retryAt = {};
    await this.save();
    for (const mode of l.modes) {
      broadcast(this.env, l.roundId, {
        type: 'refunded',
        roundId: l.roundId,
        mode,
        refundReason: VOID_REFUND_REASON,
      });
    }
    broadcast(this.env, l.roundId, {
      type: 'closed',
      roundId: l.roundId,
      closesAt: Math.floor(l.closesAt / 1000),
      beaconRound: l.beaconRound,
      beaconTime: l.beaconTimeSec,
    });
  }

  /**
   * A later init without a mode the DO has means D1 voided it since (the scheduler leaves voided
   * modes out). Anything else that differs is a conflict.
   */
  private async adoptVoidedModes(m: Meta, locked: LockedRound): Promise<void> {
    const known = m.locked;
    const fixed = (r: LockedRound) => JSON.stringify({ ...r, modes: [], chainRoundId: null });
    const subset = locked.modes.every((x) => known.modes.includes(x));
    const chainOk = locked.chainRoundId === undefined || locked.chainRoundId === known.chainRoundId;
    if (fixed(known) !== fixed(locked) || !subset || !chainOk) {
      throw new Error('conflict: the round is already initialized with a different config');
    }
    let changed = false;
    for (const mode of known.modes) {
      if (!locked.modes.includes(mode) && m.modeStatus[mode] !== 'voided') {
        m.modeStatus[mode] = 'voided';
        changed = true;
        log.warn('mode_voided_at_init', { roundId: known.roundId, mode });
      }
    }
    if (changed) await this.save();
  }

  private async runEvent(m: Meta, ev: RoundEvent, t: number): Promise<void> {
    const l = m.locked;
    switch (ev.kind) {
      case 'open':
        return this.open(m);
      case 'streak_at_risk':
      case 'closing_soon':
        // Pointless once due after close, or while the round is being voided.
        if (t < l.closesAt && !voidPending(m)) {
          await enqueueNotifications(this.env, ev.kind, this.hookRound(m));
        }
        return;
      case 'close':
        return this.close(m, t);
      case 'settle':
        for (const mode of l.modes) {
          if (m.modeStatus[mode] === 'voided') continue;
          await this.env.QUEUE_SETTLE.send({
            roundId: l.roundId,
            mode,
            idempotencyKey: settleKey(l.roundId, mode),
          });
        }
        log.info('settle_enqueued', {
          roundId: l.roundId,
          modes: l.modes.filter((x) => m.modeStatus[x] !== 'voided'),
        });
        return;
      case 'rule8':
        return this.rule8(m);
    }
  }

  private async open(m: Meta): Promise<void> {
    const l = m.locked;
    await this.env.DB.prepare(
      "UPDATE rounds SET status = 'open' WHERE id = ?1 AND status = 'scheduled'",
    )
      .bind(l.roundId)
      .run();
    m.status = 'open';
    await this.save();
    log.info('round_open', { roundId: l.roundId });
    if (!voidPending(m)) await enqueueNotifications(this.env, 'question_live', this.hookRound(m));
  }

  /**
   * Close: stop entries, drain in-flight ones, mark the round closed in D1 (no entry insert can
   * commit after this), then build the Free root from D1's committed entries and hand it to the
   * AnchorDO.
   */
  private async close(m: Meta, t: number): Promise<void> {
    const l = m.locked;
    if (m.void?.state === 'requested') await this.resolveVoidAtClose(m, t);
    if (m.void?.state === 'confirmed') {
      // Normally applied before close; a void confirmed in this last push is applied here.
      if (!m.void.applied) await this.applyVoid(m, t);
      return;
    }
    if (m.status !== 'closed') {
      m.status = 'closed';
      await this.save();
    }
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
    await this.env.DB.prepare("UPDATE rounds SET status = 'closed' WHERE id = ?1")
      .bind(l.roundId)
      .run();
    if (l.modes.includes('free') && m.modeStatus.free !== 'voided' && !m.freeClose) {
      m.freeClose = await this.buildFreeClose(m, t);
      await this.save();
      await this.submitCommit(m, t);
    }
    broadcast(this.env, l.roundId, {
      type: 'closed',
      roundId: l.roundId,
      closesAt: Math.floor(l.closesAt / 1000),
      beaconRound: l.beaconRound,
      beaconTime: l.beaconTimeSec,
    });
    log.info('round_closed', { roundId: l.roundId, entries: m.freeClose?.entryCount ?? 0 });
  }

  private async buildFreeClose(m: Meta, t: number): Promise<FreeCloseRecord> {
    const l = m.locked;
    const d1 = await listFreeEntries(this.env.DB, l.roundId);
    const r = reconcile(this.leaves(), d1);
    for (const e of r.recovered) this.recordLeaf(l.roundId, e, true);
    if (r.recovered.length > 0) {
      log.warn('leaves_recovered', { roundId: l.roundId, seqs: r.recovered.map((e) => e.seq) });
    }
    if (r.inconsistent.length > 0 || !r.contiguous) {
      raiseAlert(this.env, 'ALERT_DO_ERROR', {
        roundId: l.roundId,
        step: 'reconcile',
        inconsistentSeqs: r.inconsistent,
        contiguous: r.contiguous,
      });
    }
    // The root covers D1's committed set only (a leaf D1 lacks was never committed).
    const built = buildFreeRoot(
      l.roundId,
      r.committed.map((e) => ({ ...e, userIdHash: receiptUserIdHash(l.roundId, e.userId) })),
    );
    const deadline = Math.min(Math.floor(l.closesAt / 1000) + 90, l.beaconTimeSec - 30) * 1000;
    if (built) await this.storeRoot(l.roundId, built.root);
    return {
      root: built?.root ?? null,
      entryCount: built?.entryCount ?? 0,
      totalStake: (built?.totalStake ?? 0n).toString(),
      closedAt: t,
      anchor: built ? 'retrying' : 'none',
      deadline,
      nextAttemptAt: built ? t : null,
    };
  }

  /**
   * Writes the Free root to round_modes once. No row changed means the root is there already (a
   * retried close: fine if it is the same) or the row is missing or different, which alerts.
   */
  private async storeRoot(roundId: string, root: Hex): Promise<void> {
    const db = this.env.DB;
    const res = await db
      .prepare(
        "UPDATE round_modes SET commitment_root = ?1 WHERE round_id = ?2 AND mode = 'free' AND commitment_root IS NULL",
      )
      .bind(root, roundId)
      .run();
    if (res.meta.changes > 0) return;
    const row = await db
      .prepare("SELECT commitment_root FROM round_modes WHERE round_id = ?1 AND mode = 'free'")
      .bind(roundId)
      .first<{ commitment_root: string | null }>();
    if (row?.commitment_root === root) return;
    raiseAlert(this.env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'commitment_root',
      stored: row ? row.commitment_root : 'no free round_modes row',
      built: root,
    });
  }

  /** Hands the root to the AnchorDO; a failed hand-off is retried until the commit deadline. */
  private async submitCommit(m: Meta, t: number): Promise<void> {
    const c = m.freeClose;
    const l = m.locked;
    if (!c?.root || c.anchor !== 'retrying') return;
    if (t >= c.deadline) {
      c.anchor = 'late';
      c.nextAttemptAt = null;
      await this.save();
      raiseAlert(this.env, 'ALERT_COMMIT_LATE', { roundId: l.roundId, mode: 'free' });
      return;
    }
    const item: AnchorCommitItem = {
      roundKey: roundKey(l.roundId, 'free'),
      roundId: l.roundId,
      mode: 'free',
      root: c.root,
      entryCount: c.entryCount,
      totalStake: c.totalStake,
      closesAtSec: Math.floor(l.closesAt / 1000),
      beaconRound: l.beaconRound,
      beaconTimeSec: l.beaconTimeSec,
    };
    try {
      const anchor = this.env.ANCHOR.get(this.env.ANCHOR.idFromName(ANCHOR_SINGLETON));
      const ack = await anchor.submitCommit(item);
      c.anchor = ack.alreadyAnchored.includes(item.roundKey) ? 'already_anchored' : 'queued';
      c.nextAttemptAt = null;
    } catch (err) {
      if (isNotImplemented(err)) {
        // Until the AnchorDO lands (W4), the root stays recorded here and in round_modes.
        c.anchor = 'not_implemented';
        c.nextAttemptAt = null;
        log.warn('anchor_commit_not_implemented', { roundId: l.roundId });
      } else {
        c.nextAttemptAt = t + COMMIT_RETRY_MS;
        log.warn('anchor_commit_retry', { roundId: l.roundId, error: String(err) });
      }
    }
    await this.save();
  }

  private async retryCommit(m: Meta, t: number): Promise<void> {
    const c = m.freeClose;
    if (c?.anchor === 'retrying' && c.nextAttemptAt !== null && c.nextAttemptAt <= t) {
      await this.submitCommit(m, t);
    }
  }

  /** Beacon time + 24 h: if Free is still pending, enqueue the rule-8 job for the settle consumer. */
  private async rule8(m: Meta): Promise<void> {
    const l = m.locked;
    const row = await this.env.DB.prepare(
      "SELECT status FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(l.roundId)
      .first<{ status: ModeStatus }>();
    if (row?.status !== 'pending') return;
    await this.env.QUEUE_SETTLE.send({
      roundId: l.roundId,
      mode: 'free',
      idempotencyKey: rule8Key(l.roundId),
    });
    log.warn('rule8_enqueued', { roundId: l.roundId });
  }

  /**
   * Sets the alarm for the earliest pending event or commit retry. The delay is measured on the
   * game clock (`now`), so under a fixed test clock alarms do not fire on wall time.
   */
  private async schedule(m: Meta): Promise<void> {
    const t = now(this.env);
    const next = roundEvents(m.locked).find((e) => !m.done.includes(e.kind));
    const times = next ? [Math.max(next.at, m.retryAt[next.kind] ?? 0)] : [];
    if (m.freeClose?.anchor === 'retrying' && m.freeClose.nextAttemptAt !== null) {
      times.push(m.freeClose.nextAttemptAt);
    }
    const v = m.void;
    if (v?.state === 'requested' && t < m.locked.closesAt) times.push(Math.max(t, v.retryAt));
    if (v?.state === 'confirmed' && !v.applied) times.push(Math.max(t, v.retryAt));
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + Math.max(0, Math.min(...times) - t));
  }

  // ---- Helpers -----------------------------------------------------------------------------

  private chain(): DrandChain {
    return chainFromEnv({
      DRAND_CHAIN_HASH: this.env.DRAND_CHAIN_HASH,
      DRAND_PUBLIC_KEY: this.env.DRAND_PUBLIC_KEY,
      DRAND_GENESIS: this.env.DRAND_GENESIS,
      DRAND_PERIOD: this.env.DRAND_PERIOD,
    });
  }

  private hookRound(m: Meta): HookRound {
    const l = m.locked;
    return {
      roundId: l.roundId,
      kind: l.kind,
      roomId: l.roomId,
      opensAt: l.opensAt,
      closesAt: l.closesAt,
      modes: l.modes,
    };
  }

  private save(): Promise<void> {
    return this.ctx.storage.put('meta', this.meta);
  }
}

/** A void is requested and not yet abandoned: entries and notifications stop. */
function voidPending(m: Meta): boolean {
  return m.void !== null && m.void.state !== 'abandoned';
}

/** An identical retry: the same stake and the same commitment as the committed leaf. */
function sameEntry(leaf: Leaf, body: CheckedBody): boolean {
  return BigInt(leaf.stake) === body.stake && leaf.commitment === body.commitment;
}

/** The mode status a result moves the mode to (spec "Round lifecycle" mode rows). */
function modeStatusOf(mode: Mode, result: ModeResult): ModeStatus {
  if (result.outcome === 'revealed') return mode === 'stakes' ? 'settle_proposed' : 'settled';
  if (result.reason === VOID_REFUND_REASON) return 'voided';
  return mode === 'stakes' && result.provisional ? 'refund_proposed' : 'refunded';
}
