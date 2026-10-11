// The FlockedEscrow operator (spec "Smart contract" › FlockedEscrow; "Round lifecycle"). The only
// module that reads OPERATOR_KEY (wave-4 pinned interfaces). Each call is one at-most-once operator
// transaction keyed by a purpose (`createRound:<roundId>`, ...): the signed transaction is stored in
// `operator_txs` (migration 0005) before it is broadcast, and a later call with the same purpose
// polls, rebroadcasts or replaces that transaction instead of signing a new one. A call that would
// revert is refused before anything is signed (gas estimation simulates it).
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
import { NonceTooLowError, TxSender, type OnTxSent, type SentTx, type TxIntent } from './tx.js';

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
  /** Sent and not mined yet; call again with the same purpose. */
  | { status: 'pending'; txHash: Hex }
  /** Would revert (or no key/provider): nothing was signed. */
  | { status: 'refused'; error: string };

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
  status: 'pending' | 'mined' | 'reverted';
  tx_json: string;
  tx_hash: string | null;
}

const GAS_HEADROOM_PERCENT = 130n;
const POLL_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const lastHash = (tx: SentTx) => tx.hashes[tx.hashes.length - 1] as Hex;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
  if (op instanceof Error) return { status: 'refused', error: op.message };
  const db = env.DB;
  const t = () => clockNow(env);

  const row = await readRow(db, purpose);
  if (row && row.status !== 'pending') {
    const txHash = row.tx_hash as Hex;
    if (row.status === 'reverted') return { status: 'reverted', txHash };
    return {
      status: 'mined',
      txHash,
      receipt: await op.client.getTransactionReceipt({ hash: txHash }),
    };
  }

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
    tx = JSON.parse(row.tx_json) as SentTx;
  }

  const deadline = t() + (deps.waitMs ?? 20_000);
  for (;;) {
    const c = await op.sender.check(tx);
    if (c.status === 'mined') {
      const status = c.receipt.status === 'success' ? 'mined' : 'reverted';
      await db
        .prepare(
          "UPDATE operator_txs SET status = ?2, tx_hash = ?3, updated_at = ?4 WHERE purpose = ?1 AND status = 'pending'",
        )
        .bind(purpose, status, c.hash, t())
        .run();
      if (status === 'reverted') {
        log.error('operator_tx_reverted', { purpose, txHash: c.hash });
        return { status: 'reverted', txHash: c.hash };
      }
      return { status: 'mined', txHash: c.hash, receipt: c.receipt };
    }
    if (c.status === 'stuck' || c.status === 'nonce_consumed') {
      let next: SentTx;
      try {
        const intent = await intentFor(op, data);
        next =
          c.status === 'stuck'
            ? await op.sender.sign(intent, { replace: tx })
            : await op.sender.sign(intent, { nonce: await op.sender.nextNonce() });
      } catch (err) {
        // The call would revert now (e.g. opensAt passed); keep polling what was sent.
        log.warn('operator_tx_replace_refused', { purpose, error: message(err) });
        return { status: 'pending', txHash: lastHash(tx) };
      }
      const swapped = await db
        .prepare(
          "UPDATE operator_txs SET tx_json = ?2, updated_at = ?4 WHERE purpose = ?1 AND status = 'pending' AND tx_json = ?3",
        )
        .bind(purpose, JSON.stringify(next), JSON.stringify(tx), t())
        .run();
      if (swapped.meta.changes === 0) return runOperatorTx(env, deps, purpose, label, data);
      log.warn('operator_tx_replaced', { purpose, reason: c.status, nonce: next.nonce });
      tx = next;
      await broadcastQuietly(op, tx, label, purpose);
    }
    if (t() >= deadline) return { status: 'pending', txHash: lastHash(tx) };
    await sleep(POLL_MS);
  }
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
