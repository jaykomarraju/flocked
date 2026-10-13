// A fake Base node with a FlockedEscrow for the Stakes settlement tests (W6-A), so `pnpm check` needs
// no anvil (the anvil-backed test is e2e/tests/stakes-settle.test.ts). Blocks are 2 s apart with a
// safe head `safeLag` blocks behind; each Stakes round keeps its `Entered` logs (eth_getLogs) and
// answers `getRound` at any block. The operator's transactions are mined at once, one block each,
// with the contract's rules for `propose` (the closed form from @flocked/settle), `finalize`,
// `refundTooFew` and `refundTimeout`; `veto` is the guardian's, called directly. A provider can be
// told to drop logs (the reconciliation tests, ALERT-1).
import { flockedEscrowAbi } from '@flocked/abi';
import { settleStakesClosedForm } from '@flocked/settle';
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem';
import { decodeLog } from '../../src/indexer/decode.js';
import type { ChainEvent } from '../../src/indexer/types.js';
import { FAKE_ESCROW } from '../anchor-do/fake-chain.js';

export { FAKE_DEPLOYMENT, FAKE_ESCROW } from '../anchor-do/fake-chain.js';

const ZERO32: Hex = `0x${'00'.repeat(32)}`;
const CHALLENGE_WINDOW = 2 * 3600;
const REFUND_TIMEOUT = 72 * 3600;

export const STATUS = {
  Open: 1,
  SettleProposed: 2,
  RefundProposed: 3,
  Settled: 4,
  Refunded: 5,
} as const;

interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed: boolean;
}

function encodeLog(eventName: string, args: Record<string, unknown>) {
  const ev = flockedEscrowAbi.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const indexed = Object.fromEntries(
    ev.inputs.filter((i) => i.indexed).map((i) => [i.name ?? '', args[i.name ?? '']]),
  );
  const topics = encodeEventTopics({ abi: [ev], eventName, args: indexed }) as Hex[];
  const rest = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    rest,
    rest.map((i) => args[i.name as string]),
  );
  return { topics, data };
}

export interface FakeEntry {
  block: number;
  logIndex: number;
  txHash: Hex;
  player: Address;
  personTag: Hex;
  ticketHash: Hex;
  ciphertext: Hex;
}

export interface FakeRound {
  id: bigint;
  stake: bigint;
  minEntrants: number;
  feeBps: number;
  creatorBps: number;
  capMultiple: number;
  closesAt: number;
  entries: FakeEntry[];
  status: number;
  refundReason: number;
  claimsOpenAt: number;
  n: [number, number, number];
  payoutRoot: Hex;
  bundleHash: Hex;
  amounts: {
    winPayout: bigint;
    rebatePayout: bigint;
    fee: bigint;
    creatorFee: bigint;
    dust: bigint;
  };
  winner: number;
}

class Revert extends Error {
  readonly code = 3;
  constructor(reason: string) {
    super(`execution reverted: ${reason}`);
  }
}

export class FakeEscrowChain {
  readonly chainId = 31337;
  /** The head's number; block n is stamped `t0 + 2n`. */
  head: number;
  /** The safe head is this many blocks behind the head. */
  safeLag = 0;
  /** Changes every block hash from this height up (a reorg). */
  reorgFrom = Infinity;
  reorgSalt = 0;
  readonly rounds = new Map<bigint, FakeRound>();
  readonly receipts = new Map<Hex, Record<string, unknown>>();
  readonly nonces = new Map<string, number>();
  /** Every operator call mined, in order: `propose:<roundId>`, `finalize:<roundId>`, ... */
  readonly calls: string[] = [];
  /** The transaction of each mined call, in order. */
  readonly callTxs: { call: string; hash: Hex }[] = [];
  /** Logs a provider leaves out of eth_getLogs (by transaction hash). */
  readonly dropLogs: Record<'primary' | 'fallback', Set<Hex>> = {
    primary: new Set(),
    fallback: new Set(),
  };
  /** RPC method → calls, per provider. */
  readonly requests = new Map<string, number>();
  /** Providers without historical state (no archive node): a call at a block below the head fails. */
  readonly noArchive = new Set<'primary' | 'fallback'>();
  /** Mine every accepted transaction at once; otherwise they wait in `pool` for `mine()`. */
  automine = true;
  /** Accepted, not yet mined (raw transactions by `from:nonce`). */
  readonly pool = new Map<string, Hex>();

  constructor(
    readonly t0: number,
    head = 1000,
  ) {
    this.head = head;
  }

  timeOf(n: number): number {
    return this.t0 + 2 * n;
  }

  hashOf(n: number): Hex {
    const salt = n >= this.reorgFrom ? this.reorgSalt : 0;
    return keccak256(numberToHex(BigInt(n) * 1000n + BigInt(salt), { size: 32 }));
  }

  /** The head's time (Unix seconds). */
  get now(): number {
    return this.timeOf(this.head);
  }

  /** Mines empty blocks until the head is stamped at or after `sec`. */
  advanceTo(sec: number): void {
    while (this.timeOf(this.head) < sec) this.head += 1;
  }

  /** A Stakes round, Open, closing at `closesAt` (Unix seconds). */
  addRound(
    id: bigint,
    cfg: Pick<FakeRound, 'stake' | 'minEntrants' | 'feeBps' | 'creatorBps' | 'capMultiple'> & {
      closesAt: number;
    },
  ): FakeRound {
    const r: FakeRound = {
      id,
      ...cfg,
      entries: [],
      status: STATUS.Open,
      refundReason: 0,
      claimsOpenAt: 0,
      n: [0, 0, 0],
      payoutRoot: ZERO32,
      bundleHash: ZERO32,
      amounts: { winPayout: 0n, rebatePayout: 0n, fee: 0n, creatorFee: 0n, dust: 0n },
      winner: 255,
    };
    this.rounds.set(id, r);
    return r;
  }

  /** An `Entered` in a new block at the head (the head moves up one). */
  enter(id: bigint, e: Omit<FakeEntry, 'block' | 'logIndex'>): FakeEntry {
    const r = this.round(id);
    this.head += 1;
    const entry = { ...e, block: this.head, logIndex: 0 };
    r.entries.push(entry);
    return entry;
  }

  /** The latest mined transaction of `call` (e.g. 'propose'). */
  lastTx(call: string): Hex {
    const found = this.callTxs.filter((c) => c.call === call).pop();
    if (!found) throw new Error(`fake escrow: no ${call} mined`);
    return found.hash;
  }

  round(id: bigint): FakeRound {
    const r = this.rounds.get(id);
    if (!r) throw new Error(`fake escrow: no round ${id}`);
    return r;
  }

  /** The guardian's veto: a settlement is refunded (reason 5), a refund proposal reopened. */
  veto(id: bigint): Hex[] {
    const r = this.round(id);
    if (r.status !== STATUS.SettleProposed && r.status !== STATUS.RefundProposed) {
      throw new Error('fake veto: nothing proposed');
    }
    if (r.status === STATUS.SettleProposed) {
      r.status = STATUS.Refunded;
      r.refundReason = 5;
    } else {
      Object.assign(r, {
        status: STATUS.Open,
        refundReason: 0,
        n: [0, 0, 0],
        payoutRoot: ZERO32,
        bundleHash: ZERO32,
        claimsOpenAt: 0,
      });
    }
    this.head += 1;
    return [];
  }

  transport(provider: 'primary' | 'fallback' = 'primary') {
    return custom(
      {
        request: ({ method, params }: { method: string; params?: unknown }) =>
          this.request(provider, method, (params ?? []) as unknown[]),
      },
      { retryCount: 0 },
    );
  }

  private blockObject(n: number) {
    return {
      number: toHex(n),
      hash: this.hashOf(n),
      parentHash: n > 0 ? this.hashOf(n - 1) : ZERO32,
      timestamp: toHex(this.timeOf(n)),
      baseFeePerGas: toHex(1_000_000_000n),
      gasLimit: toHex(30_000_000),
      gasUsed: '0x0',
      miner: FAKE_ESCROW,
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      size: '0x0',
      nonce: '0x0000000000000000',
      logsBloom: `0x${'00'.repeat(256)}`,
      sha3Uncles: ZERO32,
      stateRoot: ZERO32,
      receiptsRoot: ZERO32,
      transactionsRoot: ZERO32,
      mixHash: ZERO32,
      transactions: [],
      uncles: [],
    };
  }

  private blockTag(tag: string): number {
    if (tag === 'latest' || tag === 'pending') return this.head;
    if (tag === 'safe' || tag === 'finalized') return Math.max(0, this.head - this.safeLag);
    return Number(BigInt(tag));
  }

  private enteredLog(r: FakeRound, e: FakeEntry): RpcLog {
    const { topics, data } = encodeLog('Entered', {
      roundId: r.id,
      player: e.player,
      personTag: e.personTag,
      ticketHash: e.ticketHash,
      ciphertext: e.ciphertext,
    });
    return {
      address: FAKE_ESCROW,
      topics,
      data,
      blockNumber: toHex(e.block),
      blockHash: this.hashOf(e.block),
      transactionHash: e.txHash,
      transactionIndex: '0x0',
      logIndex: toHex(e.logIndex),
      removed: false,
    };
  }

  private getRoundResult(r: FakeRound, atBlock: number) {
    const count = r.entries.filter((e) => e.block <= atBlock).length;
    return {
      cfg: {
        opensAt: 0n,
        closesAt: BigInt(r.closesAt),
        beaconRound: 1n,
        stake: r.stake,
        feeBps: r.feeBps,
        creatorBps: r.creatorBps,
        capMultiple: r.capMultiple,
        minEntrants: r.minEntrants,
        creator: FAKE_ESCROW,
        questionHash: ZERO32,
      },
      status: r.status,
      refundReason: r.refundReason,
      winner: r.winner,
      entryCount: count,
      claimsOpenAt: BigInt(r.claimsOpenAt),
      roundBalance: BigInt(count) * r.stake,
      n0: r.n[0],
      n1: r.n[1],
      nVoid: r.n[2],
      winClaims: 0,
      rebateClaims: 0,
      voidClaims: 0,
      refundClaims: 0,
      ...r.amounts,
      payoutRoot: r.payoutRoot,
      bundleHash: r.bundleHash,
    };
  }

  /** Runs an escrow call at time `now`; `write` applies it. Returns its logs' (name, args). */
  private apply(data: Hex, now: number, write: boolean): [string, Record<string, unknown>][] {
    const call = decodeFunctionData({ abi: flockedEscrowAbi, data });
    const id = call.args[0] as bigint;
    const r = this.round(id);
    const open = () => {
      if (r.status !== STATUS.Open) throw new Revert('WrongStatus');
    };
    switch (call.functionName) {
      case 'propose': {
        open();
        const [, n0, n1, nVoid, payoutRoot, bundleHash] = call.args;
        if (now >= r.closesAt + REFUND_TIMEOUT) throw new Revert('ProposalWindowClosed');
        if (n0 + n1 + nVoid !== r.entries.length) throw new Revert('TallyMismatch');
        if (bundleHash === ZERO32) throw new Revert('ZeroBundleHash');
        const o = settleStakesClosedForm({
          stake: r.stake,
          n0: BigInt(n0),
          n1: BigInt(n1),
          nVoid: BigInt(nVoid),
          feeBps: r.feeBps,
          creatorBps: r.creatorBps,
          capMultiple: r.capMultiple,
          minEntrants: r.minEntrants,
        });
        const refund = o.outcome === 'refunded';
        if (refund !== (payoutRoot === ZERO32)) throw new Revert('PayoutRoot');
        const claimsOpenAt = now + CHALLENGE_WINDOW;
        const status = refund ? STATUS.RefundProposed : STATUS.SettleProposed;
        if (write) {
          Object.assign(r, {
            status,
            refundReason: refund ? o.refundReason : 0,
            winner: o.winner ?? 255,
            n: [n0, n1, nVoid],
            payoutRoot,
            bundleHash,
            claimsOpenAt,
            amounts: {
              winPayout: o.winPayout,
              rebatePayout: o.rebatePayout,
              fee: o.fee,
              creatorFee: o.creatorFee,
              dust: o.dust,
            },
          });
        }
        return [
          [
            'OutcomeProposed',
            { roundId: id, status, n0, n1, nVoid, payoutRoot, bundleHash, claimsOpenAt },
          ],
        ];
      }
      case 'finalize': {
        if (r.status !== STATUS.SettleProposed && r.status !== STATUS.RefundProposed) {
          throw new Revert('WrongStatus');
        }
        if (now < r.claimsOpenAt) throw new Revert('ChallengeWindowOpen');
        const settled = r.status === STATUS.SettleProposed;
        if (write) r.status = settled ? STATUS.Settled : STATUS.Refunded;
        return settled
          ? [['RoundFinalized', { roundId: id, status: STATUS.Settled }]]
          : [
              ['RoundFinalized', { roundId: id, status: STATUS.Refunded }],
              ['RoundRefunded', { roundId: id, reason: r.refundReason }],
            ];
      }
      case 'refundTooFew': {
        open();
        if (now < r.closesAt) throw new Revert('RoundNotClosed');
        if (r.entries.length >= r.minEntrants) throw new Revert('EnoughEntrants');
        if (write) Object.assign(r, { status: STATUS.Refunded, refundReason: 1 });
        return [['RoundRefunded', { roundId: id, reason: 1 }]];
      }
      case 'refundTimeout': {
        open();
        if (now < r.closesAt + REFUND_TIMEOUT) throw new Revert('TimeoutNotReached');
        if (write) Object.assign(r, { status: STATUS.Refunded, refundReason: 6 });
        return [['RoundRefunded', { roundId: id, reason: 6 }]];
      }
      default:
        throw new Revert(`fake escrow: ${call.functionName} not supported`);
    }
  }

  /** Mines the pooled transactions, in nonce order, one block each. */
  async mine(): Promise<void> {
    for (const raw of [...this.pool.values()]) await this.execute(raw);
    this.pool.clear();
  }

  private async sendRaw(raw: Hex): Promise<Hex> {
    const parsed = parseTransaction(raw);
    const from = (
      await recoverTransactionAddress({ serializedTransaction: raw as never })
    ).toLowerCase();
    const hash = keccak256(raw);
    const nonce = parsed.nonce as number;
    if (this.receipts.has(hash) || this.pool.get(`${from}:${nonce}`) === raw) {
      throw new Error('already known');
    }
    if (nonce < (this.nonces.get(from) ?? 0)) throw new Error('nonce too low');
    if (!this.automine) {
      this.pool.set(`${from}:${nonce}`, raw);
      return hash;
    }
    return this.execute(raw);
  }

  private async execute(raw: Hex): Promise<Hex> {
    const parsed = parseTransaction(raw);
    const from = (
      await recoverTransactionAddress({ serializedTransaction: raw as never })
    ).toLowerCase();
    const hash = keccak256(raw);
    this.nonces.set(from, (parsed.nonce as number) + 1);
    this.head += 1;
    const data = parsed.data ?? '0x';
    let logs: [string, Record<string, unknown>][] = [];
    let ok = true;
    try {
      logs = this.apply(data, this.now, true);
      const call = decodeFunctionData({ abi: flockedEscrowAbi, data });
      this.calls.push(`${call.functionName}:${String((call.args as readonly unknown[])[0])}`);
      this.callTxs.push({ call: call.functionName, hash });
    } catch {
      ok = false;
    }
    this.receipts.set(hash, {
      transactionHash: hash,
      transactionIndex: '0x0',
      blockHash: this.hashOf(this.head),
      blockNumber: toHex(this.head),
      from,
      to: parsed.to?.toLowerCase(),
      cumulativeGasUsed: toHex(100_000),
      gasUsed: toHex(100_000),
      effectiveGasPrice: toHex(1_001_000_000n),
      contractAddress: null,
      logs: logs.map(([name, args], i) => ({
        address: FAKE_ESCROW,
        ...encodeLog(name, args),
        blockNumber: toHex(this.head),
        blockHash: this.hashOf(this.head),
        transactionHash: hash,
        transactionIndex: '0x0',
        logIndex: toHex(i),
        removed: false,
      })),
      logsBloom: `0x${'00'.repeat(256)}`,
      status: ok ? '0x1' : '0x0',
      type: '0x2',
    });
    return hash;
  }

  private async request(
    provider: 'primary' | 'fallback',
    method: string,
    params: unknown[],
  ): Promise<unknown> {
    const key = `${provider}:${method}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    switch (method) {
      case 'eth_chainId':
        return toHex(this.chainId);
      case 'eth_blockNumber':
        return toHex(this.head);
      case 'eth_getBlockByNumber':
        return this.blockObject(this.blockTag(params[0] as string));
      case 'eth_maxPriorityFeePerGas':
        return toHex(1_000_000n);
      case 'eth_gasPrice':
        return toHex(1_001_000_000n);
      case 'eth_getTransactionCount': {
        const from = (params[0] as string).toLowerCase();
        let n = this.nonces.get(from) ?? 0;
        if (params[1] === 'pending') while (this.pool.has(`${from}:${n}`)) n += 1;
        return toHex(n);
      }
      case 'eth_sendRawTransaction':
        return this.sendRaw(params[0] as Hex);
      case 'eth_getTransactionReceipt':
        return this.receipts.get(params[0] as Hex) ?? null;
      case 'eth_getTransactionByHash':
        return null;
      case 'eth_estimateGas': {
        const { data } = params[0] as { data: Hex };
        this.apply(data, this.now + 2, false);
        return toHex(200_000);
      }
      case 'eth_call': {
        const [{ data }, tag] = params as [{ data: Hex }, string];
        if (this.noArchive.has(provider) && this.blockTag(tag) < this.head) {
          throw new Error('missing trie node (historical state not available)');
        }
        const call = decodeFunctionData({ abi: flockedEscrowAbi, data });
        if (call.functionName !== 'getRound')
          throw new Error(`fake eth_call: ${call.functionName}`);
        return encodeFunctionResult({
          abi: flockedEscrowAbi,
          functionName: 'getRound',
          result: this.getRoundResult(this.round(call.args[0]), this.blockTag(tag)),
        });
      }
      case 'eth_getLogs': {
        const f = params[0] as { fromBlock: Hex; toBlock: Hex; topics?: (Hex | null)[] };
        const from = Number(BigInt(f.fromBlock));
        const to = Number(BigInt(f.toBlock));
        const roundTopic = f.topics?.[1];
        const out: RpcLog[] = [];
        for (const r of this.rounds.values()) {
          const topic = numberToHex(r.id, { size: 32 });
          if (roundTopic && roundTopic.toLowerCase() !== topic) continue;
          for (const e of r.entries) {
            if (e.block < from || e.block > to || this.dropLogs[provider].has(e.txHash)) continue;
            out.push(this.enteredLog(r, e));
          }
        }
        return out;
      }
      default:
        throw new Error(`fake RPC: ${method} not supported`);
    }
  }
}

/** The indexer's view of a logged event (src/indexer/types.ts ChainEvent), args as JSON. */
export function chainEventOf(
  chain: FakeEscrowChain,
  eventName: string,
  args: Record<string, unknown>,
  at: { txHash: Hex; block: number; logIndex?: number },
): ChainEvent {
  const { topics, data } = encodeLog(eventName, args);
  const d = decodeLog(flockedEscrowAbi, {
    address: FAKE_ESCROW,
    topics,
    data,
    blockNumber: at.block,
    blockHash: chain.hashOf(at.block),
    transactionHash: at.txHash,
    logIndex: at.logIndex ?? 0,
  });
  return {
    chainId: 31337,
    contract: FAKE_ESCROW,
    contractKind: 'escrow',
    blockNumber: at.block,
    blockHash: chain.hashOf(at.block),
    blockTimestampSec: chain.timeOf(at.block),
    txHash: at.txHash,
    logIndex: at.logIndex ?? 0,
    event: d.event,
    args: d.args,
    removed: false,
    revision: 0,
  };
}

/** The events a mined transaction logged, as the indexer hands them to handlers. */
export function eventsOf(chain: FakeEscrowChain, txHash: Hex): ChainEvent[] {
  const receipt = chain.receipts.get(txHash) as
    { blockNumber: Hex; logs: { topics: Hex[]; data: Hex; logIndex: Hex }[] } | undefined;
  if (!receipt) throw new Error(`fake escrow: no receipt for ${txHash}`);
  const block = Number(BigInt(receipt.blockNumber));
  return receipt.logs.map((l) => {
    const logIndex = Number(BigInt(l.logIndex));
    const d = decodeLog(flockedEscrowAbi, {
      address: FAKE_ESCROW,
      topics: l.topics,
      data: l.data,
      blockNumber: block,
      blockHash: chain.hashOf(block),
      transactionHash: txHash,
      logIndex,
    });
    return {
      chainId: 31337,
      contract: FAKE_ESCROW,
      contractKind: 'escrow',
      blockNumber: block,
      blockHash: chain.hashOf(block),
      blockTimestampSec: chain.timeOf(block),
      txHash,
      logIndex,
      event: d.event,
      args: d.args,
      removed: false,
      revision: 0,
    };
  });
}
