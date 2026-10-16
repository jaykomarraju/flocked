import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRoundSocket, reconnectDelay, roundSocketUrl, type SocketStatus } from './socket';

/** A minimal WebSocket stand-in the tests drive by hand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

const ID = '01JA0000000000000000000RND';
const COUNTS = { type: 'counts', roundId: ID, modes: { free: { entrantCount: 3, pool: '75' } } };

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

function open(onMessage = vi.fn(), statuses: SocketStatus[] = []) {
  const s = openRoundSocket({
    roundId: ID,
    origin: 'https://flocked.xyz',
    onMessage,
    onStatus: (st) => statuses.push(st),
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    random: () => 0.5,
    pingMs: 1000,
  });
  return { s, onMessage, statuses };
}

describe('the round socket', () => {
  it('connects to /api/v1/rounds/:id/ws over wss on https', () => {
    expect(roundSocketUrl(ID, 'https://flocked.xyz')).toBe(
      `wss://flocked.xyz/api/v1/rounds/${ID}/ws`,
    );
    expect(roundSocketUrl(ID, 'http://localhost:8787')).toBe(
      `ws://localhost:8787/api/v1/rounds/${ID}/ws`,
    );
  });

  it('passes on parsed messages and drops pong and anything malformed', () => {
    const { onMessage } = open();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.receive('pong');
    ws.receive('not json');
    ws.receive({ type: 'counts', roundId: ID });
    ws.receive(COUNTS);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(COUNTS);
  });

  it('pings to stay alive', () => {
    open();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    vi.advanceTimersByTime(3000);
    expect(ws.sent).toEqual(['ping', 'ping', 'ping']);
  });

  it('reconnects with backoff after a drop, and reports it', () => {
    const { statuses } = open();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.drop();
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting']);
    vi.advanceTimersByTime(reconnectDelay(0, () => 0.5) - 1);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    // A second failure waits longer.
    FakeSocket.instances[1]!.drop();
    vi.advanceTimersByTime(reconnectDelay(0, () => 0.5));
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(reconnectDelay(1, () => 0.5));
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2]!.open();
    expect(statuses.at(-1)).toBe('open');
  });

  it('stops for good on close()', () => {
    const { s } = open();
    FakeSocket.instances[0]!.open();
    s.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('reconnectDelay', () => {
  it('doubles up to 30 s, with jitter in the upper half', () => {
    expect(reconnectDelay(0, () => 0)).toBe(500);
    expect(reconnectDelay(0, () => 1)).toBe(1000);
    expect(reconnectDelay(3, () => 1)).toBe(8000);
    expect(reconnectDelay(20, () => 1)).toBe(30_000);
    expect(reconnectDelay(20, () => 0)).toBe(15_000);
  });
});
