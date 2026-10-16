// The broadcast side of the WebSocket hub, inside the RoundDO (spec "Real-time and the reveal":
// "broadcast counter updates at most once per second, coalesced"). The RoundDO hands each message
// to `broadcast()` (src/rounds/hooks.ts), which lands here:
//   - every message is checked against the wire schema first, and one that fails is dropped;
//   - `counts` is coalesced to at most one per second per round, leading and trailing edge: the
//     first goes out at once, later ones within the second replace each other, and the last is sent
//     when the second is up, so the final count always arrives;
//   - each message goes to every viewer shard (src/ws/shards.ts) on one promise chain per round, so
//     messages arrive in the order the RoundDO sent them. A shard that fails gets an event message
//     once more; a lost `counts` is superseded by the next one or a reconnect's snapshot.
//   - each shard call has `SHARD_RPC_TIMEOUT_MS` to answer, and a timed-out call counts as failed,
//     so a hung shard delays the round's later messages by at most two timeouts (W7-F1 R5).
// The chain never rejects (a step that throws is logged and the chain goes on) and is held by the
// hub (no floating promise): tests await `whenIdle`.
//
// One hub per round in the RoundDO's isolate. Coalescing uses wall time, not the game clock, which
// tests and the local stack pin (src/lib/clock.ts).
import { WsServerMessageSchema, type WsServerMessage } from '@flocked/shared';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { viewerShardCount, viewerStub } from './shards.js';

/** At most one `counts` per round per this many ms. */
export const COUNTS_INTERVAL_MS = 1000;

/** How long one shard's `broadcast` may take before it counts as failed. */
export const SHARD_RPC_TIMEOUT_MS = 5_000;

let shardRpcTimeoutMs = SHARD_RPC_TIMEOUT_MS;

/** Tests only: a shorter per-shard timeout; no argument restores `SHARD_RPC_TIMEOUT_MS`. */
export function setShardRpcTimeoutForTests(ms: number = SHARD_RPC_TIMEOUT_MS): void {
  shardRpcTimeoutMs = ms;
}

/** `call`, or a rejection once `ms` have passed without an answer. */
async function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface FanoutResult {
  type: WsServerMessage['type'];
  /** Sockets reached, over every shard. */
  delivered: number;
  /** Shards that still failed after the retry (events) or the one try (counts). */
  failedShards: number;
  /** Wall time (ms) the hub released the message to the chain: `counts` are spaced by this. */
  releasedAt: number;
}

/** Sends one message to every shard; never rejects. */
async function fanOut(
  env: Env,
  roundId: string,
  message: WsServerMessage,
): Promise<Omit<FanoutResult, 'releasedAt'>> {
  const n = viewerShardCount(env);
  const send = (shard: number) =>
    withTimeout(
      Promise.resolve(viewerStub(env, roundId, shard).broadcast(message)),
      shardRpcTimeoutMs,
    );
  let pending = Array.from({ length: n }, (_, i) => i);
  let delivered = 0;
  const tries = message.type === 'counts' ? 1 : 2;
  let lastError = '';
  for (let attempt = 0; attempt < tries && pending.length > 0; attempt++) {
    const settled = await Promise.allSettled(pending.map(send));
    const failed: number[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') delivered += s.value.delivered;
      else {
        failed.push(pending[i] as number);
        lastError = String(s.reason);
      }
    });
    pending = failed;
  }
  if (pending.length > 0) {
    log.error('ws_fanout_failed', {
      roundId,
      type: message.type,
      shards: pending,
      error: lastError,
    });
  }
  return { type: message.type, delivered, failedShards: pending.length };
}

class RoundHub {
  /** The fan-out chain: every message waits for the one before it. Never rejects. */
  private tail: Promise<unknown> = Promise.resolve();
  private lastCountsAt = Number.NEGATIVE_INFINITY;
  private pendingCounts: WsServerMessage | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Results of the fan-outs since the last `whenIdle` (tests read them). */
  private results: FanoutResult[] = [];
  /** Wall time of the last activity, for pruning idle hubs. */
  lastActive = Date.now();

  constructor(
    private readonly env: Env,
    private readonly roundId: string,
  ) {}

  send(message: WsServerMessage): void {
    this.lastActive = Date.now();
    if (message.type === 'counts') {
      this.pendingCounts = message;
      if (this.timer) return;
      const wait = this.lastCountsAt + COUNTS_INTERVAL_MS - Date.now();
      if (wait <= 0) this.flushCounts();
      else this.timer = setTimeout(() => this.flushCounts(), wait);
      return;
    }
    this.enqueue(message);
  }

  /** Idle: no `counts` waiting and the chain drained. Returns the fan-outs since the last call. */
  async whenIdle(): Promise<FanoutResult[]> {
    for (;;) {
      const tail = this.tail;
      await tail;
      if (!this.timer && !this.pendingCounts && tail === this.tail) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const out = this.results;
    this.results = [];
    return out;
  }

  get idle(): boolean {
    return !this.timer && !this.pendingCounts && Date.now() - this.lastActive > 60_000;
  }

  private flushCounts(): void {
    this.timer = null;
    const m = this.pendingCounts;
    if (!m) return;
    this.pendingCounts = null;
    this.lastCountsAt = Date.now();
    this.enqueue(m);
  }

  private enqueue(message: WsServerMessage): void {
    const releasedAt = Date.now();
    this.tail = this.tail
      .then(async () => {
        const r = await fanOut(this.env, this.roundId, message);
        this.results.push({ ...r, releasedAt });
        this.lastActive = Date.now();
      })
      .catch((err: unknown) => {
        // A step that throws loses this message only; the round's later messages still go out.
        log.error('ws_fanout_chain_failed', {
          roundId: this.roundId,
          type: message.type,
          error: String(err),
        });
      });
  }
}

const hubs = new Map<string, RoundHub>();

function hubFor(env: Env, roundId: string): RoundHub {
  let hub = hubs.get(roundId);
  if (!hub) {
    // A RoundDO isolate may host many rounds over its life: drop hubs idle for a minute.
    for (const [id, h] of hubs) if (h.idle) hubs.delete(id);
    hub = new RoundHub(env, roundId);
    hubs.set(roundId, hub);
  }
  return hub;
}

/** Hands one message to the round's viewers (coalesced for `counts`); returns at once. */
export function publish(env: Env, roundId: string, message: WsServerMessage): void {
  const parsed = WsServerMessageSchema.safeParse(message);
  if (!parsed.success || parsed.data.roundId !== roundId) {
    log.error('ws_message_invalid', {
      roundId,
      type: message.type,
      error: parsed.success ? 'roundId mismatch' : parsed.error.message,
    });
    return;
  }
  hubFor(env, roundId).send(parsed.data);
}

/** Resolves once the round's hub has sent everything it holds (tests, from inside the RoundDO). */
export function whenIdle(roundId: string): Promise<FanoutResult[]> {
  return hubs.get(roundId)?.whenIdle() ?? Promise.resolve([]);
}
