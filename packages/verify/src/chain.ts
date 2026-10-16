// Chain reads: FlockedAnchor (Free) and FlockedEscrow (Stakes), through viem on a JSON-RPC URL. The
// verifier sees the chain only through `ChainReader`, so tests swap in a fake and the browser uses the
// same viem code as the CLI.
import { flockedAnchorAbi, flockedEscrowAbi } from '@flocked/abi';
import {
  createPublicClient,
  http,
  keccak256,
  stringToBytes,
  type Hex,
  type PublicClient,
} from 'viem';

export const ANCHOR_ROLE: Hex = keccak256(stringToBytes('ANCHOR_ROLE'));

/** Escrow `Status`, by its enum index. */
export const ESCROW_STATUS = [
  'None',
  'Open',
  'SettleProposed',
  'RefundProposed',
  'Settled',
  'Refunded',
] as const;

export interface AnchorState {
  closesAt: bigint;
  beaconRound: bigint;
  lockedAt: bigint;
  committedAt: bigint;
  configHash: Hex;
  commitmentRoot: Hex;
  entryCount: number;
  totalStake: bigint;
  manifestAnchoredAt: bigint;
  manifestHash: Hex;
}

export interface AnchorLog {
  event: 'Locked' | 'Committed' | 'ManifestAnchored';
  txHash: Hex;
  blockNumber: bigint;
  /** The transaction's sender: the key that held ANCHOR_ROLE. */
  sender: Hex;
}

export interface StakesRoundState {
  /** Index into ESCROW_STATUS. */
  status: number;
  opensAt: bigint;
  closesAt: bigint;
  beaconRound: bigint;
  stake: bigint;
  feeBps: number;
  creatorBps: number;
  capMultiple: number;
  minEntrants: number;
  entryCount: number;
}

export interface EnteredLog {
  player: Hex;
  ciphertext: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface ProposalLog {
  /** Index into ESCROW_STATUS: 2 SettleProposed or 3 RefundProposed. */
  status: number;
  n0: number;
  n1: number;
  nVoid: number;
  payoutRoot: Hex;
  bundleHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
}

export interface ChainReader {
  /** `FlockedAnchor.getAnchor(key)`. */
  anchor(key: Hex): Promise<AnchorState>;
  /** The Locked, Committed and ManifestAnchored logs for `key`, with their senders. */
  anchorLogs(key: Hex, state: AnchorState): Promise<AnchorLog[]>;
  /** `RoleRevoked(ANCHOR_ROLE, account)` logs from `fromBlock` on. */
  anchorRevocations(account: Hex, fromBlock: bigint): Promise<bigint[]>;
  /** `FlockedEscrow.getRound(id)`. */
  stakesRound(chainRoundId: bigint): Promise<StakesRoundState>;
  /** The round's `Entered` logs up to and including `toBlock`, in (block, log index) order. */
  entered(chainRoundId: bigint, opensAt: bigint, toBlock: bigint): Promise<EnteredLog[]>;
  /** The round's `OutcomeProposed` logs from `fromBlock` on. */
  proposals(chainRoundId: bigint, fromBlock: bigint): Promise<ProposalLog[]>;
  /** The hash of block `n`, or null when the chain has no such block. */
  blockHash(n: bigint): Promise<Hex | null>;
}

/** Smallest block span the log scan splits down to when the RPC refuses a range. */
const MIN_SPAN = 500n;

/**
 * Runs `get` over [from, to], halving the range whenever the RPC refuses it (providers cap getLogs
 * ranges or result sizes), down to MIN_SPAN blocks.
 */
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

export function viemReader(i: {
  rpcUrl: string;
  escrow: Hex;
  anchor: Hex;
  deployBlock: bigint;
  client?: PublicClient;
}): ChainReader {
  const client = i.client ?? createPublicClient({ transport: http(i.rpcUrl) });
  const timestamps = new Map<bigint, bigint>();
  const timestampOf = async (n: bigint) => {
    let t = timestamps.get(n);
    if (t === undefined) {
      t = (await client.getBlock({ blockNumber: n })).timestamp;
      timestamps.set(n, t);
    }
    return t;
  };
  /** The first block at or after deployBlock whose timestamp is ≥ ts (latest + 1 when none is). */
  const firstBlockAtOrAfter = async (ts: bigint, latest: bigint) => {
    let lo = i.deployBlock;
    let hi = latest + 1n;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if ((await timestampOf(mid)) >= ts) hi = mid;
      else lo = mid + 1n;
    }
    return lo;
  };
  const senders = new Map<Hex, Hex>();
  const senderOf = async (txHash: Hex) => {
    let s = senders.get(txHash);
    if (s === undefined) {
      s = (await client.getTransaction({ hash: txHash })).from.toLowerCase() as Hex;
      senders.set(txHash, s);
    }
    return s;
  };

  return {
    async anchor(key) {
      const a = await client.readContract({
        address: i.anchor,
        abi: flockedAnchorAbi,
        functionName: 'getAnchor',
        args: [key],
      });
      return {
        closesAt: a.closesAt,
        beaconRound: a.beaconRound,
        lockedAt: a.lockedAt,
        committedAt: a.committedAt,
        configHash: a.configHash,
        commitmentRoot: a.commitmentRoot,
        entryCount: a.entryCount,
        totalStake: a.totalStake,
        manifestAnchoredAt: a.manifestAnchoredAt,
        manifestHash: a.manifestHash,
      };
    },

    async anchorLogs(key, state) {
      const latest = await client.getBlockNumber();
      const out: AnchorLog[] = [];
      const writes = [
        ['Locked', state.lockedAt],
        ['Committed', state.committedAt],
        ['ManifestAnchored', state.manifestAnchoredAt],
      ] as const;
      for (const [event, at] of writes) {
        if (at === 0n) continue;
        // The write's block has timestamp `at`: search only the blocks stamped with it.
        const from = await firstBlockAtOrAfter(at, latest);
        const to = (await firstBlockAtOrAfter(at + 1n, latest)) - 1n;
        const logs = await scan(from, to, (f, t) =>
          client.getContractEvents({
            address: i.anchor,
            abi: flockedAnchorAbi,
            eventName: event,
            args: { roundKey: key },
            fromBlock: f,
            toBlock: t,
            strict: true,
          }),
        );
        for (const l of logs) {
          out.push({
            event,
            txHash: l.transactionHash,
            blockNumber: l.blockNumber,
            sender: await senderOf(l.transactionHash),
          });
        }
      }
      return out;
    },

    async anchorRevocations(account, fromBlock) {
      const latest = await client.getBlockNumber();
      const logs = await scan(fromBlock, latest, (f, t) =>
        client.getContractEvents({
          address: i.anchor,
          abi: flockedAnchorAbi,
          eventName: 'RoleRevoked',
          args: { role: ANCHOR_ROLE, account },
          fromBlock: f,
          toBlock: t,
          strict: true,
        }),
      );
      return logs.map((l) => l.blockNumber);
    },

    async stakesRound(id) {
      const r = await client.readContract({
        address: i.escrow,
        abi: flockedEscrowAbi,
        functionName: 'getRound',
        args: [id],
      });
      return {
        status: r.status,
        opensAt: r.cfg.opensAt,
        closesAt: r.cfg.closesAt,
        beaconRound: r.cfg.beaconRound,
        stake: r.cfg.stake,
        feeBps: r.cfg.feeBps,
        creatorBps: r.cfg.creatorBps,
        capMultiple: r.cfg.capMultiple,
        minEntrants: r.cfg.minEntrants,
        entryCount: r.entryCount,
      };
    },

    async entered(id, opensAt, toBlock) {
      const from = await firstBlockAtOrAfter(opensAt, toBlock);
      const logs = await scan(from, toBlock, (f, t) =>
        client.getContractEvents({
          address: i.escrow,
          abi: flockedEscrowAbi,
          eventName: 'Entered',
          args: { roundId: id },
          fromBlock: f,
          toBlock: t,
          strict: true,
        }),
      );
      return logs
        .map((l) => ({
          player: l.args.player.toLowerCase() as Hex,
          ciphertext: l.args.ciphertext,
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
        }))
        .sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : a.blockNumber < b.blockNumber
              ? -1
              : 1,
        );
    },

    async proposals(id, fromBlock) {
      const latest = await client.getBlockNumber();
      const logs = await scan(fromBlock, latest, (f, t) =>
        client.getContractEvents({
          address: i.escrow,
          abi: flockedEscrowAbi,
          eventName: 'OutcomeProposed',
          args: { roundId: id },
          fromBlock: f,
          toBlock: t,
          strict: true,
        }),
      );
      return logs.map((l) => ({
        status: l.args.status,
        n0: l.args.n0,
        n1: l.args.n1,
        nVoid: l.args.nVoid,
        payoutRoot: l.args.payoutRoot,
        bundleHash: l.args.bundleHash,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
      }));
    },

    async blockHash(n) {
      try {
        return (await client.getBlock({ blockNumber: n })).hash;
      } catch {
        return null;
      }
    },
  };
}
