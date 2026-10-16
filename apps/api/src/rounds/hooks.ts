// Seams the RoundDO calls at fixed points, filled in by later sessions:
//   * notification hooks (W9-A): at `opensAt` (`question_live`, and the daily official cast), 3 h
//     before close (`streak_at_risk`) and 60 min before close (`closing_soon`). A hook only resolves
//     recipients (src/notify/alarms.ts) and enqueues `notify` messages; the notify consumer sends
//     them, once per key however often an alarm fires.
//   * broadcast (W7-A): the WebSocket fan-out through RoundViewerDO shards (src/ws/).
import type { Mode, NotifyMessage, WsServerMessage } from '@flocked/shared';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { roundNotifications } from '../notify/alarms.js';
import { postDailyCast } from '../notify/cast.js';
import { publish } from '../ws/hub.js';

export type RoundNotifyEvent = 'question_live' | 'streak_at_risk' | 'closing_soon';

export interface HookRound {
  roundId: string;
  kind: 'daily' | 'room';
  roomId: string | null;
  opensAt: number;
  closesAt: number;
  modes: readonly Mode[];
}

/** `sendBatch` takes at most 100 messages. */
const SEND_BATCH_MAX = 100;

/**
 * The `notify` messages for one round event (src/notify/alarms.ts): reachable users; for
 * `closing_soon` and `streak_at_risk` only those not yet entered, the latter with a stray streak
 * ≥ 3 and the event on; for `question_live` only users with no entry in the round that just closed.
 * Room rounds: none.
 */
export function notificationsFor(
  env: Env,
  event: RoundNotifyEvent,
  round: HookRound,
): Promise<NotifyMessage[]> {
  return roundNotifications(env, event, round, now(env));
}

/** Enqueues the event's notifications in batches. Returns how many were enqueued. */
export async function enqueueNotifications(
  env: Env,
  event: RoundNotifyEvent,
  round: HookRound,
): Promise<number> {
  const messages = await notificationsFor(env, event, round);
  for (let i = 0; i < messages.length; i += SEND_BATCH_MAX) {
    await env.QUEUE_NOTIFY.sendBatch(
      messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })),
    );
  }
  // The daily official cast goes out with the question (once per round; it never throws).
  if (event === 'question_live') await postDailyCast(env, round);
  return messages.length;
}

/**
 * Broadcast to the round's viewers through its RoundViewerDO shards (W7-A, src/ws/hub.ts): `counts`
 * coalesced to at most one per second (the last one always sent), every message in order. Returns
 * at once; the hub holds the fan-out and logs a shard it can't reach.
 */
export function broadcast(env: Env, roundId: string, message: WsServerMessage): void {
  publish(env, roundId, message);
}
