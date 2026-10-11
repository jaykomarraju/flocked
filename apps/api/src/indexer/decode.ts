// Decodes a raw log against its contract's ABI into the `chain_events` shape. Values become JSON:
// uints as decimal strings (they can exceed 2^53), bytes and addresses as lowercase 0x hex, structs as
// objects. A log whose topic matches no ABI event is kept as event 'unknown' with its raw topics and data.
import { decodeEventLog, type Abi } from 'viem';
import type { RpcLog } from './types.js';

export interface DecodedLog {
  event: string;
  args: Record<string, unknown>;
}

export const UNKNOWN_EVENT = 'unknown';

function toJsonValue(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(toJsonValue);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJsonValue(x)]));
  }
  return v;
}

export function decodeLog(abi: Abi, log: RpcLog): DecodedLog {
  try {
    const d = decodeEventLog({
      abi,
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    const args = Array.isArray(d.args)
      ? Object.fromEntries((d.args as unknown[]).map((x, i) => [String(i), toJsonValue(x)]))
      : (toJsonValue(d.args ?? {}) as Record<string, unknown>);
    return { event: d.eventName ?? UNKNOWN_EVENT, args };
  } catch {
    return { event: UNKNOWN_EVENT, args: { topics: log.topics, data: log.data } };
  }
}

/** The args_json text. Key order follows the ABI, so a re-decoded log compares equal. */
export function argsJson(args: Record<string, unknown>): string {
  return JSON.stringify(args);
}
