// One sponsored user operation (spec "Smart contract" › Gas and UX): the smart wallet batches the
// calls into a single `wallet_sendCalls` (EIP-5792) with the app's ERC-7677 paymaster, and the
// screen shows pending until the batch is included. Entry sends approve (or permit) plus `enter`;
// "Claim all" sends every ready `claim` and `claimRefund` in one batch, so the daily sponsorship
// cap counts it once.
//
// Failures reach the screen as a `WalletError` with a line the player can act on: the paymaster
// refusing is not paid around, and a reverted batch is not retried behind their back.
import type { Config } from 'wagmi';
import { sendCalls, waitForCallsStatus } from 'wagmi/actions';
import type { Address, Hex } from 'viem';
import { paymasterCapability } from './paymaster';

/** One call in the batch. */
export interface WalletCall {
  to: Address;
  data: Hex;
}

/** Why a user operation did not go through, as the screen tells it. */
export type WalletErrorKind =
  | 'rejected'
  | 'not_sponsored'
  | 'reverted'
  | 'timeout'
  | 'unsupported'
  | 'failed';

export class WalletError extends Error {
  constructor(
    readonly kind: WalletErrorKind,
    override readonly cause?: unknown,
  ) {
    super(`wallet: ${kind}`);
    this.name = 'WalletError';
  }
}

/** How long to wait for the batch to be included before telling the player it is still out. */
export const INCLUSION_TIMEOUT_MS = 90_000;

const text = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/**
 * The kind of failure, from what the wallet threw. The wallet, the bundler and the paymaster all
 * surface as errors here, and only the message separates them, so the match is deliberately broad
 * and anything unrecognised stays `failed`.
 */
export function walletErrorKind(err: unknown): WalletErrorKind {
  if (err instanceof WalletError) return err.kind;
  const m = text(err).toLowerCase();
  if (/user rejected|user denied|rejected the request|4001/.test(m)) return 'rejected';
  if (/paymaster|sponsor|not eligible|rejected the operation/.test(m)) return 'not_sponsored';
  if (/revert|execution failed|aa2[0-9]|aa3[0-9]/.test(m)) return 'reverted';
  if (/timed out|timeout/.test(m)) return 'timeout';
  if (/method not (found|supported)|unsupported|does not support|4200/.test(m)) {
    return 'unsupported';
  }
  return 'failed';
}

export interface SendSponsoredOptions {
  account: Address;
  chainId: number;
  calls: readonly WalletCall[];
  /** The app origin the paymaster URL is built from (the specs point it at their own mock). */
  origin?: string;
  timeoutMs?: number;
}

/** The included batch: its id and the transaction hashes the player can look up. */
export interface SentCalls {
  id: string;
  txHashes: Hex[];
}

/**
 * Sends the calls as one sponsored user operation and waits for it to be included. Throws
 * `WalletError`; a batch that is accepted but reverts is `reverted`, not a silent success.
 */
export async function sendSponsoredCalls(
  config: Config,
  opts: SendSponsoredOptions,
): Promise<SentCalls> {
  let id: string;
  try {
    const sent = await sendCalls(config, {
      account: opts.account,
      chainId: opts.chainId as never,
      calls: opts.calls.map((c) => ({ to: c.to, data: c.data })),
      // One user operation, so the approve can never land without the entry behind it.
      forceAtomic: true,
      capabilities: paymasterCapability(opts.origin),
    });
    id = sent.id;
  } catch (err) {
    throw new WalletError(walletErrorKind(err), err);
  }

  let status: Awaited<ReturnType<typeof waitForCallsStatus>>;
  try {
    status = await waitForCallsStatus(config, {
      id,
      timeout: opts.timeoutMs ?? INCLUSION_TIMEOUT_MS,
    });
  } catch (err) {
    throw new WalletError(walletErrorKind(err) === 'failed' ? 'timeout' : walletErrorKind(err), err);
  }
  if (status.status !== 'success') throw new WalletError('reverted', status);
  return { id, txHashes: (status.receipts ?? []).map((r) => r.transactionHash) };
}
