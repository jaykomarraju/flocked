// Seams the RoundDO calls at fixed points, filled in by later sessions:
//   * notification hooks (W9-A): at `opensAt` (`question_live`), 3 h before close (`streak_at_risk`)
//     and 60 min before close (`closing_soon`). A hook only resolves recipients and enqueues
//     `notify` messages; the notify consumer sends them. No recipients are resolved yet.
//   * broadcast (W7-A): the WebSocket fan-out through RoundViewerDO shards. A no-op until then.
import type { Mode, NotifyMessage, WsServerMessage } from '@flocked/shared';
import type { Env } from '../env.js';

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
 * The `notify` messages for one round event. W9-A resolves recipients (opted-in users; for
 * `closing_soon` and `streak_at_risk` only those not yet entered, the latter with a stray streak
 * ≥ 3; for `question_live` only users with no entry in the round that just closed).
 */
export function notificationsFor(
  _env: Env,
  _event: RoundNotifyEvent,
  _round: HookRound,
): Promise<NotifyMessage[]> {
  return Promise.resolve([]);
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
  return messages.length;
}

/** Broadcast to the round's viewers (W7-A: coalesced to at most one counts update per second). */
export function broadcast(_env: Env, _roundId: string, _message: WsServerMessage): void {
  // W7-A
}
