// Route module `questions`: the question queue, submissions and votes (W8-A; spec "Question
// pipeline", "API"). The logic is in src/questions/: list.ts, submit.ts, votes.ts.
//
// Suspended accounts sign in read-only (spec "Identity and personhood" › Identities): a submission
// or a vote refuses `account_suspended` first, before anything about the request is checked.
// GET /questions is public: anonymous reads are edge-cached for 5 s; a signed-in read carries the
// caller's votes and quota and is never cached.
import {
  IdParamsSchema,
  QuestionsListQuerySchema,
  SubmitQuestionRequestSchema,
  VoteQuestionRequestSchema,
} from '@flocked/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { limitUser } from '../auth/rate-limit.js';
import { refuseSuspended } from '../identity/accounts.js';
import { getUser, requireUser, type AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { validate } from '../lib/validate.js';
import { listQuestions } from '../questions/list.js';
import { submitQuestion } from '../questions/submit.js';
import { castVote } from '../questions/votes.js';
import { cachedRead, readResponse } from '../read/cache.js';
import { stubEndpoints } from './stub.js';

/** 403 `account_suspended` for a suspended caller (after `requireUser`). */
const refuseSuspendedUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  refuseSuspended(getUser(c));
  await next();
};

const app = new Hono<AppEnv>();

app.get('/questions', validate('query', QuestionsListQuerySchema), async (c) => {
  const user = c.get('user');
  if (!user) {
    const cached = await cachedRead(c);
    if (cached) return cached;
  }
  const body = await listQuestions(c.env.DB, c.req.valid('query'), user?.id ?? null, now(c.env));
  return readResponse(c, body, { membersOnly: user !== undefined });
});

app.post(
  '/questions',
  requireUser,
  refuseSuspendedUser,
  validate('json', SubmitQuestionRequestSchema),
  async (c) => {
    const body = await submitQuestion(c, getUser(c).id, c.req.valid('json'));
    return c.json(body, 201);
  },
);

app.post(
  '/questions/:id/vote',
  requireUser,
  refuseSuspendedUser,
  limitUser('votes'),
  validate('param', IdParamsSchema),
  validate('json', VoteQuestionRequestSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { value } = c.req.valid('json');
    const body = await castVote(
      c.env.DB,
      { questionId: id, userId: getUser(c).id, value },
      now(c.env),
    );
    return c.json(body, 200);
  },
);

export const questions = stubEndpoints(app, 'questions');
