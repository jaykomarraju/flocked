// The round WebSocket (`GET /rounds/:id/ws`, W7-A): one socket per round, kept alive with "ping"
// (answered "pong"), reopened with jittered exponential backoff after any close. Messages that don't
// parse are dropped. The caller folds them into a LiveRound with `applyMessage` (ws/live.ts).
import { API_BASE_PATH, WsServerMessageSchema, type WsServerMessage } from '@flocked/shared';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RoundSocketOptions {
  roundId: string;
  onMessage: (msg: WsServerMessage) => void;
  onStatus?: (status: SocketStatus) => void;
  /** The page origin by default (the API Worker serves the app). */
  origin?: string;
  /** Injected in tests. */
  WebSocket?: typeof WebSocket;
  random?: () => number;
  /** Keep-alive interval (ms). */
  pingMs?: number;
}

export const PING_MS = 25_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** The wait before reconnect attempt `attempt` (0-based): full jitter over a doubling ceiling. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export function roundSocketUrl(roundId: string, origin: string): string {
  const url = new URL(`${API_BASE_PATH}/rounds/${encodeURIComponent(roundId)}/ws`, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Opens the round's socket and keeps it open until `close()`. */
export function openRoundSocket(opts: RoundSocketOptions): { close: () => void } {
  const WS = opts.WebSocket ?? WebSocket;
  const random = opts.random ?? Math.random;
  const url = roundSocketUrl(opts.roundId, opts.origin ?? window.location.origin);
  let socket: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    opts.onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WS(url);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      opts.onStatus?.('open');
      clearInterval(ping);
      ping = setInterval(() => {
        if (ws.readyState === WS.OPEN) ws.send('ping');
      }, opts.pingMs ?? PING_MS);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const msg = WsServerMessageSchema.safeParse(parsed);
      if (msg.success) opts.onMessage(msg.data);
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (stopped || socket !== ws) return;
      opts.onStatus?.('reconnecting');
      retry = setTimeout(connect, reconnectDelay(attempt, random));
      attempt += 1;
    };
    // An error is always followed by a close, which reconnects.
    ws.onerror = () => undefined;
  };

  connect();
  return {
    close: () => {
      stopped = true;
      clearInterval(ping);
      clearTimeout(retry);
      opts.onStatus?.('closed');
      socket?.close();
    },
  };
}
