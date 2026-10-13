// WebSocket test helpers (W7-A): viewers connected through the real app (session middleware, the
// room-round gate, the upgrade route) to the RoundViewerDO shards; every message they receive is
// parsed with the wire schema, which refuses a `state` result without `revealedAt`. Rounds are the
// RoundDO test rounds (test/round-do/helpers.ts) unless a test seeds its own.
import { env, runInDurableObject } from 'cloudflare:test';
import { API_BASE_PATH, WsServerMessageSchema, type WsServerMessage } from '@flocked/shared';
import { bytesToHex, type Hex } from 'viem';
import { vi } from 'vitest';
import { app } from '../../src/app.js';
import type { RoundDO } from '../../src/do/round-do.js';
import { SNAPSHOT_TTL_MS } from '../../src/do/round-viewer-do.js';
import type { StakesEntryEvent } from '../../src/do/types.js';
import type { Env } from '../../src/env.js';
import { whenIdle, type FanoutResult } from '../../src/ws/hub.js';

export const ORIGIN = 'https://flocked.test';

export type MessageOf<T extends WsServerMessage['type']> = Extract<WsServerMessage, { type: T }>;

export interface Viewer {
  ws: WebSocket;
  /** Every message received, parsed, in order. */
  messages: WsServerMessage[];
  /** Wall time (ms) each message arrived. */
  times: number[];
  closed: boolean;
  /** "pong" answers to "ping" (not JSON). */
  pongs: number;
  of<T extends WsServerMessage['type']>(type: T): MessageOf<T>[];
}

export interface Upgrade {
  status: number;
  /** The error envelope when the upgrade was refused. */
  json: unknown;
  viewer: Viewer | null;
}

/** GET /rounds/:id/ws with `Upgrade: websocket` through the real app; accepts the socket on 101. */
export async function upgrade(
  roundId: string,
  headers: Record<string, string> = {},
  e: Env = env,
): Promise<Upgrade> {
  const res = await app.request(
    `${ORIGIN}${API_BASE_PATH}/rounds/${roundId}/ws`,
    { headers: { Upgrade: 'websocket', ...headers } },
    e,
  );
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) {
    return {
      status: res.status,
      json: await res.json<unknown>().catch(() => null),
      viewer: null,
    };
  }
  const v: Viewer = {
    ws,
    messages: [],
    times: [],
    closed: false,
    pongs: 0,
    of: <T extends WsServerMessage['type']>(type: T) =>
      v.messages.filter((m): m is MessageOf<T> => m.type === type),
  };
  ws.addEventListener('message', (ev) => {
    if (ev.data === 'pong') {
      v.pongs += 1;
      return;
    }
    v.messages.push(WsServerMessageSchema.parse(JSON.parse(ev.data as string)));
    v.times.push(Date.now());
  });
  ws.addEventListener('close', () => {
    v.closed = true;
  });
  ws.accept();
  return { status: 101, json: null, viewer: v };
}

/** A connected viewer (fails the test otherwise), once its `state` has arrived. */
export async function connect(
  roundId: string,
  headers: Record<string, string> = {},
  e: Env = env,
): Promise<Viewer> {
  const u = await upgrade(roundId, headers, e);
  if (!u.viewer) throw new Error(`upgrade answered ${u.status}: ${JSON.stringify(u.json)}`);
  const v = u.viewer;
  await until(() => v.messages.length > 0);
  return v;
}

/** The viewer's first message, which is always its `state`. */
export function stateOf(v: Viewer): MessageOf<'state'> {
  const s = v.messages[0];
  if (s?.type !== 'state') throw new Error(`first message is ${s?.type ?? 'missing'}`);
  return s;
}

/** Connects, takes the `state`, and disconnects. */
export async function snapshot(roundId: string, headers: Record<string, string> = {}) {
  const v = await connect(roundId, headers);
  await closeAll([v]);
  return stateOf(v);
}

/**
 * A snapshot after a D1 change that sent no message: waits out every shard's kept snapshot first,
 * since a new connection may land on the shard of an earlier one (W7-Z: a 1-in-16 flake).
 */
export async function freshSnapshot(roundId: string, headers: Record<string, string> = {}) {
  await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_TTL_MS + 100));
  return snapshot(roundId, headers);
}

/** Waits (polling, up to `timeout` ms) until `cond` holds. */
export async function until(cond: () => boolean, timeout = 5_000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!cond()) throw new Error('not yet');
    },
    { timeout, interval: 10 },
  );
}

/** Waits until the round's hub has sent everything it holds; returns those fan-outs. */
export function hubIdle(
  stub: DurableObjectStub<RoundDO>,
  roundId: string,
): Promise<FanoutResult[]> {
  return runInDurableObject(stub, () => whenIdle(roundId));
}

const randomHex = (bytes: number): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

let block = 100;

/** One mirrored `Entered` for a RoundDO test round (chain round ID '1', 5 USDC). */
export function enteredEvent(roundId: string): StakesEntryEvent {
  block += 1;
  return {
    roundId,
    chainRoundId: '1',
    player: randomHex(20),
    personTag: randomHex(32),
    ticketHash: randomHex(32),
    stake: '5000000',
    commitment: randomHex(32),
    userId: null,
    txHash: randomHex(32),
    blockNumber: block,
    logIndex: 0,
    blockTimestampSec: 1_760_000_000 + block,
  };
}

/** Closes the viewers and waits for each close handshake (the shard answers from webSocketClose). */
export async function closeAll(viewers: readonly Viewer[]): Promise<void> {
  for (const v of viewers) if (!v.closed) v.ws.close(1000, 'done');
  await until(() => viewers.every((v) => v.closed));
}
