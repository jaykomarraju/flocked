// A round followed live in React: seeded from a RoundView, then the WebSocket. While the socket is
// down (RoundDO unavailable, network loss) the hook keeps the last state, reports `reconnecting` for
// the "Reconnecting" banner and polls `GET /rounds/:id` until the socket is back (decision E7).
import { RoundDetailResponseSchema, type RoundView, type WsServerMessage } from '@flocked/shared';
import { useEffect, useReducer, useState } from 'react';
import { endpoint, type ApiClient } from '../api/client';
import { applyMessage, applyRoundView, type LiveRound } from './live';
import { openRoundSocket, type RoundSocketOptions, type SocketStatus } from './socket';

export const roundDetail = endpoint('GET', '/rounds/:id', null, RoundDetailResponseSchema);

/** How often the fallback polls `GET /rounds/:id` while the socket is down. */
export const POLL_MS = 5_000;

type Action = { kind: 'message'; msg: WsServerMessage } | { kind: 'view'; round: RoundView };

function reduce(state: LiveRound | null, action: Action): LiveRound | null {
  return action.kind === 'message'
    ? applyMessage(state, action.msg)
    : applyRoundView(state, action.round);
}

export interface LiveRoundResult {
  round: LiveRound | null;
  connection: SocketStatus;
}

export function useLiveRound(
  client: ApiClient,
  seed: RoundView | null,
  opts: Pick<RoundSocketOptions, 'WebSocket' | 'origin'> & { pollMs?: number } = {},
): LiveRoundResult {
  const roundId = seed?.id ?? null;
  const [round, dispatch] = useReducer(reduce, seed, (s) => (s ? applyRoundView(null, s) : null));
  const [connection, setConnection] = useState<SocketStatus>('connecting');

  // A newer seed (a refetch of the same round) merges in; never backwards.
  useEffect(() => {
    if (seed) dispatch({ kind: 'view', round: seed });
  }, [seed]);

  useEffect(() => {
    if (!roundId) return;
    const socket = openRoundSocket({
      roundId,
      onMessage: (msg) => dispatch({ kind: 'message', msg }),
      onStatus: setConnection,
      WebSocket: opts.WebSocket,
      origin: opts.origin,
    });
    return () => socket.close();
  }, [roundId, opts.WebSocket, opts.origin]);

  useEffect(() => {
    if (!roundId || connection !== 'reconnecting') return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const res = await client.call(roundDetail, {
          params: { id: roundId },
          signal: controller.signal,
        });
        dispatch({ kind: 'view', round: res.round });
      } catch {
        // Still down: the next poll tries again.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), opts.pollMs ?? POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, roundId, connection, opts.pollMs]);

  return { round: round?.roundId === roundId ? round : null, connection };
}
