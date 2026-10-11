// The indexer's RPC calls over viem, with BASE_RPC_URL first and BASE_RPC_URL_FALLBACK behind it.
// Locally both come from the stack (`e2e/stack/.dev.vars` points BASE_RPC_URL at anvil).
import {
  BlockNotFoundError,
  TransactionNotFoundError,
  createPublicClient,
  fallback,
  http,
  type Hex,
  type PublicClient,
} from 'viem';
import type { IndexerEnv, IndexerRpc, RpcBlock } from './types.js';

const lower = (h: Hex): Hex => h.toLowerCase() as Hex;

/** The configured RPC URLs, primary first; empty when none is set. */
export function rpcUrls(env: Pick<IndexerEnv, 'BASE_RPC_URL' | 'BASE_RPC_URL_FALLBACK'>): string[] {
  return [env.BASE_RPC_URL, env.BASE_RPC_URL_FALLBACK].filter(
    (u): u is string => typeof u === 'string' && u.trim() !== '',
  );
}

/** An IndexerRpc over viem, or null when no RPC URL is configured. */
export function viemIndexerRpc(
  env: Pick<IndexerEnv, 'BASE_RPC_URL' | 'BASE_RPC_URL_FALLBACK'>,
): IndexerRpc | null {
  const urls = rpcUrls(env);
  if (urls.length === 0) return null;
  const transports = urls.map((u) => http(u, { retryCount: 1, timeout: 10_000 }));
  const client: PublicClient = createPublicClient({
    transport: transports.length === 1 ? transports[0]! : fallback(transports),
  });
  const toBlock = (b: { number: bigint | null; hash: Hex | null; timestamp: bigint }): RpcBlock => {
    if (b.number === null || b.hash === null) throw new Error('rpc returned a pending block');
    return { number: Number(b.number), hash: lower(b.hash), timestamp: Number(b.timestamp) };
  };
  return {
    head: async () => toBlock(await client.getBlock({ blockTag: 'latest' })),
    block: async (n) => {
      try {
        return toBlock(await client.getBlock({ blockNumber: BigInt(n) }));
      } catch (err) {
        if (err instanceof BlockNotFoundError) return null;
        throw err;
      }
    },
    logs: async (address, fromBlock, toBlockNumber) => {
      const logs = await client.getLogs({
        address,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlockNumber),
      });
      return logs.flatMap((l) => {
        if (l.blockNumber === null || l.blockHash === null || l.logIndex === null) return [];
        if (l.transactionHash === null) return [];
        const ts = (l as { blockTimestamp?: unknown }).blockTimestamp;
        return [
          {
            address: lower(l.address),
            blockNumber: Number(l.blockNumber),
            blockHash: lower(l.blockHash),
            transactionHash: lower(l.transactionHash),
            logIndex: l.logIndex,
            topics: l.topics.map(lower),
            data: lower(l.data),
            ...(typeof ts === 'bigint' || typeof ts === 'number' || typeof ts === 'string'
              ? { blockTimestamp: Number(ts) }
              : {}),
          },
        ];
      });
    },
    transaction: async (hash) => {
      try {
        const tx = await client.getTransaction({ hash });
        return { from: lower(tx.from), to: tx.to ? lower(tx.to) : null };
      } catch (err) {
        if (err instanceof TransactionNotFoundError) return null;
        throw err;
      }
    },
  };
}

/** How providers word "this eth_getLogs query is too big" (block range or result count). */
const LOG_RANGE_ERROR =
  /block range|range (is )?too (large|wide|big)|maximum block range|more than [\d,]+ (results|logs)|response size|limited to a [\d,]+ (block )?range|query timeout/i;
const RATE_LIMITED = /rate.?limit|too many requests|\b429\b/i;

/**
 * True when an RPC error says the log query was too large, so a smaller range can succeed. A rate
 * limit is not a range error (halving would only add calls). JSON-RPC -32005 ("limit exceeded")
 * covers both, so it counts only when the message isn't about the rate.
 */
export function isLogRangeError(err: unknown): boolean {
  const parts: string[] = [];
  let code: unknown;
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (typeof e !== 'object') break;
    const o = e as { message?: unknown; details?: unknown; code?: unknown; cause?: unknown };
    if (typeof o.message === 'string') parts.push(o.message);
    if (typeof o.details === 'string') parts.push(o.details);
    if (code === undefined && o.code !== undefined) code = o.code;
    e = o.cause;
  }
  const text = parts.join(' | ');
  if (RATE_LIMITED.test(text)) return false;
  return code === -32005 || LOG_RANGE_ERROR.test(text);
}
