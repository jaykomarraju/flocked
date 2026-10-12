// RoundViewerDO: one WebSocket fan-out shard of a round (spec "Non-functional requirements" › Scaling
// notes: viewers are sharded over N RoundViewerDO instances, N = 16 by default; src/ws/shards.ts).
// W7-A.
//
//   - fetch: the Worker forwards a checked upgrade (src/ws/upgrade.ts) with the subscription in the
//     `X-Flocked-Viewer` header. The shard accepts the socket with the Hibernation API (its state
//     is in the socket's attachment, so nothing is lost when the shard sleeps), then sends `state`
//     and catches the socket up (below). Every reconnect is a new connection, so it gets a fresh
//     `state`.
//   - subscribe: binds the shard to its round and returns the snapshot (src/ws/snapshot.ts). The
//     snapshot is kept for up to a second and patched by `counts`, and any other message drops it,
//     so a reconnect storm costs each shard at most one D1 read a second.
//   - broadcast: relays one message (checked against the wire schema) to every open socket and
//     returns how many it reached; a socket whose send fails is closed.
//
// Catch-up: a message relayed while a new socket's snapshot was being read, or relayed in the last
// 30 s but not yet visible in D1 (the Stakes indexer tells the RoundDO before it writes D1), is sent
// after `state`, in order. Every replayed message has already gone to every viewer.
//
// Clients send nothing (the spec defines no client messages) except an optional "ping", which the
// runtime answers "pong" without waking the shard.
import { DurableObject } from 'cloudflare:workers';
import {
  ERROR_STATUS,
  UlidSchema,
  WsServerMessageSchema,
  errorEnvelope,
  type ErrorCode,
  type WsCountsMessage,
  type WsServerMessage,
  type WsStateMessage,
} from '@flocked/shared';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';
import { VIEWER_HEADER, type ViewerConnect } from '../ws/shards.js';
import { roundSnapshot } from '../ws/snapshot.js';
import type { RoundViewerDORpc, ViewerSubscription } from './types.js';

/** What each socket carries through hibernation. */
interface Attachment {
  connId: string;
  shard: number;
  membersOnly: boolean;
  connectedAt: number;
}

/** How long a snapshot is reused (counts are patched in; any other message drops it). */
export const SNAPSHOT_TTL_MS = 1000;
/** How long a relayed event is kept for catching up new sockets. */
export const REPLAY_WINDOW_MS = 30_000;
const REPLAY_MAX = 32;

type Event = Exclude<WsServerMessage, { type: 'state' | 'counts' }>;
interface Relayed<T> {
  seq: number;
  at: number;
  message: T;
}

function withCounts(s: WsStateMessage, c: WsCountsMessage): WsStateMessage {
  const modes = { ...s.modes };
  for (const mode of ['free', 'stakes'] as const) {
    const m = modes[mode];
    const n = c.modes[mode];
    if (m && n) modes[mode] = { ...m, entrantCount: n.entrantCount, pool: n.pool };
  }
  return { ...s, modes };
}

/** True when the snapshot already shows what the event says. */
function reflected(s: WsStateMessage, e: Event): boolean {
  if (e.type === 'closed') return s.status === 'closed';
  const m = s.modes[e.mode];
  if (!m) return true;
  switch (e.type) {
    case 'revealing':
      return m.status !== 'pending';
    case 'revealed':
      return m.result !== null;
    case 'refunded':
      return m.status === 'refund_proposed' || m.status === 'refunded' || m.status === 'voided';
  }
}

function parseConnect(raw: string | null): ViewerConnect | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<ViewerConnect>;
    if (
      typeof c.connId === 'string' &&
      typeof c.roundId === 'string' &&
      typeof c.shard === 'number' &&
      typeof c.shardCount === 'number' &&
      typeof c.membersOnly === 'boolean'
    ) {
      return c as ViewerConnect;
    }
  } catch {
    // fall through
  }
  return null;
}

const errorJson = (code: ErrorCode, message: string) =>
  Response.json(errorEnvelope(code, message), { status: ERROR_STATUS[code] });

export class RoundViewerDO extends DurableObject<Env> implements RoundViewerDORpc {
  private sub: ViewerSubscription | null = null;
  /** Messages relayed by this instance, in order. */
  private seq = 0;
  /** Non-counts messages relayed by this instance (a snapshot read across one isn't kept). */
  private events = 0;
  private recent: Relayed<Event>[] = [];
  private lastCounts: Relayed<WsCountsMessage> | null = null;
  private cache: { snapshot: WsStateMessage; at: number } | null = null;
  private loading: Promise<WsStateMessage> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---- RPC ---------------------------------------------------------------------------------

  async subscribe(sub: ViewerSubscription): Promise<WsStateMessage> {
    if (
      !UlidSchema.safeParse(sub.roundId).success ||
      !Number.isInteger(sub.shard) ||
      sub.shard < 0 ||
      sub.shard >= sub.shardCount
    ) {
      throw new RangeError('subscribe: invalid subscription');
    }
    if (this.sub && this.sub.roundId !== sub.roundId) {
      throw new RangeError('subscribe: this shard serves another round');
    }
    this.sub = sub;
    return { ...(await this.snapshot(sub.roundId)), serverTime: now(this.env) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- RPC methods are async
  async broadcast(message: WsServerMessage): Promise<{ delivered: number }> {
    const parsed = WsServerMessageSchema.safeParse(message);
    if (!parsed.success || parsed.data.type === 'state') {
      log.error('ws_relay_refused', {
        type: message.type,
        error: parsed.success ? 'state is per connection' : parsed.error.message,
      });
      return { delivered: 0 };
    }
    const m = parsed.data;
    this.record(m);
    const data = JSON.stringify(m);
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(data);
        delivered += 1;
      } catch (err) {
        this.drop(ws, 'send failed', err);
      }
    }
    return { delivered };
  }

  // ---- WebSockets --------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return errorJson('bad_request', 'Expected a WebSocket upgrade');
    }
    const conn = parseConnect(request.headers.get(VIEWER_HEADER));
    if (!conn) return errorJson('bad_request', 'Missing viewer subscription');
    const from = this.seq;
    let state: WsStateMessage;
    try {
      state = await this.subscribe(conn);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (text.startsWith('not_found')) return errorJson('not_found', 'No such round');
      log.error('ws_snapshot_failed', { roundId: conn.roundId, error: text });
      return errorJson('unavailable', 'Try again shortly');
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // No await from here to the end: a broadcast can't slip in between `state` and the catch-up.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      connId: conn.connId,
      shard: conn.shard,
      membersOnly: conn.membersOnly,
      connectedAt: Date.now(),
    } satisfies Attachment);
    server.send(JSON.stringify(state));
    for (const m of this.catchUp(state, from)) server.send(JSON.stringify(m));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(): void {
    // The spec defines no client-to-server messages; "ping" is answered by the runtime.
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    this.drop(ws, 'socket error', error);
  }

  // ---- Internals ---------------------------------------------------------------------------

  private drop(ws: WebSocket, why: string, err: unknown): void {
    const a = ws.deserializeAttachment() as Attachment | null;
    log.warn('ws_socket_dropped', { connId: a?.connId ?? null, why, error: String(err) });
    try {
      ws.close(1011, why);
    } catch {
      // already closed
    }
  }

  /** The round's snapshot: the kept one while fresh, else one D1 read shared by every caller. */
  private snapshot(roundId: string): Promise<WsStateMessage> {
    const c = this.cache;
    if (c && Date.now() - c.at < SNAPSHOT_TTL_MS) return Promise.resolve(c.snapshot);
    if (this.loading) return this.loading;
    const seq = this.seq;
    const events = this.events;
    const loading = roundSnapshot(this.env, roundId)
      .then((s) => {
        if (!s) throw new Error('not_found: no such locked round');
        // Counts relayed during the read are at least as new as the read's.
        const counts = this.lastCounts;
        const snapshot = counts && counts.seq > seq ? withCounts(s, counts.message) : s;
        // An event relayed during the read may not be in it: don't keep it for later callers.
        if (this.events === events) this.cache = { snapshot, at: Date.now() };
        return snapshot;
      })
      .finally(() => {
        if (this.loading === loading) this.loading = null;
      });
    this.loading = loading;
    return loading;
  }

  private record(m: Exclude<WsServerMessage, { type: 'state' }>): void {
    this.seq += 1;
    const t = Date.now();
    if (m.type === 'counts') {
      this.lastCounts = { seq: this.seq, at: t, message: m };
      if (this.cache) this.cache = { ...this.cache, snapshot: withCounts(this.cache.snapshot, m) };
      return;
    }
    this.events += 1;
    this.cache = null;
    this.recent = this.recent.filter((r) => t - r.at < REPLAY_WINDOW_MS).slice(1 - REPLAY_MAX);
    this.recent.push({ seq: this.seq, at: t, message: m });
  }

  /**
   * What a new socket needs after `state`, in relay order: events from the replay window that the
   * snapshot doesn't show yet, and the latest `counts` if it was relayed during the snapshot read.
   */
  private catchUp(state: WsStateMessage, from: number): WsServerMessage[] {
    const t = Date.now();
    const out: Relayed<WsServerMessage>[] = this.recent.filter(
      (r) => t - r.at < REPLAY_WINDOW_MS && !reflected(state, r.message),
    );
    if (this.lastCounts && this.lastCounts.seq > from) out.push(this.lastCounts);
    return out.sort((a, b) => a.seq - b.seq).map((r) => r.message);
  }
}
