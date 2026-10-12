// The FlockedEscrow operator (spec "Smart contract" › FlockedEscrow; "Round lifecycle"). The only
// module that reads OPERATOR_KEY (wave-4 pinned interfaces). Each call is one at-most-once operator
// transaction keyed by a purpose (`createRound:<roundId>`, ...): the signed transaction is stored in
// `operator_txs` (migration 0005) before it is broadcast, and a later call with the same purpose
// polls, rebroadcasts or replaces that transaction instead of signing a new one. A call that would
// revert is refused before anything is signed (gas estimation simulates it).
//
// An abandoned purpose (a `createRound` still pending at opensAt, a `voidRound` abandoned at close)
// is cancelled (W4-F1 T4): its pending transaction is replaced by a 0-value send to the operator
// itself at the same nonce, so it can neither land late nor hold up the shared nonce. The scheduler
// tick drives every cancellation until it is mined (`driveCancellations`).
import { flockedEscrowAbi } from '@flocked/abi';
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
import type { Env } from '../env.js';
import { now as clockNow } from '../lib/clock.js';
import { log } from '../lib/log.js';
import { chainIdOf, deploymentOf, publicClient } from './client.js';
import {
  NonceTooLowError,
  TxSender,
  maxFeePerGasOf,
  type OnTxSent,
  type SentTx,
  type TxIntent,
} from './tx.js';

export type OperatorEnv = Pick<
  Env,
  | 'DB'
  | 'CHAIN_ID'
  | 'BASE_RPC_URL'
  | 'BASE_RPC_URL_FALLBACK'
  | 'LOCAL_DEPLOYMENT'
  | 'OPERATOR_KEY'
  | 'ENVIRONMENT'
  | 'FLOCKED_TEST_CLOCK'
>;

export interface OperatorDeps {
  /** A fake RPC in tests; the env's providers otherwise. */
  transport?: Transport;
  onTxSent?: OnTxSent;
  /** How long one call waits for the receipt before answering `pending` (default 20 s). */
  waitMs?: number;
  stuckAfterMs?: number;
}

export type OperatorTxResult =
  | { status: 'mined'; txHash: Hex; receipt: TransactionReceipt }
  | { status: 'reverted'; txHash: Hex }
  /**
   * Sent and not mined yet; call again with the same purpose. `nonceTaken`: another transaction
   * seems to have used its nonce, not yet confirmed (T3), so a version may still turn out mined.
   */
  | { status: 'pending'; txHash: Hex; nonceTaken?: true }
  /** Would revert (or no key/provider): nothing was signed. */
  | { status: 'refused'; error: string }
  /** Abandoned and cancelled (T4): none of its versions was mined, or its cancellation is pending. */
  | { status: 'cancelled'; txHash: Hex };

/** `RoundConfig` (spec "Smart contract"): times in Unix seconds, money in USDC base units. */
export interface EscrowRoundConfig {
  opensAt: number;
  closesAt: number;
  beaconRound: number;
  stake: bigint;
  feeBps: number;
  creatorBps: number;
  capMultiple: number;
  minEntrants: number;
  creator: Address;
  questionHash: Hex;
}

interface OperatorTxRow {
  status: 'pending' | 'mined' | 'reverted' | 'cancelled';
  tx_json: string;
  tx_hash: string | null;
}

const GAS_HEADROOM_PERCENT = 130n;
const POLL_MS = 1_000;
/** A plain transfer's gas: the cancellation (T4). */
const CANCEL_GAS = 21_000n;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const lastHash = (tx: SentTx) => tx.hashes[tx.hashes.length - 1] as Hex;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** `operator_txs.tx_json`: the SentTx, marked once its purpose is abandoned (T4). */
type StoredTx = SentTx & { abandoned?: true };
/** A 0-value send to the operator itself: the version that cancels an abandoned purpose (T4). */
const isCancel = (tx: SentTx) => tx.to.toLowerCase() === tx.from.toLowerCase();
const isAbandoned = (tx: StoredTx) => tx.abandoned === true || isCancel(tx);
/** `createRound:<id>` → `operator.createRound`, the label its versions are recorded under. */
const labelOf = (purpose: string) => `operator.${purpose.slice(0, purpose.indexOf(':'))}`;

interface Operator {
  client: PublicClient;
  sender: TxSender;
  escrow: Address;
}

function operator(env: OperatorEnv, deps: OperatorDeps): Operator | Error {
  if (!env.OPERATOR_KEY) return new Error('OPERATOR_KEY is not set');
  try {
    const client = publicClient(env, deps.transport);
    const account = privateKeyToAccount(env.OPERATOR_KEY as Hex);
    const sender = new TxSender(client, account, {
      chainId: chainIdOf(env),
      now: () => clockNow(env),
      ...(deps.onTxSent ? { onTxSent: deps.onTxSent } : {}),
      ...(deps.stuckAfterMs !== undefined ? { stuckAfterMs: deps.stuckAfterMs } : {}),
      maxFeePerGas: maxFeePerGasOf(env),
    });
    return { client, sender, escrow: deploymentOf(env).escrow };
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Calldata plus a gas limit from estimation, which also simulates the call (a revert throws). */
async function intentFor(op: Operator, data: Hex): Promise<TxIntent> {
  const gas = await op.client.estimateGas({ account: op.sender.address, to: op.escrow, data });
  return { to: op.escrow, data, gas: (gas * GAS_HEADROOM_PERCENT) / 100n };
}

async function readRow(db: D1Database, purpose: string): Promise<OperatorTxRow | null> {
  return db
    .prepare('SELECT status, tx_json, tx_hash FROM operator_txs WHERE purpose = ?1')
    .bind(purpose)
    .first<OperatorTxRow>();
}

/** The result a finished row stands for. */
async function finalResult(op: Operator, row: OperatorTxRow): Promise<OperatorTxResult> {
  const txHash = row.tx_hash as Hex;
  if (row.status === 'reverted') return { status: 'reverted', txHash };
  if (row.status === 'cancelled') return { status: 'cancelled', txHash };
  return {
    status: 'mined',
    txHash,
    receipt: await op.client.getTransactionReceipt({ hash: txHash }),
  };
}

/** Moves a pending row from `from` to `to`; false when another run changed it first. */
async function swapTx(db: D1Database, purpose: string, from: SentTx, to: SentTx, t: number) {
  const r = await db
    .prepare(
      "UPDATE operator_txs SET tx_json = ?2, updated_at = ?4 WHERE purpose = ?1 AND status = 'pending' AND tx_json = ?3",
    )
    .bind(purpose, JSON.stringify(to), JSON.stringify(from), t)
    .run();
  return r.meta.changes > 0;
}

async function finish(
  db: D1Database,
  purpose: string,
  status: Exclude<OperatorTxRow['status'], 'pending'>,
  txHash: Hex,
  t: number,
) {
  await db
    .prepare(
      "UPDATE operator_txs SET status = ?2, tx_hash = ?3, updated_at = ?4 WHERE purpose = ?1 AND status = 'pending'",
    )
    .bind(purpose, status, txHash, t)
    .run();
}

/**
 * Runs the purpose's transaction one step further: sign and broadcast it the first time, then poll it
 * for up to `waitMs`, replacing it when it is stuck and re-signing it when its nonce was taken.
 */
async function runOperatorTx(
  env: OperatorEnv,
  deps: OperatorDeps,
  purpose: string,
  label: string,
  data: Hex,
): Promise<OperatorTxResult> {
  const op = operator(env, deps);
  if (op instanceof Error) {
    // Already sent (W5-F1 C3): only the chain can say whether it was mined, so this is no answer.
    if (await readRow(env.DB, purpose)) throw op;
    return { status: 'refused', error: op.message };
  }
  const db = env.DB;
  const t = () => clockNow(env);

  const row = await readRow(db, purpose);
  if (row && row.status !== 'pending') return finalResult(op, row);

  let tx: SentTx;
  if (!row) {
    let intent: TxIntent;
    try {
      intent = await intentFor(op, data);
    } catch (err) {
      return { status: 'refused', error: message(err) };
    }
    tx = await op.sender.sign(intent, { nonce: await op.sender.nextNonce() });
    const claimed = await db
      .prepare(
        "INSERT INTO operator_txs (purpose, status, tx_json, tx_hash, created_at, updated_at) VALUES (?1, 'pending', ?2, NULL, ?3, ?3) ON CONFLICT DO NOTHING",
      )
      .bind(purpose, JSON.stringify(tx), t())
      .run();
    // Another run signed first: follow its transaction instead.
    if (claimed.meta.changes === 0) return runOperatorTx(env, deps, purpose, label, data);
    await broadcastQuietly(op, tx, label, purpose);
  } else {
    tx = JSON.parse(row.tx_json) as StoredTx;
    // Abandoned: cancelOperatorTx owns it now, and nothing may re-sign the call.
    if (isAbandoned(tx)) return { status: 'cancelled', txHash: lastHash(tx) };
  }

  const deadline = t() + (deps.waitMs ?? 20_000);
  for (;;) {
    const c = await op.sender.check(tx, label);
    if (c.status === 'mined') {
      const status = c.receipt.status === 'success' ? 'mined' : 'reverted';
      await finish(db, purpose, status, c.hash, t());
      if (status === 'reverted') {
        log.error('operator_tx_reverted', { purpose, txHash: c.hash });
        return { status: 'reverted', txHash: c.hash };
      }
      return { status: 'mined', txHash: c.hash, receipt: c.receipt };
    }
    let nonceTaken = false;
    if (c.status === 'pending') {
      nonceTaken = c.nonceTaken === true;
      if (c.tx) {
        if (!(await swapTx(db, purpose, tx, c.tx, t()))) {
          return runOperatorTx(env, deps, purpose, label, data);
        }
        tx = c.tx;
      }
    } else {
      let next: SentTx;
      try {
        const intent = await intentFor(op, data);
        next =
          c.status === 'stuck'
            ? await op.sender.sign(intent, { replace: tx, bumpFrom: c.bumpFrom })
            : await op.sender.sign(intent, { nonce: await op.sender.nextNonce() });
      } catch (err) {
        // The call would revert now (e.g. opensAt passed); keep polling what was sent.
        log.warn('operator_tx_replace_refused', { purpose, error: message(err) });
        return { status: 'pending', txHash: lastHash(tx) };
      }
      if (!(await swapTx(db, purpose, tx, next, t()))) {
        return runOperatorTx(env, deps, purpose, label, data);
      }
      log.warn('operator_tx_replaced', { purpose, reason: c.status, txNonce: next.nonce });
      tx = next;
      await broadcastQuietly(op, tx, label, purpose);
    }
    if (t() >= deadline) {
      return { status: 'pending', txHash: lastHash(tx), ...(nonceTaken ? { nonceTaken } : {}) };
    }
    await sleep(POLL_MS);
  }
}

/**
 * T4: one step of cancelling `purpose`'s pending transaction. The first step marks the purpose
 * abandoned and replaces its transaction at once with a 0-value send to the operator itself (fees
 * bumped from the version a node holds; at the fee cap it waits for a later step); later steps poll
 * that cancellation, replacing it when it is stuck. Finished: `cancelled` once the cancellation is
 * mined or the nonce went to another transaction, or `mined` / `reverted` if the abandoned call
 * landed first. Null when the purpose never sent anything.
 */
export async function cancelOperatorTx(
  env: OperatorEnv,
  deps: OperatorDeps,
  purpose: string,
): Promise<OperatorTxResult | null> {
  const op = operator(env, deps);
  if (op instanceof Error) return { status: 'refused', error: op.message };
  const db = env.DB;
  const t = () => clockNow(env);
  const row = await readRow(db, purpose);
  if (!row) return null;
  if (row.status !== 'pending') return finalResult(op, row);
  const label = labelOf(purpose);
  let tx = JSON.parse(row.tx_json) as StoredTx;
  if (!isAbandoned(tx)) {
    // Marked first, so the sweep keeps at it even when no replacement can go out yet.
    const marked: StoredTx = { ...tx, abandoned: true };
    if (!(await swapTx(db, purpose, tx, marked, t()))) return cancelOperatorTx(env, deps, purpose);
    tx = marked;
  }
  const first = !isCancel(tx);
  const c = await op.sender.check(tx, label, first ? { replaceNow: true } : {});
  if (c.status === 'mined') {
    const cancelled = (c.receipt.to ?? '').toLowerCase() === tx.from.toLowerCase();
    const status = cancelled ? 'cancelled' : c.receipt.status === 'success' ? 'mined' : 'reverted';
    await finish(db, purpose, status, c.hash, t());
    if (status === 'mined') log.error('operator_cancel_lost', { purpose, txHash: c.hash });
    else log.warn('operator_tx_cancelled', { purpose, status, txHash: c.hash });
    return finalResult(op, { status, tx_json: row.tx_json, tx_hash: c.hash });
  }
  if (c.status === 'nonce_consumed') {
    // None of its versions was mined, and none can be now.
    await finish(db, purpose, 'cancelled', lastHash(tx), t());
    log.warn('operator_tx_cancelled', { purpose, status: 'nonce_consumed' });
    return { status: 'cancelled', txHash: lastHash(tx) };
  }
  if (c.status === 'pending') {
    if (c.tx) await swapTx(db, purpose, tx, c.tx, t());
    return { status: 'pending', txHash: lastHash(tx) };
  }
  const next = await op.sender.sign(
    { to: op.sender.address, data: '0x', gas: CANCEL_GAS },
    { replace: tx, bumpFrom: c.bumpFrom },
  );
  if (!(await swapTx(db, purpose, tx, next, t()))) return cancelOperatorTx(env, deps, purpose);
  log.warn(first ? 'operator_tx_cancelling' : 'operator_cancel_replaced', {
    purpose,
    txNonce: next.nonce,
  });
  await broadcastQuietly(op, next, label, purpose);
  return { status: 'pending', txHash: lastHash(next) };
}

/** The scheduler tick's sweep: one more step for every cancellation still pending (T4). */
export async function driveCancellations(
  env: OperatorEnv,
  deps: OperatorDeps,
): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT purpose FROM operator_txs WHERE status = 'pending'
       AND (json_extract(tx_json, '$.abandoned') = 1
            OR lower(json_extract(tx_json, '$.to')) = lower(json_extract(tx_json, '$.from')))
     ORDER BY created_at`,
  ).all<{ purpose: string }>();
  const out: Record<string, string> = {};
  for (const { purpose } of results) {
    try {
      out[purpose] = (await cancelOperatorTx(env, deps, purpose))?.status ?? 'none';
    } catch (err) {
      log.error('operator_cancel_failed', { purpose, error: message(err) });
      out[purpose] = 'error';
    }
  }
  return out;
}

/** Broadcast failures are left to the next `check` (it rebroadcasts, replaces or re-signs). */
async function broadcastQuietly(op: Operator, tx: SentTx, label: string, purpose: string) {
  try {
    await op.sender.broadcast(tx, label);
  } catch (err) {
    log.warn(
      err instanceof NonceTooLowError ? 'operator_nonce_taken' : 'operator_broadcast_failed',
      {
        purpose,
        error: message(err),
      },
    );
  }
}

/** The FlockedEscrow round ID from a mined `createRound` receipt's `RoundCreated` event. */
export function chainRoundIdFromReceipt(receipt: TransactionReceipt, escrow: Address): string {
  const events = parseEventLogs({
    abi: flockedEscrowAbi,
    eventName: 'RoundCreated',
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === escrow.toLowerCase()),
  });
  if (events.length !== 1) {
    throw new Error(`createRound receipt has ${events.length} RoundCreated events, expected 1`);
  }
  return (events[0] as (typeof events)[number]).args.roundId.toString();
}

/**
 * `createRound` at question lock for the D1 round `roundId` (once per round). A mined result carries
 * `chainRoundId`, read from the receipt's `RoundCreated` event.
 */
export async function createRound(
  env: OperatorEnv,
  deps: OperatorDeps,
  i: { roundId: string; cfg: EscrowRoundConfig },
): Promise<OperatorTxResult & { chainRoundId?: string }> {
  const c = i.cfg;
  const data = encodeFunctionData({
    abi: flockedEscrowAbi,
    functionName: 'createRound',
    args: [
      {
        opensAt: BigInt(c.opensAt),
        closesAt: BigInt(c.closesAt),
        beaconRound: BigInt(c.beaconRound),
        stake: c.stake,
        feeBps: c.feeBps,
        creatorBps: c.creatorBps,
        capMultiple: c.capMultiple,
        minEntrants: c.minEntrants,
        creator: c.creator,
        questionHash: c.questionHash,
      },
    ],
  });
  const r = await runOperatorTx(
    env,
    deps,
    `createRound:${i.roundId}`,
    'operator.createRound',
    data,
  );
  if (r.status !== 'mined') return r;
  return { ...r, chainRoundId: chainRoundIdFromReceipt(r.receipt, deploymentOf(env).escrow) };
}

/** `voidRound` (the two-phase void's onchain half; W4-D). Once per D1 round. */
export function voidRound(
  env: OperatorEnv,
  deps: OperatorDeps,
  i: { roundId: string; chainRoundId: string },
): Promise<OperatorTxResult> {
  const data = encodeFunctionData({
    abi: flockedEscrowAbi,
    functionName: 'voidRound',
    args: [BigInt(i.chainRoundId)],
  });
  return runOperatorTx(env, deps, `voidRound:${i.roundId}`, 'operator.voidRound', data);
}

/** T4: cancels the round's `createRound`, still pending when the contract stopped accepting it. */
export function cancelCreateRound(env: OperatorEnv, deps: OperatorDeps, roundId: string) {
  return cancelOperatorTx(env, deps, `createRound:${roundId}`);
}

/** T4: cancels the round's `voidRound` once its void was abandoned at close. */
export function cancelVoidRound(env: OperatorEnv, deps: OperatorDeps, roundId: string) {
  return cancelOperatorTx(env, deps, `voidRound:${roundId}`);
}

/** `propose` (Stakes settlement, wave 5). `attempt` numbers re-proposals after a veto. */
export function propose(
  env: OperatorEnv,
  deps: OperatorDeps,
  i: {
    roundId: string;
    chainRoundId: string;
    attempt: number;
    n0: number;
    n1: number;
    nVoid: number;
    payoutRoot: Hex;
    bundleHash: Hex;
  },
): Promise<OperatorTxResult> {
  const data = encodeFunctionData({
    abi: flockedEscrowAbi,
    functionName: 'propose',
    args: [BigInt(i.chainRoundId), i.n0, i.n1, i.nVoid, i.payoutRoot, i.bundleHash],
  });
  return runOperatorTx(env, deps, `propose:${i.roundId}:${i.attempt}`, 'operator.propose', data);
}

/** `finalize` once `claimsOpenAt` has passed (the indexer calls it). Once per D1 round. */
export function finalize(
  env: OperatorEnv,
  deps: OperatorDeps,
  i: { roundId: string; chainRoundId: string },
): Promise<OperatorTxResult> {
  const data = encodeFunctionData({
    abi: flockedEscrowAbi,
    functionName: 'finalize',
    args: [BigInt(i.chainRoundId)],
  });
  return runOperatorTx(env, deps, `finalize:${i.roundId}`, 'operator.finalize', data);
}
