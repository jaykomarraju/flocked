// Transaction sending for the server's keys (spec "Architecture": the AnchorDO signs, broadcasts and
// replaces stuck transactions; the operator key in src/chain/operator.ts does the same).
//
// One transaction per (key, nonce) is in flight at a time. The caller signs (`sign`), persists the
// signed `SentTx`, then broadcasts it (`broadcast`) and polls it (`check`) until it is mined. A stuck
// transaction is replaced at the same nonce with higher fees, so at most one of its versions can ever
// be mined; a replacement may carry different calldata (the AnchorDO rebuilds its batch). The sender
// keeps no state of its own: everything a retry needs is in the persisted `SentTx`.
import {
  BaseError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  keccak256,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';

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
  /** Every hash signed at this nonce, oldest first; the last one is `raw`'s. */
  hashes: Hex[];
  raw: Hex;
  data: Hex;
  /** Decimal strings (bigints don't survive JSON). */
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /** When the latest version was signed (epoch ms). */
  signedAt: number;
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
   * Called before each version is broadcast; a throw stops the broadcast. W4-D wires it to the
   * indexer's sent-transaction record, so every event the backend causes is known before it exists.
   */
  onTxSent?: OnTxSent;
  /** A version still unmined after this long is stuck and gets replaced (default 12 s, six Base blocks). */
  stuckAfterMs?: number;
  /** Fee bump for a replacement, in percent (default 25; nodes require at least 10). */
  bumpPercent?: number;
}

export type TxCheck =
  | { status: 'mined'; hash: Hex; receipt: TransactionReceipt }
  /** In flight and not stuck yet. */
  | { status: 'pending' }
  /** Unmined for `stuckAfterMs`: replace it (`sign` with `replace`) at the same nonce. */
  | { status: 'stuck' }
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

function errorText(err: unknown): string {
  if (err instanceof BaseError) return `${err.shortMessage} ${err.details}`.toLowerCase();
  return (err instanceof Error ? err.message : String(err)).toLowerCase();
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

export class TxSender {
  readonly address: Address;
  private readonly stuckAfterMs: number;
  private readonly bumpPercent: bigint;

  constructor(
    readonly client: PublicClient,
    private readonly account: LocalAccount,
    private readonly opts: TxSenderOptions,
  ) {
    this.address = account.address;
    this.stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
    this.bumpPercent = BigInt(opts.bumpPercent ?? DEFAULT_BUMP_PERCENT);
  }

  /** The next nonce for a new transaction (counting transactions already in the node's mempool). */
  nextNonce(): Promise<number> {
    return this.client.getTransactionCount({ address: this.address, blockTag: 'pending' });
  }

  /**
   * Signs `intent` at a new nonce, or as a replacement for `replace` (same nonce, every fee at least
   * `bumpPercent` higher than the previous version's and never below the current estimate). Does not
   * broadcast.
   */
  async sign(intent: TxIntent, at: { nonce: number } | { replace: SentTx }): Promise<SentTx> {
    const est = await this.client.estimateFeesPerGas();
    let maxFeePerGas = est.maxFeePerGas;
    let maxPriorityFeePerGas = est.maxPriorityFeePerGas;
    const previous = 'replace' in at ? at.replace : null;
    if (previous) {
      const bump = (x: string) => (BigInt(x) * (100n + this.bumpPercent)) / 100n + 1n;
      maxPriorityFeePerGas = maxBig(maxPriorityFeePerGas, bump(previous.maxPriorityFeePerGas));
      maxFeePerGas = maxBig(maxFeePerGas, bump(previous.maxFeePerGas));
    }
    maxFeePerGas = maxBig(maxFeePerGas, maxPriorityFeePerGas);
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
    return {
      from: this.address,
      to: intent.to,
      nonce,
      hashes: [...(previous?.hashes ?? []), keccak256(raw)],
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
    const hash = tx.hashes[tx.hashes.length - 1] as Hex;
    await this.opts.onTxSent?.({
      chainId: this.opts.chainId,
      hash,
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

  /**
   * Where `tx` stands. A latest version the node doesn't know (dropped, or a broadcast that never
   * arrived) is rebroadcast as it is; it becomes `stuck` once it is `stuckAfterMs` old.
   */
  async check(tx: SentTx): Promise<TxCheck> {
    const mined = await this.minedVersion(tx);
    if (mined) return { status: 'mined', ...mined };
    const latest = await this.client.getTransactionCount({
      address: this.address,
      blockTag: 'latest',
    });
    if (latest > tx.nonce) {
      // A version may have been mined between the receipt reads and the nonce read.
      const late = await this.minedVersion(tx);
      return late ? { status: 'mined', ...late } : { status: 'nonce_consumed' };
    }
    if (this.opts.now() - tx.signedAt >= this.stuckAfterMs) return { status: 'stuck' };
    const hash = tx.hashes[tx.hashes.length - 1] as Hex;
    const known = await this.client.getTransaction({ hash }).then(
      () => true,
      (err: unknown) => {
        if (err instanceof TransactionNotFoundError) return false;
        throw err;
      },
    );
    if (!known) await this.sendRaw(tx).catch(() => undefined);
    return { status: 'pending' };
  }
}
