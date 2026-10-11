// Chain indexer types (spec "Architecture": Chain indexer). The indexer mirrors every FlockedEscrow and
// FlockedAnchor log into `chain_events` and hands each one to the handlers registered for its event
// name (src/indexer/handlers.ts).
import type { Abi, Hex } from 'viem';
import type { Env } from '../env.js';

export type ContractKind = 'escrow' | 'anchor';

/** One contract the indexer follows. */
export interface IndexerTarget {
  kind: ContractKind;
  /** Lowercase. */
  address: Hex;
  abi: Abi;
  /** First block to scan (the deployment's `deployBlock`). */
  startBlock: number;
}

/** What the indexer reads from the environment (a subset of Env, so tests and e2e can build one). */
export type IndexerEnv = Pick<
  Env,
  | 'DB'
  | 'ANALYTICS'
  | 'ENVIRONMENT'
  | 'CHAIN_ID'
  | 'LOCAL_DEPLOYMENT'
  | 'BASE_RPC_URL'
  | 'BASE_RPC_URL_FALLBACK'
  | 'FLOCKED_TEST_CLOCK'
>;

export interface RpcBlock {
  number: number;
  /** Lowercase. */
  hash: Hex;
  /** Unix seconds. */
  timestamp: number;
}

export interface RpcLog {
  /** Lowercase. */
  address: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  topics: Hex[];
  data: Hex;
  /** Unix seconds, when the provider includes it in the log. */
  blockTimestamp?: number;
}

export interface RpcTransaction {
  from: Hex;
  /** null for a contract-creation transaction. */
  to: Hex | null;
}

/** The RPC calls the indexer makes (src/indexer/rpc.ts implements them with viem). */
export interface IndexerRpc {
  head(): Promise<RpcBlock>;
  /** null when the provider has no block at that height. */
  block(number: number): Promise<RpcBlock | null>;
  logs(address: Hex, fromBlock: number, toBlock: number): Promise<RpcLog[]>;
  transaction(hash: Hex): Promise<RpcTransaction | null>;
}

/** One mirrored log as handlers see it. */
export interface ChainEvent {
  chainId: number;
  /** Lowercase. */
  contract: Hex;
  /** null when the address is not one of the current deployment's contracts. */
  contractKind: ContractKind | null;
  blockNumber: number;
  blockHash: Hex;
  blockTimestampSec: number;
  txHash: Hex;
  logIndex: number;
  /** ABI event name, or 'unknown'. */
  event: string;
  /** Decoded arguments: uints as decimal strings, bytes and addresses as lowercase 0x hex. */
  args: Record<string, unknown>;
  /** True when the log has left the canonical chain (a reorg); handlers undo what they can. */
  removed: boolean;
  /** Bumped on each change handlers must see; each handler sees each revision once. */
  revision: number;
}

/** Extra context the dispatcher passes to handlers (the pinned shape is `handler(evt, env)`). */
export interface HandlerContext {
  rpc: IndexerRpc;
}

/**
 * An event handler. It may return D1 statements: they commit in one batch with the record that this
 * handler saw this revision, so a replay never applies them twice. Side effects outside D1 (DO calls,
 * alerts) run at least once and must be idempotent by (txHash, logIndex).
 */
export type EventHandler = (
  evt: ChainEvent,
  env: Env,
  ctx: HandlerContext,
) => Promise<D1PreparedStatement[] | void>;
