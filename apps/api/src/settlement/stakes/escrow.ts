// FlockedEscrow reads for Stakes settlement: the round's onchain state (`getRound`, at a block when
// asked), its `Entered` logs over a block range, and one public client per RPC provider, so the
// entry set can be read again from the second provider when the first disagrees with the contract.
import { flockedEscrowAbi } from '@flocked/abi';
import {
  getAbiItem,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import { deploymentOf, publicClient, rpcTransport, type ChainEnv } from '../../chain/client.js';

/** FlockedEscrow `Status`. */
export const ESCROW_STATUS = {
  None: 0,
  Open: 1,
  SettleProposed: 2,
  RefundProposed: 3,
  Settled: 4,
  Refunded: 5,
} as const;

export type EscrowStatusName = keyof typeof ESCROW_STATUS;

const STATUS_NAMES = Object.keys(ESCROW_STATUS) as EscrowStatusName[];

export function statusName(status: number): EscrowStatusName {
  const name = STATUS_NAMES[status];
  if (name === undefined) throw new RangeError(`unknown FlockedEscrow status ${status}`);
  return name;
}

/** The parts of FlockedEscrow's `Round` that settlement reads. */
export interface EscrowRound {
  status: EscrowStatusName;
  refundReason: number;
  stake: bigint;
  minEntrants: number;
  closesAt: number;
  entryCount: number;
  roundBalance: bigint;
  /** Unix seconds; 0 when nothing is proposed. */
  claimsOpenAt: number;
  winPayout: bigint;
  rebatePayout: bigint;
  fee: bigint;
  creatorFee: bigint;
  dust: bigint;
  payoutRoot: Hex;
  bundleHash: Hex;
}

export type Provider = 'primary' | 'fallback';

export interface EscrowDeps {
  /** Tests: a fake RPC per provider. */
  transports?: Partial<Record<Provider, Transport>>;
}

/**
 * The client for one provider: `primary` is the env's transport (BASE_RPC_URL, failing over to
 * BASE_RPC_URL_FALLBACK on errors), `fallback` the second provider alone. Null when the fallback
 * isn't configured.
 */
export function providerClient(
  env: ChainEnv,
  provider: Provider,
  deps: EscrowDeps = {},
): PublicClient | null {
  const given = deps.transports?.[provider];
  if (given) return publicClient(env, given);
  if (provider === 'primary') return publicClient(env, rpcTransport(env));
  if (!env.BASE_RPC_URL_FALLBACK) return null;
  return publicClient(env, http(env.BASE_RPC_URL_FALLBACK, { retryCount: 1, timeout: 10_000 }));
}

export function escrowOf(env: ChainEnv): Address {
  return deploymentOf(env).escrow;
}

/** `getRound(chainRoundId)`, at `blockNumber` when given (the latest block otherwise). */
export async function readEscrowRound(
  client: PublicClient,
  escrow: Address,
  chainRoundId: string,
  blockNumber?: number,
): Promise<EscrowRound> {
  const r = await client.readContract({
    address: escrow,
    abi: flockedEscrowAbi,
    functionName: 'getRound',
    args: [BigInt(chainRoundId)],
    ...(blockNumber === undefined ? {} : { blockNumber: BigInt(blockNumber) }),
  });
  return {
    status: statusName(r.status),
    refundReason: r.refundReason,
    stake: r.cfg.stake,
    minEntrants: r.cfg.minEntrants,
    closesAt: Number(r.cfg.closesAt),
    entryCount: r.entryCount,
    roundBalance: r.roundBalance,
    claimsOpenAt: Number(r.claimsOpenAt),
    winPayout: r.winPayout,
    rebatePayout: r.rebatePayout,
    fee: r.fee,
    creatorFee: r.creatorFee,
    dust: r.dust,
    payoutRoot: r.payoutRoot.toLowerCase() as Hex,
    bundleHash: r.bundleHash.toLowerCase() as Hex,
  };
}

const ENTERED = getAbiItem({ abi: flockedEscrowAbi, name: 'Entered' });

/** One `Entered` log, as the entry set keeps it (the ciphertext only as its keccak256). */
export interface EnteredLog {
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
  player: Hex;
  personTag: Hex;
  ticketHash: Hex;
  /** keccak256(ciphertext): `entries.commitment`. */
  commitment: Hex;
}

/** A provider refusing a range as too wide or too many results (each provider words it its own way). */
const RANGE_ERROR = /range|too many|limit|exceed|10000|block count/i;

/**
 * The round's `Entered` logs in [fromBlock, toBlock], in (block, log index) order. A range the
 * provider refuses as too large is halved until it is accepted (one block at the least).
 */
export async function enteredLogs(
  client: PublicClient,
  escrow: Address,
  chainRoundId: string,
  fromBlock: number,
  toBlock: number,
): Promise<EnteredLog[]> {
  try {
    const logs = await client.getLogs({
      address: escrow,
      event: ENTERED,
      args: { roundId: BigInt(chainRoundId) },
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
      strict: true,
    });
    return logs
      .map((l) => {
        if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null) {
          throw new Error('an Entered log without its block or transaction');
        }
        if (l.removed) throw new Error('the provider served a removed Entered log');
        return {
          txHash: l.transactionHash.toLowerCase() as Hex,
          logIndex: l.logIndex,
          blockNumber: Number(l.blockNumber),
          player: l.args.player.toLowerCase() as Hex,
          personTag: l.args.personTag.toLowerCase() as Hex,
          ticketHash: l.args.ticketHash.toLowerCase() as Hex,
          commitment: keccak256(l.args.ciphertext),
        };
      })
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    const text = err instanceof Error ? `${err.message} ${cause}` : String(err);
    if (toBlock <= fromBlock || !RANGE_ERROR.test(text)) throw err;
    const mid = fromBlock + Math.floor((toBlock - fromBlock) / 2);
    return [
      ...(await enteredLogs(client, escrow, chainRoundId, fromBlock, mid)),
      ...(await enteredLogs(client, escrow, chainRoundId, mid + 1, toBlock)),
    ];
  }
}
