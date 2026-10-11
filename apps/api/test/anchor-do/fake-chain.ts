// A fake JSON-RPC node for the AnchorDO, operator, scheduler and grant tests, so `pnpm check` needs no
// anvil (the anvil-backed tests are e2e/tests/anchor-*.test.ts). It keeps nonces, a mempool with
// fee-bump replacement, blocks with timestamps and receipts, and mirrors the contract rules the server
// relies on: FlockedAnchor's write-once `lock`/`commit` batches with `Skipped` (reasons 1–4) and its
// reverting `anchorManifest`, and FlockedEscrow's `createRound` checks and `RoundCreated`, and
// `voidRound` (refused at or after closesAt, `RoundRefunded` reason 4; W4-D).
import { flockedAnchorAbi, flockedEscrowAbi } from '@flocked/abi';
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

export const FAKE_ANCHOR: Address = '0xa0c0000000000000000000000000000000000a01';
export const FAKE_ESCROW: Address = '0xe5c0000000000000000000000000000000000e01';
export const FAKE_USDC: Address = '0x05dc000000000000000000000000000000000c01';

/** `LOCAL_DEPLOYMENT` for the fake chain. */
export const FAKE_DEPLOYMENT = JSON.stringify({
  escrow: FAKE_ESCROW,
  anchor: FAKE_ANCHOR,
  usdc: FAKE_USDC,
  deployBlock: 0,
});

export interface AnchorState {
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

export interface PoolTx {
  hash: Hex;
  raw: Hex;
  from: Address;
  nonce: number;
  to: Address;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface RpcLog {
  address: Address;
  /** As encodeEventTopics returns them (no wildcards here). */
  topics: (Hex | Hex[] | null)[];
  data: Hex;
}

const ZERO32: Hex = `0x${'00'.repeat(32)}`;
const BLOOM: Hex = `0x${'00'.repeat(256)}`;

function emptyAnchor(): AnchorState {
  return {
    closesAt: 0n,
    beaconRound: 0n,
    lockedAt: 0n,
    committedAt: 0n,
    questionHash: ZERO32,
    configHash: ZERO32,
    commitmentRoot: ZERO32,
    entryCount: 0,
    totalStake: 0n,
    manifestAnchoredAt: 0n,
    manifestHash: ZERO32,
  };
}

function eventLog(
  abi: readonly unknown[],
  address: Address,
  eventName: string,
  args: Record<string, unknown>,
): RpcLog {
  const ev = abi.find(
    (x) => (x as AbiEvent).type === 'event' && (x as AbiEvent).name === eventName,
  ) as AbiEvent;
  const indexed: Record<string, unknown> = Object.fromEntries(
    ev.inputs.filter((i) => i.indexed).map((i) => [i.name ?? '', args[i.name ?? '']]),
  );
  const topics = encodeEventTopics({ abi: [ev], eventName, args: indexed });
  const rest = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    rest,
    rest.map((i) => args[i.name as string]),
  );
  return { address, topics, data };
}

class Revert extends Error {
  readonly code = 3;
  constructor(reason: string) {
    super(`execution reverted: ${reason}`);
  }
}

export class FakeChain {
  readonly chainId = 31337;
  /** Chain time (block timestamp of the next block), Unix seconds. */
  time: number;
  block = 100n;
  baseFee = 1_000_000_000n;
  tip = 1_000_000n;
  /** Mine every accepted transaction at once (anvil's default). */
  automine = true;

  readonly nonces = new Map<string, number>();
  readonly pool = new Map<string, PoolTx>();
  readonly known = new Map<Hex, PoolTx>();
  readonly receipts = new Map<Hex, Record<string, unknown>>();
  readonly blockTimes = new Map<bigint, number>();
  readonly anchors = new Map<Hex, AnchorState>();
  readonly code = new Map<string, Hex>();
  /** Every accepted broadcast, in order. */
  readonly sent: PoolTx[] = [];
  /** Every mined transaction's hash, in order. */
  readonly mined: Hex[] = [];
  /** RPC method → failures to inject before it works again. */
  readonly failNext = new Map<string, number>();
  roundCount = 0n;
  /** FlockedEscrow rounds by ID: their close time (Unix seconds) and whether they are still Open. */
  readonly escrowRounds = new Map<bigint, { closesAt: bigint; open: boolean }>();

  readonly transport = custom(
    {
      request: ({ method, params }: { method: string; params?: unknown }) =>
        this.request(method, (params ?? []) as unknown[]),
    },
    { retryCount: 0 },
  );

  constructor(
    readonly drand: { genesis: number; period: number },
    time: number,
  ) {
    this.time = time;
    this.blockTimes.set(this.block, time);
  }

  beaconTime(round: bigint): bigint {
    return BigInt(this.drand.genesis) + (round - 1n) * BigInt(this.drand.period);
  }

  anchorOf(key: Hex): AnchorState {
    return this.anchors.get(key.toLowerCase() as Hex) ?? emptyAnchor();
  }

  /** Another transaction (not ours) takes `address`'s next nonce, evicting whatever is pooled there. */
  consumeNonce(address: Address): void {
    const from = address.toLowerCase();
    const n = this.nonces.get(from) ?? 0;
    const pooled = this.pool.get(`${from}:${n}`);
    if (pooled) {
      this.pool.delete(`${from}:${n}`);
      this.known.delete(pooled.hash);
    }
    this.nonces.set(from, n + 1);
  }

  /** Mines every pooled transaction that is next in its sender's nonce order, in one block. */
  mine(): Hex[] {
    this.block += 1n;
    this.blockTimes.set(this.block, this.time);
    const done: Hex[] = [];
    for (let progress = true; progress;) {
      progress = false;
      for (const [slot, tx] of [...this.pool].sort((a, b) => a[1].nonce - b[1].nonce)) {
        if ((this.nonces.get(tx.from) ?? 0) !== tx.nonce) continue;
        this.pool.delete(slot);
        this.nonces.set(tx.from, tx.nonce + 1);
        this.execute(tx, done.length);
        done.push(tx.hash);
        progress = true;
      }
    }
    this.mined.push(...done);
    this.time += 2;
    return done;
  }

  private execute(tx: PoolTx, index: number): void {
    let logs: RpcLog[] = [];
    let ok = true;
    try {
      logs = this.apply(tx.to, tx.data, true);
    } catch {
      ok = false;
    }
    const blockHash = keccak256(numberToHex(this.block, { size: 32 }));
    this.receipts.set(tx.hash, {
      transactionHash: tx.hash,
      transactionIndex: toHex(index),
      blockHash,
      blockNumber: toHex(this.block),
      from: tx.from,
      to: tx.to,
      cumulativeGasUsed: toHex(100_000),
      gasUsed: toHex(100_000),
      effectiveGasPrice: toHex(this.baseFee + this.tip),
      contractAddress: null,
      logs: logs.map((l, i) => ({
        ...l,
        blockHash,
        blockNumber: toHex(this.block),
        transactionHash: tx.hash,
        transactionIndex: toHex(index),
        logIndex: toHex(i),
        removed: false,
      })),
      logsBloom: BLOOM,
      status: ok ? '0x1' : '0x0',
      type: '0x2',
    });
  }

  /** Runs a call against the contracts; `write` applies it. Throws `Revert`. */
  private apply(to: Address, data: Hex, write: boolean): RpcLog[] {
    const now = BigInt(this.time);
    if (to.toLowerCase() === FAKE_ANCHOR) {
      const call = decodeFunctionData({ abi: flockedAnchorAbi, data });
      const logs: RpcLog[] = [];
      const skip = (roundKey: Hex, reason: number) =>
        logs.push(eventLog(flockedAnchorAbi, FAKE_ANCHOR, 'Skipped', { roundKey, reason }));
      if (call.functionName === 'lock') {
        const [keys, closes, beacons, qhs, chs] = call.args;
        keys.forEach((key, i) => {
          const a = this.anchorOf(key);
          const closesAt = closes[i] as bigint;
          const br = beacons[i] as bigint;
          if (a.lockedAt !== 0n) return skip(key, 1);
          const bt = br === 0n ? 0n : this.beaconTime(br);
          if (br === 0n || bt < closesAt + 60n || bt > closesAt + 600n) return skip(key, 4);
          if (now >= closesAt) return skip(key, 3);
          if (write) {
            this.anchors.set(key.toLowerCase() as Hex, {
              ...a,
              closesAt,
              beaconRound: br,
              lockedAt: now,
              questionHash: qhs[i] as Hex,
              configHash: chs[i] as Hex,
            });
          }
          logs.push(
            eventLog(flockedAnchorAbi, FAKE_ANCHOR, 'Locked', {
              roundKey: key,
              closesAt,
              beaconRound: br,
              questionHash: qhs[i],
              configHash: chs[i],
            }),
          );
        });
        return logs;
      }
      if (call.functionName === 'commit') {
        const [keys, roots, counts, stakes] = call.args;
        keys.forEach((key, i) => {
          const a = this.anchorOf(key);
          if (a.committedAt !== 0n) return skip(key, 1);
          if (a.lockedAt === 0n) return skip(key, 2);
          if (now < a.closesAt || now >= this.beaconTime(a.beaconRound)) return skip(key, 3);
          if (write) {
            this.anchors.set(key.toLowerCase() as Hex, {
              ...a,
              committedAt: now,
              commitmentRoot: roots[i] as Hex,
              entryCount: counts[i] as number,
              totalStake: stakes[i] as bigint,
            });
          }
          logs.push(
            eventLog(flockedAnchorAbi, FAKE_ANCHOR, 'Committed', {
              roundKey: key,
              commitmentRoot: roots[i],
              entryCount: counts[i],
              totalStake: stakes[i],
            }),
          );
        });
        return logs;
      }
      if (call.functionName === 'anchorManifest') {
        const [key, manifestHash] = call.args;
        const a = this.anchorOf(key);
        if (manifestHash === ZERO32) throw new Revert('ZeroManifestHash');
        if (a.manifestAnchoredAt !== 0n) throw new Revert('ManifestAlreadyAnchored');
        if (a.lockedAt === 0n) throw new Revert('NotLocked');
        if (now < this.beaconTime(a.beaconRound)) throw new Revert('BeaconNotReached');
        if (write) {
          this.anchors.set(key.toLowerCase() as Hex, {
            ...a,
            manifestAnchoredAt: now,
            manifestHash,
          });
        }
        return [
          eventLog(flockedAnchorAbi, FAKE_ANCHOR, 'ManifestAnchored', {
            roundKey: key,
            manifestHash,
          }),
        ];
      }
      throw new Revert(`fake anchor: ${call.functionName} not supported`);
    }
    if (to.toLowerCase() === FAKE_ESCROW) {
      const call = decodeFunctionData({ abi: flockedEscrowAbi, data });
      if (call.functionName === 'voidRound') {
        const [roundId] = call.args;
        const rd = this.escrowRounds.get(roundId);
        if (!rd) throw new Revert('UnknownRound');
        if (!rd.open) throw new Revert('WrongStatus');
        if (now >= rd.closesAt) throw new Revert('RoundClosed');
        if (write) rd.open = false;
        return [eventLog(flockedEscrowAbi, FAKE_ESCROW, 'RoundRefunded', { roundId, reason: 4 })];
      }
      if (call.functionName !== 'createRound') {
        if (write) return [];
        return [];
      }
      const [cfg] = call.args;
      if (!(now < cfg.opensAt && cfg.opensAt < cfg.closesAt)) throw new Revert('InvalidSchedule');
      const bt = this.beaconTime(cfg.beaconRound);
      if (bt < cfg.closesAt + 60n || bt > cfg.closesAt + 600n) throw new Revert('BeaconOutOfRange');
      const roundId = this.roundCount + 1n;
      if (write) {
        this.roundCount = roundId;
        this.escrowRounds.set(roundId, { closesAt: cfg.closesAt, open: true });
      }
      return [eventLog(flockedEscrowAbi, FAKE_ESCROW, 'RoundCreated', { roundId, cfg })];
    }
    throw new Revert(`no contract at ${to}`);
  }

  private blockObject(n: bigint) {
    const hash = keccak256(numberToHex(n, { size: 32 }));
    return {
      number: toHex(n),
      hash,
      parentHash: ZERO32,
      timestamp: toHex(this.blockTimes.get(n) ?? this.time),
      baseFeePerGas: toHex(this.baseFee),
      gasLimit: toHex(30_000_000),
      gasUsed: '0x0',
      miner: FAKE_ANCHOR,
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      size: '0x0',
      nonce: '0x0000000000000000',
      logsBloom: BLOOM,
      sha3Uncles: ZERO32,
      stateRoot: ZERO32,
      receiptsRoot: ZERO32,
      transactionsRoot: ZERO32,
      mixHash: ZERO32,
      transactions: [],
      uncles: [],
    };
  }

  private txObject(tx: PoolTx) {
    return {
      hash: tx.hash,
      nonce: toHex(tx.nonce),
      blockHash: null,
      blockNumber: null,
      transactionIndex: null,
      from: tx.from,
      to: tx.to,
      value: '0x0',
      gas: toHex(tx.gas),
      input: tx.data,
      type: '0x2',
      maxFeePerGas: toHex(tx.maxFeePerGas),
      maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas),
      chainId: toHex(this.chainId),
      accessList: [],
      v: '0x0',
      r: ZERO32,
      s: ZERO32,
    };
  }

  private async sendRaw(raw: Hex): Promise<Hex> {
    const parsed = parseTransaction(raw);
    const from = (
      await recoverTransactionAddress({ serializedTransaction: raw as never })
    ).toLowerCase() as Address;
    const hash = keccak256(raw);
    if (this.known.has(hash) || this.receipts.has(hash)) throw new Error('already known');
    const nonce = parsed.nonce as number;
    if (nonce < (this.nonces.get(from) ?? 0)) throw new Error('nonce too low');
    const tx: PoolTx = {
      hash,
      raw,
      from,
      nonce,
      to: (parsed.to as Address).toLowerCase() as Address,
      data: parsed.data as Hex,
      gas: parsed.gas as bigint,
      maxFeePerGas: parsed.maxFeePerGas as bigint,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas as bigint,
    };
    const slot = `${from}:${nonce}`;
    const existing = this.pool.get(slot);
    if (existing) {
      const bumped = (x: bigint) => (x * 110n) / 100n;
      if (
        tx.maxFeePerGas < bumped(existing.maxFeePerGas) ||
        tx.maxPriorityFeePerGas < bumped(existing.maxPriorityFeePerGas)
      ) {
        throw new Error('replacement transaction underpriced');
      }
      this.known.delete(existing.hash);
    }
    this.pool.set(slot, tx);
    this.known.set(hash, tx);
    this.sent.push(tx);
    if (this.automine) this.mine();
    return hash;
  }

  private async request(method: string, params: unknown[]): Promise<unknown> {
    const failures = this.failNext.get(method) ?? 0;
    if (failures > 0) {
      this.failNext.set(method, failures - 1);
      throw new Error(`fake RPC failure: ${method}`);
    }
    switch (method) {
      case 'eth_chainId':
        return toHex(this.chainId);
      case 'eth_blockNumber':
        return toHex(this.block);
      case 'eth_getBlockByNumber': {
        const tag = params[0] as string;
        // The head is "now" on the chain's clock; older blocks keep the time they were mined at.
        if (tag === 'latest' || tag === 'pending') {
          return { ...this.blockObject(this.block), timestamp: toHex(this.time) };
        }
        return this.blockObject(BigInt(tag));
      }
      case 'eth_maxPriorityFeePerGas':
        return toHex(this.tip);
      case 'eth_gasPrice':
        return toHex(this.baseFee + this.tip);
      case 'eth_getTransactionCount': {
        const from = (params[0] as string).toLowerCase();
        const mined = this.nonces.get(from) ?? 0;
        if (params[1] !== 'pending') return toHex(mined);
        let n = mined;
        while (this.pool.has(`${from}:${n}`)) n += 1;
        return toHex(n);
      }
      case 'eth_getCode':
        return this.code.get((params[0] as string).toLowerCase()) ?? '0x';
      case 'eth_sendRawTransaction':
        return this.sendRaw(params[0] as Hex);
      case 'eth_getTransactionByHash': {
        const tx = this.known.get(params[0] as Hex);
        return tx ? this.txObject(tx) : null;
      }
      case 'eth_getTransactionReceipt':
        return this.receipts.get(params[0] as Hex) ?? null;
      case 'eth_estimateGas': {
        const { to, data } = params[0] as { to: Address; data: Hex };
        this.apply(to, data, false);
        return toHex(200_000);
      }
      case 'eth_call': {
        const { to, data } = params[0] as { to: Address; data: Hex };
        if (to.toLowerCase() !== FAKE_ANCHOR) throw new Error(`fake eth_call: ${to}`);
        const call = decodeFunctionData({ abi: flockedAnchorAbi, data });
        if (call.functionName !== 'getAnchor')
          throw new Error(`fake eth_call: ${call.functionName}`);
        return encodeFunctionResult({
          abi: flockedAnchorAbi,
          functionName: 'getAnchor',
          result: this.anchorOf(call.args[0]),
        });
      }
      default:
        throw new Error(`fake RPC: ${method} not supported`);
    }
  }
}
