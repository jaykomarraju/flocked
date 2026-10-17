// The watcher's own chain reads, over its own RPC. `@flocked/verify`'s `viemReader` covers what a
// recompute needs; this module adds what only the watcher checks: the `RoundCreated` config, the
// escrow's treasury, the routes into Refunded, and block timestamps.
//
// Everything goes through `WatcherChain`, so tests swap in a fake exactly as `@flocked/verify`'s
// tests swap in a `ChainReader`.
import { addressesFor, flockedEscrowAbi, type Deployment } from '@flocked/abi';
import { viemReader, type ChainReader } from '@flocked/verify';
import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';

/** FlockedEscrow's `RoundConfig`, as `RoundCreated` carries it. */
export interface OnchainRoundConfig {
  opensAt: bigint;
  closesAt: bigint;
  beaconRound: bigint;
  stake: bigint;
  feeBps: number;
  creatorBps: number;
  capMultiple: number;
  minEntrants: number;
  creator: Address;
  questionHash: Hex;
}

export interface RoundCreatedLog {
  cfg: OnchainRoundConfig;
  txHash: Hex;
  blockNumber: bigint;
}

export interface RoundRefundedLog {
  /** 1 too few, 2 one-sided, 3 tie, 4 voided, 5 vetoed, 6 timeout. */
  reason: number;
  txHash: Hex;
  blockNumber: bigint;
}

export interface ProposedLog {
  status: number;
  n0: number;
  n1: number;
  nVoid: number;
  payoutRoot: Hex;
  bundleHash: Hex;
  claimsOpenAt: bigint;
  txHash: Hex;
  blockNumber: bigint;
}

/** `getRound(id)`, as the watcher reads it. */
export interface OnchainRound {
  /** Index into FlockedEscrow's `Status`: 0 None, 1 Open, 2/3 proposed, 4 Settled, 5 Refunded. */
  status: number;
  /** 1 too few, 2 one-sided, 3 tie, 4 voided, 5 vetoed, 6 timeout; 0 while not refunded. */
  refundReason: number;
  entryCount: number;
  cfg: OnchainRoundConfig;
}

export interface WatcherChain {
  /** The escrow's treasury: a house question's `creator` must be it. */
  treasury(): Promise<Address>;
  /** `REFUND_TIMEOUT`, the delay after close that makes `refundTimeout` callable. */
  refundTimeout(): Promise<bigint>;
  /** The round's `RoundCreated` log, or null when the chain has none. */
  roundCreated(chainRoundId: bigint, fromBlock?: bigint): Promise<RoundCreatedLog | null>;
  /** `getRound(id)`: the frozen config and where the round stands. */
  round(chainRoundId: bigint): Promise<OnchainRound>;
  roundRefunded(chainRoundId: bigint, fromBlock: bigint): Promise<RoundRefundedLog[]>;
  proposed(chainRoundId: bigint, fromBlock: bigint): Promise<ProposedLog[]>;
  /** A block's Unix-second timestamp, or null when the chain has no such block. */
  blockTime(n: bigint): Promise<number | null>;
}

/** Smallest block span the log scan splits down to when the RPC refuses a range (as W9-B's). */
const MIN_SPAN = 500n;

async function scan<T>(
  from: bigint,
  to: bigint,
  get: (f: bigint, t: bigint) => Promise<T[]>,
): Promise<T[]> {
  if (from > to) return [];
  try {
    return await get(from, to);
  } catch (e) {
    if (to - from < MIN_SPAN) throw e;
    const mid = (from + to) / 2n;
    return [...(await scan(from, mid, get)), ...(await scan(mid + 1n, to, get))];
  }
}

/** The deployment the watcher checks: the committed one, or the stack's for the local chain. */
export function deploymentFor(chainId: number, localDeploymentJson?: string): Deployment {
  return addressesFor(
    chainId,
    localDeploymentJson ? (JSON.parse(localDeploymentJson) as unknown) : undefined,
  );
}

export function watcherChain(i: {
  rpcUrl: string;
  deployment: Deployment;
  client?: PublicClient;
}): WatcherChain {
  const client: PublicClient = i.client ?? createPublicClient({ transport: http(i.rpcUrl) });
  const address = i.deployment.escrow;
  const head = () => client.getBlockNumber();

  return {
    async treasury() {
      const t = await client.readContract({
        address,
        abi: flockedEscrowAbi,
        functionName: 'treasury',
      });
      return t.toLowerCase() as Address;
    },

    refundTimeout: () =>
      client.readContract({ address, abi: flockedEscrowAbi, functionName: 'REFUND_TIMEOUT' }),

    async roundCreated(chainRoundId, from) {
      const logs = await scan(
        from ?? i.deployment.deployBlock,
        await head(),
        (fromBlock, toBlock) =>
          client.getContractEvents({
            address,
            abi: flockedEscrowAbi,
            eventName: 'RoundCreated',
            args: { roundId: chainRoundId },
            fromBlock,
            toBlock,
          }),
      );
      const l = logs[0];
      if (!l?.args.cfg || l.blockNumber === null || l.transactionHash === null) return null;
      const c = l.args.cfg;
      return {
        cfg: {
          opensAt: c.opensAt,
          closesAt: c.closesAt,
          beaconRound: c.beaconRound,
          stake: c.stake,
          feeBps: c.feeBps,
          creatorBps: c.creatorBps,
          capMultiple: c.capMultiple,
          minEntrants: c.minEntrants,
          creator: c.creator.toLowerCase() as Address,
          questionHash: c.questionHash.toLowerCase() as Hex,
        },
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
      };
    },

    async round(chainRoundId) {
      const r = await client.readContract({
        address,
        abi: flockedEscrowAbi,
        functionName: 'getRound',
        args: [chainRoundId],
      });
      return {
        status: r.status,
        refundReason: r.refundReason,
        entryCount: r.entryCount,
        cfg: {
          opensAt: r.cfg.opensAt,
          closesAt: r.cfg.closesAt,
          beaconRound: r.cfg.beaconRound,
          stake: r.cfg.stake,
          feeBps: r.cfg.feeBps,
          creatorBps: r.cfg.creatorBps,
          capMultiple: r.cfg.capMultiple,
          minEntrants: r.cfg.minEntrants,
          creator: r.cfg.creator.toLowerCase() as Address,
          questionHash: r.cfg.questionHash.toLowerCase() as Hex,
        },
      };
    },

    async roundRefunded(chainRoundId, fromBlock) {
      const logs = await scan(fromBlock, await head(), (f, t) =>
        client.getContractEvents({
          address,
          abi: flockedEscrowAbi,
          eventName: 'RoundRefunded',
          args: { roundId: chainRoundId },
          fromBlock: f,
          toBlock: t,
        }),
      );
      return logs.flatMap((l) =>
        l.args.reason === undefined || l.blockNumber === null || l.transactionHash === null
          ? []
          : [{ reason: l.args.reason, txHash: l.transactionHash, blockNumber: l.blockNumber }],
      );
    },

    async proposed(chainRoundId, fromBlock) {
      const logs = await scan(fromBlock, await head(), (f, t) =>
        client.getContractEvents({
          address,
          abi: flockedEscrowAbi,
          eventName: 'OutcomeProposed',
          args: { roundId: chainRoundId },
          fromBlock: f,
          toBlock: t,
        }),
      );
      return logs.flatMap((l) => {
        const a = l.args;
        if (
          a.status === undefined ||
          a.n0 === undefined ||
          a.n1 === undefined ||
          a.nVoid === undefined ||
          a.payoutRoot === undefined ||
          a.bundleHash === undefined ||
          a.claimsOpenAt === undefined ||
          l.blockNumber === null ||
          l.transactionHash === null
        ) {
          return [];
        }
        return [
          {
            status: a.status,
            n0: a.n0,
            n1: a.n1,
            nVoid: a.nVoid,
            payoutRoot: a.payoutRoot.toLowerCase() as Hex,
            bundleHash: a.bundleHash.toLowerCase() as Hex,
            claimsOpenAt: a.claimsOpenAt,
            txHash: l.transactionHash,
            blockNumber: l.blockNumber,
          },
        ];
      });
    },

    async blockTime(n) {
      try {
        const b = await client.getBlock({ blockNumber: n });
        return Number(b.timestamp);
      } catch {
        return null;
      }
    },
  };
}

/** `@flocked/verify`'s reader on the watcher's own RPC and deployment. */
export function verifyReader(rpcUrl: string, d: Deployment): ChainReader {
  return viemReader({ rpcUrl, escrow: d.escrow, anchor: d.anchor, deployBlock: d.deployBlock });
}
