// Transaction sending for the server's keys (spec "Architecture": the AnchorDO signs, broadcasts and
// replaces stuck transactions; the operator key in src/chain/operator.ts does the same).
//
// One transaction per (key, nonce) is in flight at a time. The caller signs (`sign`), persists the
// signed `SentTx`, then broadcasts it (`broadcast`) and polls it (`check`) until it is mined. A stuck
// transaction is replaced at the same nonce with higher fees, so at most one of its versions can ever
// be mined; a replacement may carry different calldata (the AnchorDO rebuilds its batch). The sender
// keeps no state of its own: everything a retry needs is in the persisted `SentTx`, and a `check`
// that learns something new hands back an updated one for the caller to persist.
//
// W4-F1 (wave-4 review):
//   - every broadcast, a rebroadcast by `check` included, calls `onTxSent` first (T1), so the indexer
//     knows every hash before it can be mined;
//   - a replacement bumps fees only from a version a node holds (T2): one no node accepted is
//     rebroadcast as it is, and re-signed only when the fee estimate has risen past it. Every fee is
//     capped (`maxFeePerGas`, from TX_MAX_FEE_GWEI), so versions are bounded, and receipts are read
//     only once the account's nonce shows something was mined at ours;
//   - a nonce taken by another transaction counts only when seen twice, at least one block apart
//     (T3): a provider whose receipts lag its state can't make a mined version look lost.
import {
  BaseError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  keccak256,
  parseGwei,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { log } from '../lib/log.js';

export interface TxIntent {
  to: Address;
  data: Hex;
  gas: bigint;
}

/** A signed transaction and every version sent at its nonce. JSON-safe: the caller persists it. */
export interface SentTx {
  from: Address;
  to: Address;
  nonce: number;
  /** Every hash signed at this nonce, oldest first; the last one is `raw`'s. At most MAX_VERSIONS. */
  hashes: Hex[];
  raw: Hex;
  data: Hex;
  /** Decimal strings (bigints don't survive JSON). */
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /** When the latest version was signed (epoch ms). */
  signedAt: number;
  /**
   * The head block number when another transaction was first seen using this nonce with none of
   * ours mined (T3). It is `nonce_consumed` only once seen again in a later block.
   */
  nonceTakenAt?: number;
}

/** EIP-1559 fees, in wei. */
export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** What `onTxSent` receives, once per version, before it is broadcast. */
export interface TxSentEvent {
  chainId: number;
  hash: Hex;
  from: Address;
  to: Address;
  nonce: number;
  /** What the transaction does, e.g. `anchor.commit` or `operator.createRound`. */
  label: string;
  /** Earlier versions at the same nonce that this one replaces. */
  replaces: Hex[];
}

export type OnTxSent = (e: TxSentEvent) => void | Promise<void>;

export interface TxSenderOptions {
  chainId: number;
  /** Epoch ms (the game clock, src/lib/clock.ts). */
  now: () => number;
  /**
   * Called before each version is broadcast, rebroadcasts included; a throw stops the broadcast.
   * W4-D wires it to the indexer's sent-transaction record, so every event the backend causes is
   * known before it exists.
   */
  onTxSent?: OnTxSent;
  /** A version still unmined after this long is stuck and gets replaced (default 12 s, six Base blocks). */
  stuckAfterMs?: number;
  /** Fee bump for a replacement, in percent (default 25; nodes require at least 10). */
  bumpPercent?: number;
  /** The highest `maxFeePerGas` ever signed, in wei (default DEFAULT_MAX_FEE_PER_GAS). */
  maxFeePerGas?: bigint;
}

export type TxCheck =
  | { status: 'mined'; hash: Hex; receipt: TransactionReceipt }
  /**
   * In flight and not stuck yet (or not replaceable: fees at the cap). `tx`, when present, is the
   * SentTx with what this check learned (T3's first sighting): the caller persists it.
   */
  | { status: 'pending'; tx?: SentTx; nonceTaken?: true }
  /**
   * Replace it (`sign` with `replace` and this `bumpFrom`) at the same nonce: a version a node holds
   * has been unmined for `stuckAfterMs` (bump from its fees), or no node holds any version and the
   * fee estimate has risen past the latest one (`bumpFrom` null: sign at the estimate).
   */
  | { status: 'stuck'; bumpFrom: Fees | null }
  /** Another transaction used the nonce, so none of ours can be mined: start over with a new nonce. */
  | { status: 'nonce_consumed' };

/** The node refused the nonce as already used. */
export class NonceTooLowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonceTooLowError';
  }
}

const DEFAULT_STUCK_AFTER_MS = 12_000;
const DEFAULT_BUMP_PERCENT = 25;
/**
 * The fee cap when TX_MAX_FEE_GWEI is unset: 5 gwei, hundreds of times Base's usual fee, so it only
 * stops runaway replacement (W13-D sets each environment's value).
 */
export const DEFAULT_MAX_FEE_PER_GAS = parseGwei('5');
/** Versions kept per nonce. A cap-bounded bump sequence never gets near it; past it, no replacement. */
export const MAX_VERSIONS = 32;
/** Versions asked about (newest first) when looking for the one a node holds. */
const HELD_LOOKUPS = 3;
/** A node accepts a replacement only at 10 % above the version it holds. */
const NODE_MIN_BUMP_PERCENT = 10n;

function errorText(err: unknown): string {
  if (err instanceof BaseError) return `${err.shortMessage} ${err.details}`.toLowerCase();
  return (err instanceof Error ? err.message : String(err)).toLowerCase();
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
const latestHash = (tx: SentTx) => tx.hashes[tx.hashes.length - 1] as Hex;
const feesOf = (tx: SentTx): Fees => ({
  maxFeePerGas: BigInt(tx.maxFeePerGas),
  maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
});

/** TX_MAX_FEE_GWEI (decimal gwei, e.g. "0.5") as wei; the default when unset. */
export function maxFeePerGasOf(env: object): bigint {
  // `Env.TX_MAX_FEE_GWEI`, read structurally so any env-shaped object will do.
  const raw = (env as { TX_MAX_FEE_GWEI?: string }).TX_MAX_FEE_GWEI;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return DEFAULT_MAX_FEE_PER_GAS;
  if (!/^[0-9]+(\.[0-9]{1,9})?$/.test(text) || parseGwei(text) === 0n) {
    throw new RangeError('TX_MAX_FEE_GWEI must be a positive number of gwei');
  }
  return parseGwei(text);
}

export class TxSender {
  readonly address: Address;
  private readonly stuckAfterMs: number;
  private readonly bumpPercent: bigint;
  private readonly maxFee: bigint;

  constructor(
    readonly client: PublicClient,
    private readonly account: LocalAccount,
    private readonly opts: TxSenderOptions,
  ) {
    this.address = account.address;
    this.stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
    this.bumpPercent = BigInt(opts.bumpPercent ?? DEFAULT_BUMP_PERCENT);
    this.maxFee = opts.maxFeePerGas ?? DEFAULT_MAX_FEE_PER_GAS;
  }

  /** The next nonce for a new transaction (counting transactions already in the node's mempool). */
  nextNonce(): Promise<number> {
    return this.client.getTransactionCount({ address: this.address, blockTag: 'pending' });
  }

  private bump(f: Fees): Fees {
    const up = (x: bigint) => (x * (100n + this.bumpPercent)) / 100n + 1n;
    return { maxFeePerGas: up(f.maxFeePerGas), maxPriorityFeePerGas: up(f.maxPriorityFeePerGas) };
  }

  /**
   * Signs `intent` at a new nonce, or as a replacement for `replace` at its nonce. A replacement
   * bumps every fee `bumpPercent` above `bumpFrom` (the version a node holds, from `check`), and
   * never goes below the current estimate; with `bumpFrom` null it signs at the estimate. Fees never
   * exceed the cap. Does not broadcast.
   */
  async sign(
    intent: TxIntent,
    at: { nonce: number } | { replace: SentTx; bumpFrom: Fees | null },
  ): Promise<SentTx> {
    const est = await this.client.estimateFeesPerGas();
    let maxFeePerGas = est.maxFeePerGas;
    let maxPriorityFeePerGas = est.maxPriorityFeePerGas;
    const previous = 'replace' in at ? at.replace : null;
    if (previous && 'bumpFrom' in at && at.bumpFrom) {
      const b = this.bump(at.bumpFrom);
      maxPriorityFeePerGas = maxBig(maxPriorityFeePerGas, b.maxPriorityFeePerGas);
      maxFeePerGas = maxBig(maxFeePerGas, b.maxFeePerGas);
    }
    maxFeePerGas = maxBig(maxFeePerGas, maxPriorityFeePerGas);
    if (maxFeePerGas > this.maxFee) {
      log.warn('tx_fee_capped', { from: this.address, wanted: maxFeePerGas, cap: this.maxFee });
      maxFeePerGas = this.maxFee;
    }
    maxPriorityFeePerGas = minBig(maxPriorityFeePerGas, maxFeePerGas);
    const nonce = previous ? previous.nonce : (at as { nonce: number }).nonce;
    const raw = await this.account.signTransaction({
      chainId: this.opts.chainId,
      type: 'eip1559',
      nonce,
      to: intent.to,
      data: intent.data,
      gas: intent.gas,
      value: 0n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const hash = keccak256(raw);
    const earlier = (previous?.hashes ?? []).filter((h) => h !== hash);
    return {
      from: this.address,
      to: intent.to,
      nonce,
      hashes: [...earlier, hash],
      raw,
      data: intent.data,
      gas: intent.gas.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      signedAt: this.opts.now(),
    };
  }

  /**
   * `onTxSent` for the latest version, then `eth_sendRawTransaction`. A node that already has the
   * transaction counts as sent. Throws `NonceTooLowError` when the nonce is used, or the RPC error.
   */
  async broadcast(tx: SentTx, label: string): Promise<void> {
    await this.opts.onTxSent?.({
      chainId: this.opts.chainId,
      hash: latestHash(tx),
      from: tx.from,
      to: tx.to,
      nonce: tx.nonce,
      label,
      replaces: tx.hashes.slice(0, -1),
    });
    await this.sendRaw(tx);
  }

  private async sendRaw(tx: SentTx): Promise<void> {
    try {
      await this.client.sendRawTransaction({ serializedTransaction: tx.raw });
    } catch (err) {
      const text = errorText(err);
      if (text.includes('already known') || text.includes('known transaction')) return;
      if (text.includes('nonce too low') || text.includes('nonce has already been used')) {
        throw new NonceTooLowError(text);
      }
      throw err;
    }
  }

  /** The receipt of any version of `tx`, or null. */
  private async minedVersion(
    tx: SentTx,
  ): Promise<{ hash: Hex; receipt: TransactionReceipt } | null> {
    for (const hash of [...tx.hashes].reverse()) {
      try {
        return { hash, receipt: await this.client.getTransactionReceipt({ hash }) };
      } catch (err) {
        if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
      }
    }
    return null;
  }

  /** The newest of `tx`'s versions the node holds, with its fees; null when it holds none. */
  async heldVersion(tx: SentTx): Promise<{ hash: Hex; fees: Fees } | null> {
    for (const hash of [...tx.hashes].reverse().slice(0, HELD_LOOKUPS)) {
      try {
        const t = await this.client.getTransaction({ hash });
        if (t.maxFeePerGas !== undefined && t.maxPriorityFeePerGas !== undefined) {
          return {
            hash,
            fees: { maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas },
          };
        }
        // No EIP-1559 fields: the latest version's fees are at least any earlier one's.
        return { hash, fees: feesOf(tx) };
      } catch (err) {
        if (!(err instanceof TransactionNotFoundError)) throw err;
      }
    }
    return null;
  }

  /** True when the cap leaves room to outbid `f` by the 10 % a node requires of a replacement. */
  canBump(f: Fees): boolean {
    return this.maxFee >= (f.maxFeePerGas * (100n + NODE_MIN_BUMP_PERCENT)) / 100n;
  }

  /**
   * Where `tx` stands. The account's nonce is read first, so receipts are read only once something
   * was mined at `tx.nonce`. A latest version no node holds (dropped, or a broadcast that never
   * arrived) is rebroadcast as it is, `onTxSent` first; a held one becomes `stuck` once it is
   * `stuckAfterMs` old. With `replaceNow` (a cancellation, T4), an unmined `tx` is `stuck` at once
   * and nothing is rebroadcast.
   */
  async check(tx: SentTx, label: string, opts: { replaceNow?: boolean } = {}): Promise<TxCheck> {
    const count = await this.client.getTransactionCount({
      address: this.address,
      blockTag: 'latest',
    });
    if (count > tx.nonce) {
      const mined = await this.minedVersion(tx);
      if (mined) return { status: 'mined', ...mined };
      // Taken, or mined with its receipt not served yet: believe it only on a later block too.
      const head = Number(await this.client.getBlockNumber({ cacheTime: 0 }));
      if (tx.nonceTakenAt === undefined) {
        return { status: 'pending', tx: { ...tx, nonceTakenAt: head }, nonceTaken: true };
      }
      if (head <= tx.nonceTakenAt) return { status: 'pending', nonceTaken: true };
      return { status: 'nonce_consumed' };
    }
    let next: SentTx | undefined;
    if (tx.nonceTakenAt !== undefined) {
      next = { ...tx };
      delete next.nonceTakenAt;
    }
    const pending = (): TxCheck => (next ? { status: 'pending', tx: next } : { status: 'pending' });
    const stale = opts.replaceNow === true || this.opts.now() - tx.signedAt >= this.stuckAfterMs;

    const held = await this.heldVersion(tx);
    if (opts.replaceNow) {
      if (held && !this.canBump(held.fees)) return pending();
      return { status: 'stuck', bumpFrom: held?.fees ?? null };
    }
    if (held?.hash !== latestHash(tx)) {
      // The latest version reached no node (a lost broadcast, or a crash before it): send it again.
      try {
        await this.broadcast(tx, label);
        return pending();
      } catch (err) {
        log.warn('tx_rebroadcast_failed', {
          from: this.address,
          txNonce: tx.nonce,
          error: errorText(err),
        });
      }
    }
    if (!stale) return pending();
    if (tx.hashes.length >= MAX_VERSIONS) {
      log.warn('tx_versions_exhausted', { from: this.address, txNonce: tx.nonce });
      return pending();
    }
    if (held) {
      if (this.canBump(held.fees)) return { status: 'stuck', bumpFrom: held.fees };
      log.warn('tx_fee_cap_reached', { from: this.address, txNonce: tx.nonce, cap: this.maxFee });
      return pending();
    }
    // No node holds any version: re-sign only if the market moved past the latest one's fees.
    const est = await this.client.estimateFeesPerGas();
    const floor = (BigInt(tx.maxFeePerGas) * (100n + NODE_MIN_BUMP_PERCENT)) / 100n;
    if (minBig(est.maxFeePerGas, this.maxFee) >= floor) return { status: 'stuck', bumpFrom: null };
    return pending();
  }
}
