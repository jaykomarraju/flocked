// AnchorDO: the singleton that holds the anchor key and its nonce, and signs, broadcasts and replaces
// every FlockedAnchor transaction (spec "Architecture" AnchorDO; "Smart contract" › Contract:
// FlockedAnchor; "Sealed picks" › Free mode specifics). ANCHOR_KEY is read only here.
//
// Callers queue items (`submitLock`, `submitCommit`, `submitManifest`); the alarm does the chain work.
// One transaction is in flight at a time, so the nonce is the pending transaction's, or the account's
// next one when nothing is pending. Each run:
//   1. fails queued items whose deadline has passed and alerts (commit: ALERT_COMMIT_LATE);
//   2. polls the pending transaction: a mined one is applied from its receipt (`Locked`, `Committed`,
//      `ManifestAnchored` or `Skipped` per key); a stuck one is replaced at the same nonce with higher
//      fees and a rebuilt batch; one whose nonce was taken puts its items back in the queue;
//   3. with nothing pending, builds the next batch: commits first (earliest deadline, grouped by
//      `beaconRound`, the daily round's alone), then locks, then one manifest. Every key's onchain
//      state is read before a batch is built or rebuilt, so a key already written is settled without
//      a transaction and a key that can no longer be written fails early.
// Per-key deadlines (Unix seconds): lock closesAt − 30 s (the contract refuses at or after closesAt),
// commit min(closesAt + 90 s, beaconTime − 30 s), manifest none (due at beacon time). Every transaction
// version gets an `anchors` row in D1, and confirmations set `round_modes.lock_tx` / `commit_tx` (Free).
import { flockedAnchorAbi } from '@flocked/abi';
import { newUlid, roundKey as roundKeyOf } from '@flocked/shared';
import { DurableObject } from 'cloudflare:workers';
import {
  encodeFunctionData,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainIdOf, deploymentOf, publicClient } from '../chain/client.js';
import { TxSender, type OnTxSent, type SentTx } from '../chain/tx.js';
import type { Env } from '../env.js';
import { raiseAlert } from '../lib/alert.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';
import type {
  AnchorCommitItem,
  AnchorDORpc,
  AnchorItemState,
  AnchorItemStatus,
  AnchorKeyStatus,
  AnchorLockItem,
  AnchorManifestItem,
  AnchorSubmitAck,
} from './types.js';

/** The singleton's name: `env.ANCHOR.idFromName(ANCHOR_SINGLETON)`. */
export const ANCHOR_SINGLETON = 'anchor';

export type AnchorKind = 'lock' | 'commit' | 'manifest';

/** Gas per batch item (measured in W2-B) and per transaction; 25 % headroom on top. */
export const ANCHOR_GAS: Record<AnchorKind, bigint> = {
  lock: 75_000n,
  commit: 55_000n,
  manifest: 73_000n,
};
const TX_BASE_GAS = 30_000n;
/** Items per `lock` or `commit` transaction. */
export const MAX_BATCH = 20;
/** A lock leaf must land before closesAt; stop trying this long before it. */
export const LOCK_MARGIN_SEC = 30;
export const COMMIT_AFTER_CLOSE_SEC = 90;
export const COMMIT_BEFORE_BEACON_SEC = 30;
/** Poll interval while a transaction is pending. */
export const POLL_MS = 2_000;
const ERROR_RETRY_MS = 10_000;

/** FlockedAnchor `Skipped` reasons. */
export const SKIP_REASONS: Record<number, string> = {
  1: 'already_written',
  2: 'not_locked',
  3: 'outside_window',
  4: 'beacon_bounds',
};

/** A commit's deadline: min(closesAt + 90 s, beaconTime − 30 s), Unix seconds. */
export function commitDeadlineSec(i: { closesAtSec: number; beaconTimeSec: number }): number {
  return Math.min(
    i.closesAtSec + COMMIT_AFTER_CLOSE_SEC,
    i.beaconTimeSec - COMMIT_BEFORE_BEACON_SEC,
  );
}

type Item = AnchorLockItem | AnchorCommitItem | AnchorManifestItem;

interface ItemRow extends Record<string, SqlStorageValue> {
  round_key: string;
  kind: AnchorKind;
  round_id: string;
  item_json: string;
  state: AnchorItemState;
  /** When the contract first accepts it (Unix seconds). */
  due_sec: number;
  deadline_sec: number | null;
  beacon_round: number;
  /** A daily round's commit goes in a transaction of its own. */
  alone: number;
  tx_hash: string | null;
  confirmed_at: number | null;
  detail: string | null;
  alerted: number;
}

interface Pending {
  kind: AnchorKind;
  keys: Hex[];
  tx: SentTx;
}

/** FlockedAnchor's `RoundAnchor` (getAnchor). */
interface OnchainAnchor {
  closesAt: bigint;
  beaconRound: bigint;
  lockedAt: bigint;
  committedAt: bigint;
  questionHash: Hex;
  configHash: Hex;
  commitmentRoot: Hex;
  entryCount: number;
  totalStake: bigint;
  manifestAnchoredAt: bigint;
  manifestHash: Hex;
}

interface Chain {
  client: PublicClient;
  sender: TxSender;
  anchor: Address;
}

interface QueueEntry {
  item: Item;
  kind: AnchorKind;
  dueSec: number;
  deadlineSec: number | null;
  beaconRound: number;
  alone: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  round_key    TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  round_id     TEXT    NOT NULL,
  item_json    TEXT    NOT NULL,
  state        TEXT    NOT NULL,
  due_sec      INTEGER NOT NULL,
  deadline_sec INTEGER,
  beacon_round INTEGER NOT NULL,
  alone        INTEGER NOT NULL DEFAULT 0,
  tx_hash      TEXT,
  confirmed_at INTEGER,
  detail       TEXT,
  alerted      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (round_key, kind)
);
CREATE TABLE IF NOT EXISTS pending (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT    NOT NULL
);`;

const lower = (h: string) => h.toLowerCase() as Hex;
const lastHash = (tx: SentTx) => tx.hashes[tx.hashes.length - 1] as Hex;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class AnchorDO extends DurableObject<Env> implements AnchorDORpc {
  /** Tests point the DO at a fake RPC (set through `runInDurableObject`). Fields are not RPC methods. */
  transportOverride: Transport | undefined;
  /** Tests change the stuck threshold (default 12 s, src/chain/tx.ts). */
  stuckAfterMs: number | undefined;
  /** Called before every broadcast; W4-D wires it to the indexer's sent-transaction record. */
  onTxSent: OnTxSent | undefined;
  /** Tests run every alarm by hand (`runDurableObjectAlarm`): alarms are set an hour later. */
  manualAlarms = false;

  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  // ---- RPC ----------------------------------------------------------------------------------------

  submitLock(items: AnchorLockItem[]): Promise<AnchorSubmitAck> {
    return this.submit(
      items.map((item) => ({
        item,
        kind: 'lock' as const,
        dueSec: 0,
        deadlineSec: item.closesAtSec - LOCK_MARGIN_SEC,
        beaconRound: item.beaconRound,
        alone: false,
      })),
    );
  }

  async submitCommit(item: AnchorCommitItem): Promise<AnchorSubmitAck> {
    const round = await this.env.DB.prepare('SELECT kind FROM rounds WHERE id = ?1')
      .bind(item.roundId)
      .first<{ kind: string }>();
    return this.submit([
      {
        item,
        kind: 'commit',
        dueSec: item.closesAtSec,
        deadlineSec: commitDeadlineSec(item),
        beaconRound: item.beaconRound,
        alone: round?.kind === 'daily',
      },
    ]);
  }

  submitManifest(item: AnchorManifestItem): Promise<AnchorSubmitAck> {
    return this.submit([
      {
        item,
        kind: 'manifest',
        dueSec: item.beaconTimeSec,
        deadlineSec: null,
        beaconRound: 0,
        alone: true,
      },
    ]);
  }

  status(roundKey: Hex): Promise<AnchorKeyStatus> {
    const key = lower(roundKey);
    const of = (kind: AnchorKind): AnchorItemStatus => {
      const r = this.row(key, kind);
      if (!r) return { state: 'none' };
      const s: AnchorItemStatus = { state: r.state };
      if (r.tx_hash) s.txHash = r.tx_hash as Hex;
      if (kind === 'commit' && r.deadline_sec !== null) s.deadlineSec = r.deadline_sec;
      if (r.confirmed_at !== null) s.confirmedAt = r.confirmed_at;
      if (r.detail) s.detail = r.detail;
      return s;
    };
    return Promise.resolve({
      roundKey: key,
      lock: of('lock'),
      commit: of('commit'),
      manifest: of('manifest'),
    });
  }

  override async alarm(): Promise<void> {
    try {
      await this.process();
    } catch (err) {
      log.error('anchor_process_failed', { error: message(err) });
      raiseAlert(this.env, 'ALERT_DO_ERROR', { do: 'AnchorDO', error: message(err) });
      await this.wake(ERROR_RETRY_MS);
    }
  }

  // ---- Queue --------------------------------------------------------------------------------------

  private async submit(entries: QueueEntry[]): Promise<AnchorSubmitAck> {
    const ack: AnchorSubmitAck = { queued: [], alreadyAnchored: [] };
    const t = now(this.env);
    for (const e of entries) {
      const key = lower(e.item.roundKey);
      if (key !== lower(roundKeyOf(e.item.roundId, e.item.mode))) {
        log.error('anchor_bad_round_key', { roundId: e.item.roundId, kind: e.kind });
        continue;
      }
      const existing = this.row(key, e.kind);
      if (existing) {
        if (existing.state === 'confirmed') ack.alreadyAnchored.push(key);
        else if (existing.state === 'queued' || existing.state === 'sent') ack.queued.push(key);
        continue; // skipped and failed are final
      }
      const late = e.deadlineSec !== null && t >= e.deadlineSec * 1000;
      this.sql.exec(
        'INSERT INTO items (round_key, kind, round_id, item_json, state, due_sec, deadline_sec, beacon_round, alone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        key,
        e.kind,
        e.item.roundId,
        JSON.stringify(e.item),
        'queued',
        e.dueSec,
        e.deadlineSec,
        e.beaconRound,
        e.alone ? 1 : 0,
        t,
      );
      if (late) this.fail(key, e.kind, 'deadline_passed');
      else ack.queued.push(key);
    }
    if (ack.queued.length > 0) await this.wake(0);
    return ack;
  }

  private row(key: Hex, kind: AnchorKind): ItemRow | null {
    return (
      this.sql
        .exec<ItemRow>('SELECT * FROM items WHERE round_key = ? AND kind = ?', key, kind)
        .toArray()[0] ?? null
    );
  }

  /** A final failure (or `skipped`) of one item, with its alert, once. */
  private fail(key: Hex, kind: AnchorKind, detail: string, state: AnchorItemState = 'failed') {
    const r = this.row(key, kind);
    this.sql.exec(
      'UPDATE items SET state = ?, detail = ?, alerted = 1 WHERE round_key = ? AND kind = ?',
      state,
      detail,
      key,
      kind,
    );
    if (!r || r.alerted) return;
    const data = { roundId: r.round_id, roundKey: key, kind, detail };
    if (kind === 'commit') raiseAlert(this.env, 'ALERT_COMMIT_LATE', { ...data, mode: 'free' });
    else if (kind === 'lock') raiseAlert(this.env, 'ALERT_SCHEDULE_GAP', data);
    else raiseAlert(this.env, 'ALERT_DO_ERROR', { do: 'AnchorDO', ...data });
  }

  private backToQueue(key: Hex, kind: AnchorKind) {
    this.sql.exec(
      "UPDATE items SET state = 'queued', tx_hash = NULL WHERE round_key = ? AND kind = ? AND state = 'sent'",
      key,
      kind,
    );
  }

  private pending(): Pending | null {
    const r = this.sql.exec<{ json: string }>('SELECT json FROM pending WHERE id = 1').toArray()[0];
    return r ? (JSON.parse(r.json) as Pending) : null;
  }

  private setPending(p: Pending | null) {
    if (p === null) this.sql.exec('DELETE FROM pending WHERE id = 1');
    else
      this.sql.exec('INSERT OR REPLACE INTO pending (id, json) VALUES (1, ?)', JSON.stringify(p));
  }

  /** Sets the alarm `ms` of wall time from now, unless one is set sooner. */
  private async wake(ms: number): Promise<void> {
    const at = Date.now() + ms + (this.manualAlarms ? 3_600_000 : 0);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // ---- Processing ---------------------------------------------------------------------------------

  private chain(): Chain {
    if (!this.env.ANCHOR_KEY) throw new Error('ANCHOR_KEY is not set');
    const client = publicClient(this.env, this.transportOverride);
    const sender = new TxSender(client, privateKeyToAccount(this.env.ANCHOR_KEY as Hex), {
      chainId: chainIdOf(this.env),
      now: () => now(this.env),
      ...(this.onTxSent ? { onTxSent: this.onTxSent } : {}),
      ...(this.stuckAfterMs !== undefined ? { stuckAfterMs: this.stuckAfterMs } : {}),
    });
    return { client, sender, anchor: deploymentOf(this.env).anchor };
  }

  private async process(): Promise<void> {
    const tSec = Math.floor(now(this.env) / 1000);
    this.expire(tSec);

    const c = this.chain();
    const pending = this.pending();
    if (pending) {
      const check = await c.sender.check(pending.tx);
      if (check.status === 'pending') return this.wake(POLL_MS);
      if (check.status === 'mined') {
        await this.applyReceipt(c, pending, check.hash, check.receipt);
        this.setPending(null);
      } else if (check.status === 'nonce_consumed') {
        log.warn('anchor_nonce_consumed', { nonce: pending.tx.nonce, kind: pending.kind });
        for (const key of pending.keys) this.backToQueue(key, pending.kind);
        this.setPending(null);
      } else {
        // Stuck: rebuild the batch from the onchain state and replace it at the same nonce.
        for (const key of pending.keys) this.backToQueue(key, pending.kind);
        if (!(await this.buildAndSend(c, pending))) {
          // Nothing left to write: the same calldata with higher fees, so the nonce is not blocked.
          const tx = await c.sender.sign(
            { to: pending.tx.to, data: pending.tx.data, gas: BigInt(pending.tx.gas) },
            { replace: pending.tx },
          );
          await this.record(pending.kind, pending.keys, tx);
          this.setPending({ ...pending, tx });
          await this.broadcast(c, pending.kind, tx);
        }
        return this.wake(POLL_MS);
      }
    }

    if (await this.buildAndSend(c, null)) return this.wake(POLL_MS);
    const next = this.sql
      .exec<{ due: number | null }>("SELECT MIN(due_sec) AS due FROM items WHERE state = 'queued'")
      .toArray()[0]?.due;
    if (next !== null && next !== undefined) {
      await this.wake(Math.max(POLL_MS, (next - tSec) * 1000));
    }
  }

  /** Queued items past their deadline fail; sent ones alert once (a late confirmation still counts). */
  private expire(tSec: number) {
    const due = this.sql
      .exec<ItemRow>(
        "SELECT * FROM items WHERE state IN ('queued', 'sent') AND deadline_sec IS NOT NULL AND deadline_sec <= ? AND alerted = 0",
        tSec,
      )
      .toArray();
    for (const r of due) {
      const key = r.round_key as Hex;
      if (r.state === 'queued') {
        this.fail(key, r.kind, 'deadline_passed');
        continue;
      }
      this.sql.exec('UPDATE items SET alerted = 1 WHERE round_key = ? AND kind = ?', key, r.kind);
      const data = { roundId: r.round_id, roundKey: key, detail: 'unconfirmed_at_deadline' };
      if (r.kind === 'commit') {
        raiseAlert(this.env, 'ALERT_COMMIT_LATE', { ...data, mode: 'free', txHash: r.tx_hash });
      } else {
        raiseAlert(this.env, 'ALERT_SCHEDULE_GAP', { ...data, kind: r.kind, txHash: r.tx_hash });
      }
    }
  }

  /** The next batch, preferring `prefer`'s kind (a stuck transaction's). */
  private pickBatch(
    tSec: number,
    prefer: AnchorKind | null,
  ): { kind: AnchorKind; rows: ItemRow[] } | null {
    const kinds: AnchorKind[] = ['commit', 'lock', 'manifest'];
    const order = prefer ? [prefer, ...kinds.filter((k) => k !== prefer)] : kinds;
    for (const kind of order) {
      const rows = this.sql
        .exec<ItemRow>(
          "SELECT * FROM items WHERE kind = ? AND state = 'queued' AND due_sec <= ? ORDER BY deadline_sec IS NULL, deadline_sec, alone DESC, created_at, rowid",
          kind,
          tSec,
        )
        .toArray();
      const first = rows[0];
      if (!first) continue;
      if (kind === 'manifest' || (kind === 'commit' && first.alone)) return { kind, rows: [first] };
      if (kind === 'commit') {
        const group = rows.filter((r) => r.beacon_round === first.beacon_round && !r.alone);
        return { kind, rows: group.slice(0, MAX_BATCH) };
      }
      return { kind, rows: rows.slice(0, MAX_BATCH) };
    }
    return null;
  }

  /**
   * Builds the next batch from the onchain state and sends it (as a replacement for `replacing` when
   * given). Returns false when there is nothing to send.
   */
  private async buildAndSend(c: Chain, replacing: Pending | null): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const tSec = Math.floor(now(this.env) / 1000);
      const batch = this.pickBatch(tSec, replacing?.kind ?? null);
      if (!batch) return false;
      const rows = await this.checkOnchain(c, batch.kind, batch.rows);
      if (rows.length === 0) continue;
      const gas = ((TX_BASE_GAS + ANCHOR_GAS[batch.kind] * BigInt(rows.length)) * 125n) / 100n;
      const tx = await c.sender.sign(
        { to: c.anchor, data: this.calldata(batch.kind, rows), gas },
        replacing ? { replace: replacing.tx } : { nonce: await c.sender.nextNonce() },
      );
      const keys = rows.map((r) => r.round_key as Hex);
      await this.record(batch.kind, keys, tx);
      for (const key of keys) {
        this.sql.exec(
          "UPDATE items SET state = 'sent', tx_hash = ? WHERE round_key = ? AND kind = ?",
          lastHash(tx),
          key,
          batch.kind,
        );
      }
      this.setPending({ kind: batch.kind, keys, tx });
      await this.broadcast(c, batch.kind, tx);
      log.info('anchor_tx_sent', {
        kind: batch.kind,
        keys: keys.length,
        nonce: tx.nonce,
        replacement: replacing !== null,
      });
      return true;
    }
    return false;
  }

  /** One `anchors` row per transaction version (a replacement gets its own). */
  private async record(kind: AnchorKind, keys: Hex[], tx: SentTx): Promise<void> {
    const t = now(this.env);
    await this.env.DB.prepare(
      'INSERT INTO anchors (id, kind, round_keys_json, tx_hash, block_timestamp, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5) ON CONFLICT DO NOTHING',
    )
      .bind(newUlid(t), kind, JSON.stringify(keys), lastHash(tx), t)
      .run();
  }

  private async broadcast(c: Chain, kind: AnchorKind, tx: SentTx) {
    try {
      await c.sender.broadcast(tx, `anchor.${kind}`);
    } catch (err) {
      // The next poll rebroadcasts, replaces or re-signs it.
      log.warn('anchor_broadcast_failed', { kind, nonce: tx.nonce, error: message(err) });
    }
  }

  private calldata(kind: AnchorKind, rows: ItemRow[]): Hex {
    const items = rows.map((r) => JSON.parse(r.item_json) as Item);
    if (kind === 'lock') {
      const locks = items as AnchorLockItem[];
      return encodeFunctionData({
        abi: flockedAnchorAbi,
        functionName: 'lock',
        args: [
          locks.map((i) => i.roundKey),
          locks.map((i) => BigInt(i.closesAtSec)),
          locks.map((i) => BigInt(i.beaconRound)),
          locks.map((i) => i.questionHash),
          locks.map((i) => i.configHash),
        ],
      });
    }
    if (kind === 'commit') {
      const commits = items as AnchorCommitItem[];
      return encodeFunctionData({
        abi: flockedAnchorAbi,
        functionName: 'commit',
        args: [
          commits.map((i) => i.roundKey),
          commits.map((i) => i.root),
          commits.map((i) => i.entryCount),
          commits.map((i) => BigInt(i.totalStake)),
        ],
      });
    }
    const m = items[0] as AnchorManifestItem;
    return encodeFunctionData({
      abi: flockedAnchorAbi,
      functionName: 'anchorManifest',
      args: [m.roundKey, m.manifestHash],
    });
  }

  /**
   * Reads each key's onchain state and the chain's time. Keys already written are settled, keys that
   * can no longer be written fail, keys not writable yet stay queued; the rest are returned.
   */
  private async checkOnchain(c: Chain, kind: AnchorKind, rows: ItemRow[]): Promise<ItemRow[]> {
    const [block, states] = await Promise.all([
      c.client.getBlock({ blockTag: 'latest' }),
      Promise.all(
        rows.map((r) =>
          c.client.readContract({
            address: c.anchor,
            abi: flockedAnchorAbi,
            functionName: 'getAnchor',
            args: [r.round_key as Hex],
          }),
        ),
      ),
    ]);
    // The next block's time: the head's, or the game clock when the head is older (anvil mines no
    // empty blocks, so its head can be minutes behind). A commit sent too early is retried.
    const chainSec = Math.max(Number(block.timestamp), Math.floor(now(this.env) / 1000));
    const out: ItemRow[] = [];
    rows.forEach((r, i) => {
      const a = states[i] as OnchainAnchor;
      const key = r.round_key as Hex;
      if (kind === 'lock') {
        const l = JSON.parse(r.item_json) as AnchorLockItem;
        if (a.lockedAt !== 0n) return this.settleExisting(r, a.lockedAt, lockMatches(l, a));
        if (chainSec >= l.closesAtSec - LOCK_MARGIN_SEC)
          return this.fail(key, kind, 'outside_window');
      } else if (kind === 'commit') {
        const m = JSON.parse(r.item_json) as AnchorCommitItem;
        if (a.committedAt !== 0n) return this.settleExisting(r, a.committedAt, commitMatches(m, a));
        if (a.lockedAt === 0n) return this.fail(key, kind, 'not_locked');
        // Past its deadline only a version already sent is still tracked (expire() fails the rest);
        // at beacon time the contract refuses it.
        if (chainSec >= m.beaconTimeSec) return this.fail(key, kind, 'outside_window');
        if (chainSec < m.closesAtSec) return; // the chain's clock hasn't reached close yet
      } else {
        const m = JSON.parse(r.item_json) as AnchorManifestItem;
        if (a.manifestAnchoredAt !== 0n) {
          return this.settleExisting(
            r,
            a.manifestAnchoredAt,
            lower(a.manifestHash) === lower(m.manifestHash),
          );
        }
        if (a.lockedAt === 0n) return this.fail(key, kind, 'not_locked');
        if (chainSec < m.beaconTimeSec) return;
      }
      out.push(r);
    });
    return out;
  }

  /** A key already written onchain: confirmed if it holds our values, otherwise a mismatch. */
  private settleExisting(r: ItemRow, writtenAtSec: bigint, matches: boolean) {
    const key = r.round_key as Hex;
    if (!matches) {
      log.error('anchor_onchain_mismatch', { roundId: r.round_id, kind: r.kind });
      this.fail(key, r.kind, 'mismatch', 'skipped');
      return;
    }
    this.sql.exec(
      "UPDATE items SET state = 'confirmed', detail = 'already_written', confirmed_at = COALESCE(confirmed_at, ?) WHERE round_key = ? AND kind = ?",
      Number(writtenAtSec) * 1000,
      key,
      r.kind,
    );
  }

  /** Applies a mined batch: each key's `Locked` / `Committed` / `ManifestAnchored`, or `Skipped`. */
  private async applyReceipt(c: Chain, p: Pending, hash: Hex, receipt: TransactionReceipt) {
    const block = await c.client.getBlock({ blockNumber: receipt.blockNumber });
    const blockSec = Number(block.timestamp);
    await this.env.DB.prepare('UPDATE anchors SET block_timestamp = ?1 WHERE tx_hash = ?2')
      .bind(blockSec, hash)
      .run();
    if (receipt.status !== 'success') {
      log.error('anchor_tx_reverted', { kind: p.kind, txHash: hash });
      for (const key of p.keys) this.fail(key, p.kind, 'reverted');
      return;
    }
    const writtenEvent = { lock: 'Locked', commit: 'Committed', manifest: 'ManifestAnchored' }[
      p.kind
    ];
    const written = new Set<Hex>();
    const skipped = new Map<Hex, number>();
    for (const e of parseEventLogs({
      abi: flockedAnchorAbi,
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === c.anchor.toLowerCase()),
    })) {
      if (e.eventName === 'Skipped') skipped.set(lower(e.args.roundKey), e.args.reason);
      else if (e.eventName === writtenEvent) {
        written.add(lower((e.args as { roundKey: Hex }).roundKey));
      }
    }
    // The mined version may be an earlier one than `p` (a replacement raced it), so every key the
    // receipt names counts, not only `p.keys`.
    const confirmed: ItemRow[] = [];
    for (const key of new Set([...p.keys, ...written, ...skipped.keys()])) {
      const r = this.row(key, p.kind);
      if (!r || (r.state !== 'sent' && r.state !== 'queued')) continue;
      if (written.has(key)) {
        this.sql.exec(
          "UPDATE items SET state = 'confirmed', tx_hash = ?, confirmed_at = ?, detail = NULL WHERE round_key = ? AND kind = ?",
          hash,
          blockSec * 1000,
          key,
          p.kind,
        );
        confirmed.push({ ...r, tx_hash: hash });
      } else if (skipped.has(key)) {
        const reason = skipped.get(key) as number;
        log.warn('anchor_item_skipped', { roundId: r.round_id, kind: p.kind, reason });
        // Already written by someone else: the next build settles it against the onchain state. A
        // commit mined before close (the chain's clock behind ours) is simply early: retry it.
        const early =
          p.kind === 'commit' &&
          reason === 3 &&
          blockSec < (JSON.parse(r.item_json) as AnchorCommitItem).closesAtSec;
        if (reason === 1 || early) this.backToQueue(key, p.kind);
        else this.fail(key, p.kind, `skipped:${SKIP_REASONS[reason] ?? reason}`, 'skipped');
      } else {
        this.backToQueue(key, p.kind);
      }
    }
    await this.writeConfirmations(confirmed);
    log.info('anchor_tx_mined', {
      kind: p.kind,
      txHash: hash,
      written: written.size,
      skipped: skipped.size,
    });
  }

  /** Free lock and commit confirmations into `round_modes` (lock_tx, commit_tx). */
  private async writeConfirmations(rows: ItemRow[]): Promise<void> {
    const stmts = rows
      .filter((r) => r.kind !== 'manifest' && (JSON.parse(r.item_json) as Item).mode === 'free')
      .map((r) =>
        this.env.DB.prepare(
          r.kind === 'lock'
            ? "UPDATE round_modes SET lock_tx = ?1 WHERE round_id = ?2 AND mode = 'free' AND lock_tx IS NULL"
            : "UPDATE round_modes SET commit_tx = ?1 WHERE round_id = ?2 AND mode = 'free' AND commit_tx IS NULL",
        ).bind(r.tx_hash, r.round_id),
      );
    if (stmts.length > 0) await this.env.DB.batch(stmts);
  }
}

function lockMatches(l: AnchorLockItem, a: OnchainAnchor): boolean {
  return (
    a.closesAt === BigInt(l.closesAtSec) &&
    a.beaconRound === BigInt(l.beaconRound) &&
    lower(a.questionHash) === lower(l.questionHash) &&
    lower(a.configHash) === lower(l.configHash)
  );
}

function commitMatches(m: AnchorCommitItem, a: OnchainAnchor): boolean {
  return (
    lower(a.commitmentRoot) === lower(m.root) &&
    a.entryCount === m.entryCount &&
    a.totalStake === BigInt(m.totalStake)
  );
}
