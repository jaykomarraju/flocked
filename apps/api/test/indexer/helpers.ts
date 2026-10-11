// Indexer test helpers: a scripted chain behind the IndexerRpc interface (blocks, logs, reorgs, a
// provider log-range limit, outages), real ABI encoding for FlockedEscrow and FlockedAnchor events, and
// alert capture from the structured log.
import { env } from 'cloudflare:test';
import { flockedAnchorAbi, flockedEscrowAbi } from '@flocked/abi';
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type Abi,
  type AbiEvent,
  type Hex,
} from 'viem';
import { vi } from 'vitest';
import { indexerConfig } from '../../src/indexer/config.js';
import type {
  IndexerRpc,
  IndexerTarget,
  RpcBlock,
  RpcLog,
  RpcTransaction,
} from '../../src/indexer/types.js';

export const EOA = '0x00000000000000000000000000000000000000e0' as Hex;

export interface PendingLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  txHash?: Hex;
}

interface FakeBlock extends RpcBlock {
  logs: RpcLog[];
}

/** A chain the tests script block by block. Block 0 exists from the start. */
export class FakeChain implements IndexerRpc {
  readonly blocks: FakeBlock[] = [];
  readonly txs = new Map<string, RpcTransaction>();
  readonly logCalls: [number, number][] = [];
  /** Largest eth_getLogs range the "provider" accepts; null for any. */
  maxLogRange: number | null = null;
  /** When set, every call rejects with it. */
  down: Error | null = null;
  /** Whether logs carry blockTimestamp (some providers add it). */
  logTimestamps = false;
  private branch = 0;
  private txCounter = 0;

  constructor(
    private readonly startTimestamp = 1_800_000_000,
    private readonly blockTime = 2,
  ) {
    this.mine();
  }

  get headNumber(): number {
    return this.blocks.length - 1;
  }

  newTxHash(): Hex {
    return keccak256(toHex(`tx:${this.txCounter++}:${Math.random()}`));
  }

  /** Mines one block with `logs` (each its own transaction unless txHash is given). */
  mine(
    logs: PendingLog[] = [],
    opts: { from?: Hex; to?: Hex | null; gapSec?: number } = {},
  ): FakeBlock {
    const number = this.blocks.length;
    const prev = this.blocks[number - 1];
    const timestamp = prev ? prev.timestamp + (opts.gapSec ?? this.blockTime) : this.startTimestamp;
    const hash = keccak256(toHex(`block:${number}:${this.branch}:${prev?.hash ?? ''}`));
    const block: FakeBlock = { number, hash, timestamp, logs: [] };
    logs.forEach((l, i) => {
      const txHash = l.txHash ?? this.newTxHash();
      if (!this.txs.has(txHash)) {
        this.txs.set(txHash, {
          from: opts.from ?? EOA,
          to: opts.to === undefined ? (l.address.toLowerCase() as Hex) : opts.to,
        });
      }
      block.logs.push({
        address: l.address.toLowerCase() as Hex,
        blockNumber: number,
        blockHash: hash,
        transactionHash: txHash,
        logIndex: i,
        topics: l.topics,
        data: l.data,
        ...(this.logTimestamps ? { blockTimestamp: timestamp } : {}),
      });
    });
    this.blocks.push(block);
    return block;
  }

  mineEmpty(n: number): void {
    for (let i = 0; i < n; i++) this.mine();
  }

  /** Drops the last `depth` blocks; blocks mined next form a new branch (new hashes). */
  reorg(depth: number): void {
    this.blocks.splice(this.blocks.length - depth);
    this.branch++;
  }

  private check(): void {
    if (this.down) throw this.down;
  }

  head(): Promise<RpcBlock> {
    this.check();
    const b = this.blocks[this.blocks.length - 1]!;
    return Promise.resolve({ number: b.number, hash: b.hash, timestamp: b.timestamp });
  }

  block(n: number): Promise<RpcBlock | null> {
    this.check();
    const b = this.blocks[n];
    return Promise.resolve(b ? { number: b.number, hash: b.hash, timestamp: b.timestamp } : null);
  }

  logs(address: Hex, from: number, to: number): Promise<RpcLog[]> {
    this.check();
    this.logCalls.push([from, to]);
    if (this.maxLogRange !== null && to - from + 1 > this.maxLogRange) {
      return Promise.reject(
        new Error(`exceed maximum block range: ${this.maxLogRange}`, {
          cause: { code: -32602 },
        }),
      );
    }
    return Promise.resolve(
      this.blocks
        .slice(from, to + 1)
        .flatMap((b) => b.logs)
        .filter((l) => l.address === address.toLowerCase()),
    );
  }

  transaction(hash: Hex): Promise<RpcTransaction | null> {
    this.check();
    return Promise.resolve(this.txs.get(hash) ?? null);
  }
}

/** ABI-encodes one event as a log's topics and data. */
export function encodeEvent(abi: Abi, eventName: string, args: Record<string, unknown>) {
  const item = abi.find((x): x is AbiEvent => x.type === 'event' && x.name === eventName);
  if (!item) throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({
    abi: [item],
    eventName,
    args: args,
  }) as Hex[];
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = plain.length
    ? encodeAbiParameters(
        plain,
        plain.map((i) => args[i.name!]),
      )
    : '0x';
  return { topics, data };
}

/** A deployment for one test: fresh escrow and anchor addresses, deployBlock 1. */
export function useDeployment(seed: number, deployBlock = 1) {
  const pad = (tag: string) => `0x${tag}${seed.toString(16).padStart(40 - tag.length, '0')}` as Hex;
  const deployment = {
    escrow: pad('e5c0'),
    anchor: pad('a0c0'),
    usdc: pad('5dc0'),
    deployBlock,
  };
  const json = JSON.stringify(deployment);
  const cfg = indexerConfig({ CHAIN_ID: '31337', LOCAL_DEPLOYMENT: json });
  if (!cfg.ok) throw new Error(cfg.reason);
  // Each test indexes its own chain ID, so rows left pending by one test never reach another.
  return { ...deployment, json, targets: cfg.config.targets, chainId: 100_000 + seed };
}

export const escrowEvent = (address: Hex, name: string, args: Record<string, unknown>) => ({
  address,
  ...encodeEvent(flockedEscrowAbi, name, args),
});
export const anchorEvent = (address: Hex, name: string, args: Record<string, unknown>) => ({
  address,
  ...encodeEvent(flockedAnchorAbi, name, args),
});

export const hash32 = (s: string) => keccak256(toHex(s));

/** An anchor `Locked` log (a typical backend event). */
export const lockedLog = (anchor: Hex, i: number) =>
  anchorEvent(anchor, 'Locked', {
    roundKey: hash32(`round-key-${i}`),
    closesAt: 1_800_000_000n + BigInt(i),
    beaconRound: 1000n + BigInt(i),
    questionHash: hash32(`question-${i}`),
    configHash: hash32(`config-${i}`),
  });

export interface CapturedAlert {
  code: string;
  [k: string]: unknown;
}

/** Captures alerts (structured `alert` log lines) until restored. */
export function captureAlerts(): { alerts: CapturedAlert[]; restore: () => void } {
  const alerts: CapturedAlert[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    if (typeof line !== 'string') return;
    try {
      const o = JSON.parse(line) as { event?: string; code?: string };
      if (o.event === 'alert' && typeof o.code === 'string') alerts.push(o as CapturedAlert);
    } catch {
      // not a structured line
    }
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { alerts, restore: () => spy.mockRestore() };
}

/** chain_events rows for one contract, in chain order. */
export async function storedEvents(chainId: number, contract: Hex) {
  const { results } = await env.DB.prepare(
    `SELECT block_number, block_hash, tx_hash, log_index, event, args_json, removed, revision,
            dispatched_revision
     FROM chain_events WHERE chain_id = ?1 AND contract = ?2 ORDER BY block_number, log_index`,
  )
    .bind(chainId, contract.toLowerCase())
    .all<{
      block_number: number;
      block_hash: string;
      tx_hash: string;
      log_index: number;
      event: string;
      args_json: string;
      removed: number;
      revision: number;
      dispatched_revision: number | null;
    }>();
  return results;
}

export type { IndexerTarget };
