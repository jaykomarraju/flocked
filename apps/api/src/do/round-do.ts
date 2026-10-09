// RoundDO: one per round (spec "Real-time and the reveal" › RoundDO responsibilities). W3-B: init,
// the Free commit protocol (enterFree), getState and the alarm chain with close and the commitment
// root. Still stubs: requestVoid and onModeResult (W4-D), ingestStakesEntry (W6-A), and the
// WebSocket hub in fetch (W7-A; `broadcast` in src/rounds/hooks.ts is its seam).
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
import { receiptSigner, receiptUserIdHash, type ReceiptSigner } from '../crypto/receipt.js';
import type { Env } from '../env.js';
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
import { notImplemented, notImplementedResponse } from './stub.js';
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

/** A failed alarm event is retried after this long (game clock). */
const EVENT_RETRY_MS = 10_000;
/** A failed commit hand-off to the AnchorDO is retried after this long, until its deadline. */
const COMMIT_RETRY_MS = 5_000;

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

interface Meta {
  locked: LockedRound;
  status: RoundStatus;
  modeStatus: Partial<Record<Mode, ModeStatus>>;
  done: RoundEventKind[];
  /** Per event kind: epoch ms (game clock) before which a failed event is not retried. */
  retryAt: Partial<Record<RoundEventKind, number>>;
  freeClose: FreeCloseRecord | null;
}

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
  private meta: Meta | null = null;
  private counts = { entrantCount: 0, pool: 0n };
  /** Entry requests between their first await and their answer, by user. */
  private readonly inflight = new Map<string, Promise<RpcResult<EnterFreeResponse>>>();
  /** The running alarm-chain pass, so init, a late entry and the alarm never overlap. */
  private running: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(LEAVES_DDL);
    void ctx.blockConcurrencyWhile(async () => {
      this.meta = (await ctx.storage.get<Meta>('meta')) ?? null;
      this.recount();
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
      if (JSON.stringify(this.meta.locked) !== JSON.stringify(locked)) {
        throw new Error('conflict: the round is already initialized with a different config');
      }
      return this.getState();
    }
    this.meta = {
      locked,
      status: 'scheduled',
      modeStatus: Object.fromEntries(locked.modes.map((m) => [m, 'pending'])),
      done: [],
      retryAt: {},
      freeClose: null,
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
      const free = mode === 'free';
      modes[mode] = {
        status: m.modeStatus[mode] ?? 'pending',
        entrantCount: free ? this.counts.entrantCount : 0,
        pool: free ? this.counts.pool.toString() : '0',
      };
    }
    return {
      roundId: l.roundId,
      status: m.status,
      voidRequested: false,
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
    const checked = this.checkSync(m, t, req);
    if (isRejection(checked)) return fail(checked);
    // The committed entry answers a retry, or refuses a second entry.
    const leaf = this.leafOf(req.userId);
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

  ingestStakesEntry(_evt: StakesEntryEvent): Promise<StakesIngestResult> {
    return notImplemented('RoundDO.ingestStakesEntry');
  }

  onModeResult(_mode: Mode, _result: ModeResult): Promise<void> {
    return notImplemented('RoundDO.onModeResult');
  }

  requestVoid(): Promise<VoidRequestResult> {
    return notImplemented('RoundDO.requestVoid');
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
      if (classifyPointsError(err) === 'insufficient_balance') {
        return fail(reject('insufficient_balance', 'not enough points for this stake'));
      }
      if (isRoundSealedError(err)) return fail(reject('round_closed', 'the round is closed'));
      throw err;
    }
    const leaf = this.recordLeaf(l.roundId, entry);
    broadcast(this.env, l.roundId, {
      type: 'counts',
      roundId: l.roundId,
      modes: {
        free: { entrantCount: this.counts.entrantCount, pool: this.counts.pool.toString() },
      },
    });
    return ok(await this.response(m, leaf, signer));
  }

  /** The answer for a user who already has a committed entry. */
  private async answerExisting(
    m: Meta,
    leaf: Leaf,
    body: CheckedBody,
  ): Promise<RpcResult<EnterFreeResponse>> {
    if (BigInt(leaf.stake) !== body.stake || leaf.commitment !== body.commitment) {
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
    for (const ev of roundEvents(m.locked)) {
      if (m.done.includes(ev.kind)) continue;
      if (ev.at > t || (m.retryAt[ev.kind] ?? 0) > t) break;
      try {
        await this.runEvent(m, ev, t);
        m.done.push(ev.kind);
        delete m.retryAt[ev.kind];
        await this.save();
      } catch (err) {
        // Later events wait: settlement must never be enqueued before the round has closed.
        m.retryAt[ev.kind] = t + EVENT_RETRY_MS;
        await this.save();
        raiseAlert(this.env, 'ALERT_DO_ERROR', {
          roundId: m.locked.roundId,
          event: ev.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
    await this.retryCommit(m, now(this.env));
    await this.schedule(m);
  }

  private async runEvent(m: Meta, ev: RoundEvent, t: number): Promise<void> {
    const l = m.locked;
    switch (ev.kind) {
      case 'open':
        return this.open(m);
      case 'streak_at_risk':
      case 'closing_soon':
        // A notification that is due only after close is pointless.
        if (t < l.closesAt) await enqueueNotifications(this.env, ev.kind, this.hookRound(m));
        return;
      case 'close':
        return this.close(m, t);
      case 'settle':
        for (const mode of l.modes) {
          await this.env.QUEUE_SETTLE.send({
            roundId: l.roundId,
            mode,
            idempotencyKey: settleKey(l.roundId, mode),
          });
        }
        log.info('settle_enqueued', { roundId: l.roundId, modes: l.modes });
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
    await enqueueNotifications(this.env, 'question_live', this.hookRound(m));
  }

  /**
   * Close: stop entries, drain in-flight ones, mark the round closed in D1 (no entry insert can
   * commit after this), then build the Free root from D1's committed entries and hand it to the
   * AnchorDO.
   */
  private async close(m: Meta, t: number): Promise<void> {
    const l = m.locked;
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
    if (l.modes.includes('free') && !m.freeClose) {
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
        event: 'reconcile',
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
    if (built) {
      await this.env.DB.prepare(
        "UPDATE round_modes SET commitment_root = ?1 WHERE round_id = ?2 AND mode = 'free' AND commitment_root IS NULL",
      )
        .bind(built.root, l.roundId)
        .run();
    }
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
