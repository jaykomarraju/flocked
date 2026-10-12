// Viewer shards (spec "Non-functional requirements" › Scaling notes: WebSocket fan-out). Each round's
// viewers are spread over N RoundViewerDO instances, named `<roundId>/<shard>`: a connection goes to
// shard hash(connection ID) mod N, and the RoundDO's broadcasts go to all N (src/ws/hub.ts).
//
// N comes from the `WS_VIEWER_SHARDS` var (16 when unset). The Worker and the RoundDO read the same
// var in one deployment, and a deploy drops every socket, so a change of N never strands a viewer.
import type { ViewerSubscription } from '../do/types.js';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';

export const DEFAULT_VIEWER_SHARDS = 16;
/** Upper bound on N: each broadcast is one RPC per shard. */
export const MAX_VIEWER_SHARDS = 256;

/** `Env` plus the shard-count var (W7-D adds it to src/env.ts and wrangler.jsonc). */
type ShardEnv = Env & { WS_VIEWER_SHARDS?: string };

let warned = false;

/** N: `WS_VIEWER_SHARDS` (an integer 1 to 256), or 16 when unset or invalid (logged once). */
export function viewerShardCount(env: Env): number {
  const raw = (env as ShardEnv).WS_VIEWER_SHARDS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_VIEWER_SHARDS;
  const n = Number(raw);
  if (/^[0-9]+$/.test(raw) && n >= 1 && n <= MAX_VIEWER_SHARDS) return n;
  if (!warned) {
    warned = true;
    log.warn('ws_shard_count_invalid', { value: raw, used: DEFAULT_VIEWER_SHARDS });
  }
  return DEFAULT_VIEWER_SHARDS;
}

/** 32-bit FNV-1a over the string's UTF-16 code units. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The shard a connection belongs to: hash(connection ID) mod N. */
export function shardOf(connId: string, shardCount: number): number {
  return fnv1a(connId) % shardCount;
}

/** The Durable Object name of one shard of a round. */
export const shardName = (roundId: string, shard: number): string => `${roundId}/${shard}`;

export function viewerStub(env: Env, roundId: string, shard: number) {
  return env.ROUND_VIEWER.get(env.ROUND_VIEWER.idFromName(shardName(roundId, shard)));
}

/** The header the Worker sets on the upgrade it forwards to a shard: a `ViewerConnect` as JSON. */
export const VIEWER_HEADER = 'X-Flocked-Viewer';

export interface ViewerConnect extends ViewerSubscription {
  connId: string;
}
