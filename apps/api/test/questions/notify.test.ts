// The question pipeline's notices (src/questions/notify.ts): the spec's dedupe keys, schema checks
// before anything is written, and a queue failure that is logged, not raised.
import { NotifyMessageSchema, type NotifyMessage } from '@flocked/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import {
  enqueueQuestionNotice,
  questionEditedMessage,
  questionRejectedMessage,
  questionUsedMessage,
} from '../../src/questions/notify.js';

const USER = '01K70000000000000000000001';
const QUESTION = '01K70000000000000000000010';
const ROUND = '01K70000000000000000000020';
const AUDIT = '01K70000000000000000000099';

function queue(fail?: Error) {
  const send = vi.fn((_m: NotifyMessage) => (fail ? Promise.reject(fail) : Promise.resolve()));
  return { send, env: { QUEUE_NOTIFY: { send } as unknown as Env['QUEUE_NOTIFY'] } };
}

describe('question notices (spec "Notifications" dedupe keys)', () => {
  it('question_rejected: question_rejected:{questionId}, with the reason', () => {
    const m = questionRejectedMessage(USER, QUESTION, 'It asks for a fact.');
    expect(NotifyMessageSchema.parse(m)).toEqual({
      event: 'question_rejected',
      userId: USER,
      dedupeKey: `question_rejected:${QUESTION}`,
      payload: { questionId: QUESTION, reason: 'It asks for a fact.' },
    });
  });

  it('question_edited: question_edited:{auditId}', () => {
    expect(questionEditedMessage(USER, QUESTION, AUDIT)).toEqual({
      event: 'question_edited',
      userId: USER,
      dedupeKey: `question_edited:${AUDIT}`,
      payload: { questionId: QUESTION, auditId: AUDIT },
    });
  });

  it('question_used: question_used:{questionId}:{stage}', () => {
    for (const stage of ['scheduled', 'settled'] as const) {
      expect(questionUsedMessage(USER, QUESTION, ROUND, stage)).toEqual({
        event: 'question_used',
        userId: USER,
        dedupeKey: `question_used:${QUESTION}:${stage}`,
        payload: { questionId: QUESTION, stage, roundId: ROUND },
      });
    }
  });

  it('checks the message when it is built: an empty or 501-character reason, a bad ID', () => {
    expect(() => questionRejectedMessage(USER, QUESTION, '')).toThrow();
    expect(() => questionRejectedMessage(USER, QUESTION, 'x'.repeat(501))).toThrow();
    expect(() => questionRejectedMessage(USER, QUESTION, 'x'.repeat(500))).not.toThrow();
    expect(() => questionEditedMessage('not-a-ulid', QUESTION, AUDIT)).toThrow();
  });

  it('sends on the notify queue', async () => {
    const q = queue();
    const m = questionUsedMessage(USER, QUESTION, ROUND, 'settled');
    await expect(enqueueQuestionNotice(q.env, m)).resolves.toBe(true);
    expect(q.send).toHaveBeenCalledWith(m);
  });

  it('a queue failure is logged and answered false, never thrown', async () => {
    const q = queue(new Error('queue down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const m = questionRejectedMessage(USER, QUESTION, 'Too close to a recent question.');
      await expect(enqueueQuestionNotice(q.env, m)).resolves.toBe(false);
      expect(q.send).toHaveBeenCalledOnce();
      const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('question_notice_enqueue_failed');
      expect(logged).toContain(`question_rejected:${QUESTION}`);
    } finally {
      error.mockRestore();
    }
  });
});
