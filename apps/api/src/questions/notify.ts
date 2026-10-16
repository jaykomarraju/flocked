// The question pipeline's notices to authors (spec "Notifications": `question_used`, `question_edited`,
// `question_rejected`), on the notify queue with the spec's dedupe keys. W9-A's consumer delivers
// them and drops repeats by key, so a caller may enqueue the same notice again (a retried handler).
// Each message is checked against NotifyMessageSchema when it is built, before the change it reports
// is written; sending comes after, and a send failure is logged, not raised: the change is committed
// and the caller (an admin action, a post-final handler) must not fail or repeat because of it.
import { NotifyMessageSchema, type NotifyMessage } from '@flocked/shared';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';

export type QuestionNotifyEnv = Pick<Env, 'QUEUE_NOTIFY'>;

/** `question_rejected` to the author, with the admin's reason (`question_rejected:{questionId}`). */
export function questionRejectedMessage(
  authorUserId: string,
  questionId: string,
  reason: string,
): NotifyMessage {
  return NotifyMessageSchema.parse({
    event: 'question_rejected',
    userId: authorUserId,
    dedupeKey: `question_rejected:${questionId}`,
    payload: { questionId, reason },
  });
}

/** `question_edited` to the author, keyed by the edit's audit row (`question_edited:{auditId}`). */
export function questionEditedMessage(
  authorUserId: string,
  questionId: string,
  auditId: string,
): NotifyMessage {
  return NotifyMessageSchema.parse({
    event: 'question_edited',
    userId: authorUserId,
    dedupeKey: `question_edited:${auditId}`,
    payload: { questionId, auditId },
  });
}

/** `question_used` to the author when the question is scheduled or settles (`question_used:{questionId}:{stage}`). */
export function questionUsedMessage(
  authorUserId: string,
  questionId: string,
  roundId: string,
  stage: 'scheduled' | 'settled',
): NotifyMessage {
  return NotifyMessageSchema.parse({
    event: 'question_used',
    userId: authorUserId,
    dedupeKey: `question_used:${questionId}:${stage}`,
    payload: { questionId, stage, roundId },
  });
}

/** Sends one notice. Returns false (and logs) when the queue refused it; never throws. */
export async function enqueueQuestionNotice(
  env: QuestionNotifyEnv,
  message: NotifyMessage,
): Promise<boolean> {
  try {
    await env.QUEUE_NOTIFY.send(message);
    return true;
  } catch (err) {
    log.error('question_notice_enqueue_failed', {
      event: message.event,
      userId: message.userId,
      dedupeKey: message.dedupeKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
