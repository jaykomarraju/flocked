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
//
// W4-F1 (wave-4 review): the pending transaction keeps each version's kind and keys, so a receipt is
// applied to the version it belongs to (N1); a manifest that reverts in a block stamped before beacon
// time is retried. A key resubmitted after it was confirmed is checked onchain again and resent if its
// write is gone (a reorg; N2). Every confirmation records its transaction and its `round_modes` value
// (N3). A lock already sent stays in its replacement until closesAt, past its 30 s margin (N4).
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
import { ANCHOR_SINGLETON, chainIdOf, deploymentOf, publicClient } from '../chain/client.js';
import { TxSender, maxFeePerGasOf, type Fees, type OnTxSent, type SentTx } from '../chain/tx.js';
import { sentTxRecorder } from '../lifecycle/sent.js';
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

/** The singleton's name: `env.ANCHOR.idFromName(ANCHOR_SINGLETON)` (src/chain/client.ts). */
export { ANCHOR_SINGLETON };

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
/** A manifest that reverted before beacon time (the chain's clock behind ours) waits this long. */
const MANIFEST_RETRY_SEC = 6;

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

/** One signed version of the pending transaction: what it writes. */
interface Version {
  hash: Hex;
  kind: AnchorKind;
  keys: Hex[];
}

interface Pending {
  /** The latest version's kind and keys. */
  kind: AnchorKind;
  keys: Hex[];
  tx: SentTx;
  /** Every version by hash (N1); absent in rows written before W4-F1. */
  versions?: Version[];
}

/** Every version of `p` (a pre-W4-F1 row: each hash with the latest kind and keys). */
function versionsOf(p: Pending): Version[] {
  return p.versions ?? p.tx.hashes.map((hash) => ({ hash, kind: p.kind, keys: p.keys }));
}

/** `p` with `tx`'s latest version, writing `keys` of `kind`, added. */
function withVersion(p: Pending | null, kind: AnchorKind, keys: Hex[], tx: SentTx): Pending {
  const hash = tx.hashes[tx.hashes.length - 1] as Hex;
  const earlier = p ? versionsOf(p).filter((v) => v.hash !== hash) : [];
  return { kind, keys, tx, versions: [...earlier, { hash, kind, keys }] };
}

/** `kind:key` for every key any version of `p` carries. */
function inFlight(p: Pending | null): Set<string> {
  return new Set(p ? versionsOf(p).flatMap((v) => v.keys.map((k) => `${v.kind}:${k}`)) : []);
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
  /** Called before every broadcast: the indexer's sent-transaction record (tests may replace it). */
  onTxSent: OnTxSent | undefined;
  /** Tests run every alarm by hand (`runDurableObjectAlarm`): alarms are set an hour later. */
  manualAlarms = false;

  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    this.onTxSent = sentTxRecorder(env);
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
    const recheck: ItemRow[] = [];
    for (const e of entries) {
      const key = lower(e.item.roundKey);
      if (key !== lower(roundKeyOf(e.item.roundId, e.item.mode))) {
        log.error('anchor_bad_round_key', { roundId: e.item.roundId, kind: e.kind });
        continue;
      }
      const existing = this.row(key, e.kind);
      if (existing) {
        if (existing.state === 'confirmed') recheck.push(existing);
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
    if (recheck.length > 0) await this.recheckConfirmed(recheck, ack);
    if (ack.queued.length > 0) await this.wake(0);
    return ack;
  }

  /**
   * N2: callers resubmit a confirmed key only when its D1 record is missing, which is what the
   * indexer leaves when the write was reorged out. Each key is read onchain again: still written, it
   * stays confirmed (and its record is written again, N3); gone, it goes back to the queue, where the
   * alarm checks it once more and resends it. A failed read queues it for the alarm to decide.
   */
  private async recheckConfirmed(rows: ItemRow[], ack: AnchorSubmitAck): Promise<void> {
    let states: (OnchainAnchor | null)[];
    try {
      const c = this.reader();
      states = await Promise.all(rows.map((r) => this.readAnchor(c, r.round_key as Hex)));
    } catch (err) {
      log.warn('anchor_recheck_read_failed', { error: message(err) });
      states = rows.map(() => null);
    }
    const confirmed: ItemRow[] = [];
    rows.forEach((r, i) => {
      const a = states[i];
      const key = r.round_key as Hex;
      if (a && writtenAt(r.kind, a) !== 0n) {
        ack.alreadyAnchored.push(key);
        confirmed.push(r);
        return;
      }
      log.warn('anchor_write_missing', { roundId: r.round_id, kind: r.kind, read: a !== null });
      this.sql.exec(
        "UPDATE items SET state = 'queued', detail = 'recheck', confirmed_at = NULL, alerted = 0 WHERE round_key = ? AND kind = ? AND state = 'confirmed'",
        key,
        r.kind,
      );
      ack.queued.push(key);
    });
    await this.writeConfirmations(confirmed);
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

  private backToQueue(key: Hex, kind: AnchorKind, dueSec?: number) {
    this.sql.exec(
      "UPDATE items SET state = 'queued', tx_hash = NULL, due_sec = MAX(due_sec, ?) WHERE round_key = ? AND kind = ? AND state = 'sent'",
      dueSec ?? 0,
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
      maxFeePerGas: maxFeePerGasOf(this.env),
    });
    return { client, sender, anchor: deploymentOf(this.env).anchor };
  }

  /** Read-only chain access (no key needed). */
  private reader(): Pick<Chain, 'client' | 'anchor'> {
    return {
      client: publicClient(this.env, this.transportOverride),
      anchor: deploymentOf(this.env).anchor,
    };
  }

  private async readAnchor(c: Pick<Chain, 'client' | 'anchor'>, key: Hex): Promise<OnchainAnchor> {
    return c.client.readContract({
      address: c.anchor,
      abi: flockedAnchorAbi,
      functionName: 'getAnchor',
      args: [key],
    });
  }

  private async process(): Promise<void> {
    const tSec = Math.floor(now(this.env) / 1000);
    this.expire(tSec);

    const c = this.chain();
    const pending = this.pending();
    if (pending) {
      const check = await c.sender.check(pending.tx, `anchor.${pending.kind}`);
      if (check.status === 'pending') {
        if (check.tx) this.setPending({ ...pending, tx: check.tx });
        return this.wake(POLL_MS);
      }
      if (check.status === 'mined') {
        await this.applyReceipt(c, pending, check.hash, check.receipt);
        this.setPending(null);
      } else if (check.status === 'nonce_consumed') {
        log.warn('anchor_nonce_consumed', { txNonce: pending.tx.nonce, kind: pending.kind });
        for (const v of versionsOf(pending))
          for (const key of v.keys) this.backToQueue(key, v.kind);
        this.setPending(null);
      } else {
        // Stuck: rebuild the batch from the onchain state and replace it at the same nonce.
        for (const v of versionsOf(pending))
          for (const key of v.keys) this.backToQueue(key, v.kind);
        if (!(await this.buildAndSend(c, pending, check.bumpFrom))) {
          // Nothing left to write: the same calldata with higher fees, so the nonce is not blocked.
          const tx = await c.sender.sign(
            { to: pending.tx.to, data: pending.tx.data, gas: BigInt(pending.tx.gas) },
            { replace: pending.tx, bumpFrom: check.bumpFrom },
          );
          await this.record(pending.kind, pending.keys, tx);
          this.setPending(withVersion(pending, pending.kind, pending.keys, tx));
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

  /**
   * Queued items past their deadline fail; sent ones alert once (a late confirmation still counts),
   * and so do queued ones that a pending version still carries (N4) or that are being checked again
   * (N2): the alarm's onchain check decides those.
   */
  private expire(tSec: number) {
    const due = this.sql
      .exec<ItemRow>(
        "SELECT * FROM items WHERE state IN ('queued', 'sent') AND deadline_sec IS NOT NULL AND deadline_sec <= ? AND alerted = 0",
        tSec,
      )
      .toArray();
    const carried = inFlight(this.pending());
    for (const r of due) {
      const key = r.round_key as Hex;
      if (r.state === 'queued' && r.detail !== 'recheck' && !carried.has(`${r.kind}:${key}`)) {
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
  private async buildAndSend(
    c: Chain,
    replacing: Pending | null,
    bumpFrom: Fees | null = null,
  ): Promise<boolean> {
    const carried = inFlight(replacing);
    for (let attempt = 0; attempt < 5; attempt++) {
      const tSec = Math.floor(now(this.env) / 1000);
      const batch = this.pickBatch(tSec, replacing?.kind ?? null);
      if (!batch) return false;
      const rows = await this.checkOnchain(c, batch.kind, batch.rows, carried);
      if (rows.length === 0) continue;
      const gas = ((TX_BASE_GAS + ANCHOR_GAS[batch.kind] * BigInt(rows.length)) * 125n) / 100n;
      const tx = await c.sender.sign(
        { to: c.anchor, data: this.calldata(batch.kind, rows), gas },
        replacing ? { replace: replacing.tx, bumpFrom } : { nonce: await c.sender.nextNonce() },
      );
      const keys = rows.map((r) => r.round_key as Hex);
      await this.record(batch.kind, keys, tx);
      for (const key of keys) {
        this.sql.exec(
          "UPDATE items SET state = 'sent', tx_hash = ?, detail = NULL WHERE round_key = ? AND kind = ?",
          lastHash(tx),
          key,
          batch.kind,
        );
      }
      this.setPending(withVersion(replacing, batch.kind, keys, tx));
      await this.broadcast(c, batch.kind, tx);
      log.info('anchor_tx_sent', {
        kind: batch.kind,
        keys: keys.length,
        txNonce: tx.nonce,
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
      log.warn('anchor_broadcast_failed', { kind, txNonce: tx.nonce, error: message(err) });
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
   * `carried` holds the keys a version being replaced carries (`kind:key`).
   */
  private async checkOnchain(
    c: Chain,
    kind: AnchorKind,
    rows: ItemRow[],
    carried: Set<string>,
  ): Promise<ItemRow[]> {
    const [block, states] = await Promise.all([
      c.client.getBlock({ blockTag: 'latest' }),
      Promise.all(rows.map((r) => this.readAnchor(c, r.round_key as Hex))),
    ]);
    // The next block's time: the head's, or the game clock when the head is older (anvil mines no
    // empty blocks, so its head can be minutes behind). A commit sent too early is retried.
    const chainSec = Math.max(Number(block.timestamp), Math.floor(now(this.env) / 1000));
    const out: ItemRow[] = [];
    const settled: ItemRow[] = [];
    rows.forEach((r, i) => {
      const a = states[i] as OnchainAnchor;
      const key = r.round_key as Hex;
      const settle = (writtenAtSec: bigint, matches: boolean) => {
        if (this.settleExisting(r, writtenAtSec, matches)) settled.push(r);
      };
      if (kind === 'lock') {
        const l = JSON.parse(r.item_json) as AnchorLockItem;
        if (a.lockedAt !== 0n) return settle(a.lockedAt, lockMatches(l, a));
        // A new lock isn't started inside the last LOCK_MARGIN_SEC, but one already sent stays in
        // its replacement until closesAt, from which the contract refuses it (N4).
        if (chainSec >= l.closesAtSec) return this.fail(key, kind, 'outside_window');
        if (chainSec >= l.closesAtSec - LOCK_MARGIN_SEC && !carried.has(`${kind}:${key}`)) {
          return this.fail(key, kind, 'outside_window');
        }
      } else if (kind === 'commit') {
        const m = JSON.parse(r.item_json) as AnchorCommitItem;
        if (a.committedAt !== 0n) return settle(a.committedAt, commitMatches(m, a));
        if (a.lockedAt === 0n) return this.fail(key, kind, 'not_locked');
        // Past its deadline only a version already sent is still tracked (expire() fails the rest);
        // at beacon time the contract refuses it.
        if (chainSec >= m.beaconTimeSec) return this.fail(key, kind, 'outside_window');
        if (chainSec < m.closesAtSec) return; // the chain's clock hasn't reached close yet
      } else {
        const m = JSON.parse(r.item_json) as AnchorManifestItem;
        if (a.manifestAnchoredAt !== 0n) {
          return settle(a.manifestAnchoredAt, lower(a.manifestHash) === lower(m.manifestHash));
        }
        if (a.lockedAt === 0n) return this.fail(key, kind, 'not_locked');
        if (chainSec < m.beaconTimeSec) return;
      }
      out.push(r);
    });
    await this.writeConfirmations(await this.withTxHashes(c, settled));
    return out;
  }

  /**
   * A key already written onchain: confirmed if it holds our values (true), otherwise a mismatch.
   * The transaction is the item's own when it has one (N3); withTxHashes looks up the rest.
   */
  private settleExisting(r: ItemRow, writtenAtSec: bigint, matches: boolean): boolean {
    const key = r.round_key as Hex;
    if (!matches) {
      log.error('anchor_onchain_mismatch', { roundId: r.round_id, kind: r.kind });
      this.fail(key, r.kind, 'mismatch', 'skipped');
      return false;
    }
    this.sql.exec(
      "UPDATE items SET state = 'confirmed', detail = 'already_written', confirmed_at = COALESCE(confirmed_at, ?) WHERE round_key = ? AND kind = ?",
      Number(writtenAtSec) * 1000,
      key,
      r.kind,
    );
    return true;
  }

  /**
   * N3: the transaction that wrote each settled key, when the item doesn't know it: the indexer's
   * mirror of its `Locked` / `Committed` / `ManifestAnchored` event. Unknown ones stay without (the
   * indexer's handler records them in `round_modes` when it mirrors the event).
   */
  private async withTxHashes(c: Pick<Chain, 'anchor'>, rows: ItemRow[]): Promise<ItemRow[]> {
    const out: ItemRow[] = [];
    for (const r of rows) {
      let hash = r.tx_hash;
      if (!hash) {
        const ev = { lock: 'Locked', commit: 'Committed', manifest: 'ManifestAnchored' }[r.kind];
        const found = await this.env.DB.prepare(
          `SELECT tx_hash FROM chain_events WHERE chain_id = ?1 AND contract = ?2 AND event = ?3
             AND removed = 0 AND json_extract(args_json, '$.roundKey') = ?4
           ORDER BY block_number DESC LIMIT 1`,
        )
          .bind(chainIdOf(this.env), lower(c.anchor), ev, r.round_key)
          .first<{ tx_hash: string }>();
        hash = found?.tx_hash ?? null;
        if (hash) {
          this.sql.exec(
            'UPDATE items SET tx_hash = ? WHERE round_key = ? AND kind = ?',
            hash,
            r.round_key,
            r.kind,
          );
        }
      }
      if (hash) out.push({ ...r, tx_hash: hash });
    }
    return out;
  }

  /**
   * Applies a mined batch to the version it is for (N1): each key's `Locked` / `Committed` /
   * `ManifestAnchored`, or `Skipped`. Keys only the other versions carried go back to the queue.
   */
  private async applyReceipt(c: Chain, p: Pending, hash: Hex, receipt: TransactionReceipt) {
    const block = await c.client.getBlock({ blockNumber: receipt.blockNumber });
    const blockSec = Number(block.timestamp);
    await this.env.DB.prepare('UPDATE anchors SET block_timestamp = ?1 WHERE tx_hash = ?2')
      .bind(blockSec, hash)
      .run();
    const versions = versionsOf(p);
    const mined = versions.find((v) => v.hash === hash) ?? { hash, kind: p.kind, keys: p.keys };
    const kind = mined.kind;
    const requeueOthers = () => {
      for (const v of versions) {
        if (v.hash !== hash) for (const key of v.keys) this.backToQueue(key, v.kind);
      }
    };
    if (receipt.status !== 'success') {
      log.error('anchor_tx_reverted', { kind, txHash: hash });
      for (const key of mined.keys) {
        const r = this.row(key, kind);
        // anchorManifest reverts (BeaconNotReached) in a block stamped before beacon time: the
        // chain's clock was behind ours, so it is retried a little later.
        const early =
          kind === 'manifest' &&
          r !== null &&
          blockSec < (JSON.parse(r.item_json) as AnchorManifestItem).beaconTimeSec;
        if (early)
          this.backToQueue(key, kind, Math.floor(now(this.env) / 1000) + MANIFEST_RETRY_SEC);
        else this.fail(key, kind, 'reverted');
      }
      requeueOthers();
      return;
    }
    const writtenEvent = { lock: 'Locked', commit: 'Committed', manifest: 'ManifestAnchored' }[
      kind
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
    // The receipt's own events name its keys, besides the version's list.
    const confirmed: ItemRow[] = [];
    for (const key of new Set([...mined.keys, ...written, ...skipped.keys()])) {
      const r = this.row(key, kind);
      if (!r) continue;
      // Applied before, but its D1 record may not have been (a retried run): write it again (N3).
      if (r.state === 'confirmed' && r.tx_hash === hash) {
        confirmed.push(r);
        continue;
      }
      // A write that lands after its key failed (its window closed on our clock) still counts.
      const live = r.state === 'sent' || r.state === 'queued';
      if (!live && !(r.state === 'failed' && written.has(key))) continue;
      if (written.has(key)) {
        this.sql.exec(
          "UPDATE items SET state = 'confirmed', tx_hash = ?, confirmed_at = ?, detail = NULL WHERE round_key = ? AND kind = ?",
          hash,
          blockSec * 1000,
          key,
          kind,
        );
        confirmed.push({ ...r, tx_hash: hash });
      } else if (skipped.has(key)) {
        const reason = skipped.get(key) as number;
        log.warn('anchor_item_skipped', { roundId: r.round_id, kind, reason });
        // Already written by someone else: the next build settles it against the onchain state. A
        // commit mined before close (the chain's clock behind ours) is simply early: retry it.
        const early =
          kind === 'commit' &&
          reason === 3 &&
          blockSec < (JSON.parse(r.item_json) as AnchorCommitItem).closesAtSec;
        if (reason === 1 || early) this.backToQueue(key, kind);
        else this.fail(key, kind, `skipped:${SKIP_REASONS[reason] ?? reason}`, 'skipped');
      } else {
        this.backToQueue(key, kind);
      }
    }
    requeueOthers();
    await this.writeConfirmations(confirmed);
    log.info('anchor_tx_mined', {
      kind,
      txHash: hash,
      written: written.size,
      skipped: skipped.size,
    });
  }

  /**
   * Free confirmations into D1: lock and commit into `round_modes` (lock_tx, commit_tx), and a
   * manifest into its settlement record (`settlements.tx_hash`, W5-D), when the record is that bundle.
   */
  private async writeConfirmations(rows: ItemRow[]): Promise<void> {
    const stmts = rows
      .filter((r) => (JSON.parse(r.item_json) as Item).mode === 'free')
      .map((r) => {
        if (r.kind === 'manifest') {
          const m = JSON.parse(r.item_json) as AnchorManifestItem;
          return this.env.DB.prepare(
            `UPDATE settlements SET tx_hash = ?1 WHERE round_id = ?2 AND mode = 'free'
               AND superseded_at IS NULL AND bundle_hash = ?3 AND tx_hash IS NULL`,
          ).bind(r.tx_hash, r.round_id, lower(m.manifestHash));
        }
        return this.env.DB.prepare(
          r.kind === 'lock'
            ? "UPDATE round_modes SET lock_tx = ?1 WHERE round_id = ?2 AND mode = 'free' AND lock_tx IS NULL"
            : "UPDATE round_modes SET commit_tx = ?1 WHERE round_id = ?2 AND mode = 'free' AND commit_tx IS NULL",
        ).bind(r.tx_hash, r.round_id);
      });
    if (stmts.length > 0) await this.env.DB.batch(stmts);
  }
}

/** When the key's `kind` was written onchain (Unix seconds), 0 when it wasn't. */
function writtenAt(kind: AnchorKind, a: OnchainAnchor): bigint {
  return kind === 'lock' ? a.lockedAt : kind === 'commit' ? a.committedAt : a.manifestAnchoredAt;
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
