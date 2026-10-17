// POST /questions (spec "Question pipeline" steps 1-2; "Anti-abuse": Turnstile on question
// submission, and the spam rule). In order:
//   1. the format (./format.ts; the request schema ran before): 400 `bad_request`;
//   2. the quota (./quota.ts): a 7-day block is 403 `submission_blocked` (until when), a 4th
//      submission in the game day 429 `rate_limited` with Retry-After at the game day's end;
//   3. Turnstile: the token is required and verified (403 `turnstile_failed`);
//   4. moderation (synchronous; src/moderation): pass, reject or review;
//   5. one batch: the question, inserted only while the author still has room in the game day and
//      isn't blocked (so two concurrent submits can't both take the last slot), then for a rejection
//      the 7-day block check (`blockAfterRejection`, which counts the rejection just stored), then
//      the stored row;
//   6. a passed or reviewed question is added to the duplicate index.
//
// Status flow (decision E4): pass → `submitted` (the vote queue); reject → `rejected` with
// `rejection_reason` and `rejected_at`; review → `submitted` with `needs_review` (admin only).
import {
  QUESTIONS_PER_DAY,
  newUlid,
  type ModerationOutcome,
  type QuestionQuota,
  type SubmitQuestionRequest,
  type SubmitQuestionResponse,
} from '@flocked/shared';
import type { Context } from 'hono';
import { authDeps } from '../auth/deps.js';
import { clientIp } from '../auth/rate-limit.js';
import type { AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import {
  indexQuestion,
  moderateQuestion,
  type ModerationDecision,
  type ModerationResult,
} from '../moderation/index.js';
import { cleanQuestionInput, storedOptionsJson } from './format.js';
import { SUBMITTED_TODAY_SQL, blockAfterRejection, gameDayWindow, quotaOf } from './quota.js';
import {
  QUESTION_SELECT,
  questionAuthor,
  questionView,
  type QuestionWithAuthorRow,
} from './rows.js';

type Ctx = Context<AppEnv>;

/** Stored when moderation rejects without a reason (it always gives one; the column needs one). */
const DEFAULT_REJECTION_REASON = 'This question was not accepted.';

const OUTCOMES: Record<ModerationDecision, ModerationOutcome['outcome']> = {
  pass: 'queued',
  reject: 'rejected',
  review: 'review',
};

/** Throws the refusal for a quota that allows no submission now; returns otherwise. */
export function refuseOverQuota(c: Ctx, quota: QuestionQuota, t: number): void {
  if (quota.blockedUntil !== null) {
    throw new HttpError(
      'submission_blocked',
      `Too many of your questions were rejected recently; you can submit again after ${new Date(quota.blockedUntil).toISOString()}`,
    );
  }
  if (quota.remainingToday === 0) {
    const { end } = gameDayWindow(t);
    c.header('Retry-After', String(Math.max(1, Math.ceil((end - t) / 1000))));
    throw new HttpError(
      'rate_limited',
      `You can submit ${QUESTIONS_PER_DAY} questions a day; try again after the next round opens`,
    );
  }
}

/** Turnstile on question submission (spec "Anti-abuse"): the token is required. */
async function requireTurnstile(c: Ctx, token: string | undefined): Promise<void> {
  if (!token) {
    throw new HttpError('turnstile_failed', 'Complete the human check to submit a question');
  }
  const result = await verifyTurnstile(c.env, token, {
    remoteIp: clientIp(c),
    fetch: authDeps(c.env).turnstileFetch,
  });
  if (!result.success) {
    if (result.errorCodes.includes('missing-input-secret')) {
      log.error('turnstile_secret_missing', {});
    }
    throw new HttpError('turnstile_failed', 'The human check failed; try again');
  }
}

/** The insert, the block check after a rejection, and the stored row, as one batch. */
async function store(
  db: D1Database,
  q: { id: string; authorId: string; t: number },
  input: ReturnType<typeof cleanQuestionInput>,
  result: ModerationResult,
): Promise<QuestionWithAuthorRow | null> {
  const { start, end } = gameDayWindow(q.t);
  const rejected = result.decision === 'reject';
  const status = rejected ? 'rejected' : 'submitted';
  const insert = db
    .prepare(
      'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, ' +
        'moderation_json, score, created_at, needs_review, rejection_reason, rejected_at) ' +
        'SELECT ?4, ?1, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13 ' +
        `WHERE (${SUBMITTED_TODAY_SQL}) < ?14 AND NOT EXISTS (SELECT 1 FROM limits ` +
        'WHERE user_id = ?1 AND question_block_until > ?10)',
    )
    .bind(
      q.authorId,
      start,
      end,
      q.id,
      input.prompt,
      storedOptionsJson(input.options),
      input.category,
      status,
      JSON.stringify(result.json),
      q.t,
      result.decision === 'review' ? 1 : 0,
      rejected ? (result.reason ?? DEFAULT_REJECTION_REASON) : null,
      rejected ? q.t : null,
      QUESTIONS_PER_DAY,
    );
  const read = db.prepare(`${QUESTION_SELECT} WHERE q.id = ?1`).bind(q.id);
  const results = await db.batch<QuestionWithAuthorRow>(
    rejected ? [insert, blockAfterRejection(db, q.authorId, q.t), read] : [insert, read],
  );
  return results[results.length - 1]?.results[0] ?? null;
}

export async function submitQuestion(
  c: Ctx,
  userId: string,
  body: SubmitQuestionRequest,
): Promise<SubmitQuestionResponse> {
  const input = cleanQuestionInput(body);
  const db = c.env.DB;
  const t = now(c.env);
  refuseOverQuota(c, await quotaOf(db, userId, t), t);
  await requireTurnstile(c, body.turnstileToken);

  const result = await moderateQuestion(c.env, input, t);
  const id = newUlid(t);
  const row = await store(db, { id, authorId: userId, t }, input, result);
  if (!row) {
    // A concurrent submit took the last slot, or a rejection elsewhere blocked the author.
    refuseOverQuota(c, await quotaOf(db, userId, t), t);
    throw new HttpError('rate_limited', 'Too many submissions; try again later');
  }
  log.info('question_submitted', { questionId: id, decision: result.decision });
  if (result.decision !== 'reject') {
    await indexQuestion(c.env, { id, prompt: input.prompt, createdAt: t, options: input.options });
  }
  return {
    question: questionView(row, questionAuthor(row), t),
    moderation: {
      outcome: OUTCOMES[result.decision],
      reason: result.decision === 'reject' ? row.rejection_reason : null,
    },
    quota: await quotaOf(db, userId, t),
  };
}
