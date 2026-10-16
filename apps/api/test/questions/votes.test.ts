// POST /questions/:id/vote (spec "Question pipeline" step 3; "API"): votes only on the vote queue,
// never on your own question; a repeat vote replaces the earlier one; the score decays with a
// 3-day half-life, and GET /questions?sort=top orders by the decayed score.
import { env } from 'cloudflare:test';
import { QuestionsListResponseSchema, VoteQuestionResponseSchema, newUlid } from '@flocked/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { take, userBucket } from '../../src/auth/rate-limit.js';
import type { Env } from '../../src/env.js';
import { castVote } from '../../src/questions/votes.js';
import { voteWeight } from '../../src/questions/score.js';
import { realSession } from '../helpers/index.js';
import {
  DAY,
  T0,
  call,
  createUser,
  errorCode,
  insertQuestion,
  list,
  questionsEnv,
  setClock,
  vote,
  type TestUser,
} from './routes-helpers.js';

let e: Env;
let author: TestUser;
beforeAll(async () => {
  e = questionsEnv();
  author = await createUser();
});
afterEach(() => setClock(e, T0));

async function votesOn(questionId: string) {
  const { results } = await env.DB.prepare(
    'SELECT user_id, value, created_at, weight FROM question_votes WHERE question_id = ?1',
  )
    .bind(questionId)
    .all<{ user_id: string; value: number; created_at: number; weight: number }>();
  return results;
}

async function storedScore(questionId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT score FROM questions WHERE id = ?1')
    .bind(questionId)
    .first<{ score: number }>();
  return row!.score;
}

/** The listed questions among `ids`, in served order. */
async function topOrder(as: TestUser | undefined, ids: string[]) {
  const res = await list(e, as?.user, '?status=queued&sort=top');
  expect(res.status).toBe(200);
  const body = QuestionsListResponseSchema.parse(await res.json());
  return body.questions.filter((q) => ids.includes(q.id));
}

describe('POST /questions/:id/vote', () => {
  it('records a vote on a question in the vote queue and answers the served score', async () => {
    const voter = await createUser();
    const q = await insertQuestion({ authorId: author.id });
    const res = await vote(e, voter.user, q, 1);
    expect(res.status).toBe(200);
    expect(VoteQuestionResponseSchema.parse(await res.json())).toEqual({
      questionId: q,
      value: 1,
      score: 1,
    });
    expect(await votesOn(q)).toEqual([
      { user_id: voter.id, value: 1, created_at: T0, weight: voteWeight(T0) },
    ]);
    expect(await storedScore(q)).toBe(voteWeight(T0));
  });

  it('admin-approved (`queued`) questions and house questions take votes too', async () => {
    const voter = await createUser();
    const approved = await insertQuestion({ authorId: author.id, status: 'queued' });
    const house = await insertQuestion({ authorId: null, status: 'queued' });
    expect((await vote(e, voter.user, approved, -1)).status).toBe(200);
    expect((await vote(e, voter.user, house, 1)).status).toBe(200);
  });

  it('refuses a vote on your own question: 403 forbidden, nothing stored', async () => {
    const q = await insertQuestion({ authorId: author.id });
    const res = await vote(e, author.user, q, 1);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden');
    expect(await votesOn(q)).toEqual([]);
  });

  it.each([
    ['awaiting admin review', { status: 'submitted', needsReview: true }],
    ['rejected', { status: 'rejected' }],
    ['scheduled', { status: 'scheduled' }],
    ['used', { status: 'used' }],
  ] as const)('refuses a question %s: 409 conflict, nothing stored', async (_what, seed) => {
    const voter = await createUser();
    const q = await insertQuestion({ authorId: author.id, ...seed });
    const res = await vote(e, voter.user, q, 1);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect(await votesOn(q)).toEqual([]);
    expect(await storedScore(q)).toBe(0);
  });

  it('404 for an unknown question; 400 for a malformed ID or value', async () => {
    const voter = await createUser();
    const unknown = await vote(e, voter.user, newUlid(), 1);
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe('not_found');
    const q = await insertQuestion({ authorId: author.id });
    for (const bad of [0, 2, '1', null]) {
      const res = await vote(e, voter.user, q, bad);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    }
    expect((await vote(e, voter.user, 'not-a-ulid', 1)).status).toBe(400);
    expect(await votesOn(q)).toEqual([]);
  });

  it('401 without a session', async () => {
    const q = await insertQuestion({ authorId: author.id });
    const res = await vote(e, undefined, q, 1);
    expect(res.status).toBe(401);
  });

  it('account_suspended for a suspended account, before anything else is checked', async () => {
    const suspended = await createUser({ status: 'suspended' });
    const { headers } = await realSession(e, suspended.id);
    const q = await insertQuestion({ authorId: author.id });
    for (const [id, value] of [
      [q, 1],
      [newUlid(), 1], // unknown: would be 404
      [q, 7], // bad value: would be 400
    ] as const) {
      const res = await call(e, undefined, 'POST', `/questions/${id}/vote`, { value }, headers);
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('account_suspended');
    }
    expect(await votesOn(q)).toEqual([]);
  });

  it('is rate limited per user (votes, 60/min): 429 with Retry-After', async () => {
    const voter = await createUser();
    const q = await insertQuestion({ authorId: author.id });
    expect((await take(env, userBucket(voter.id, 'votes'), 60)).allowed).toBe(true);
    const res = await vote(e, voter.user, q, 1);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await votesOn(q)).toEqual([]);
  });

  it('a question that leaves the vote queue between the check and the write gets no vote', async () => {
    const voter = await createUser();
    const q = await insertQuestion({ authorId: author.id });
    // The admin assigns the question while the vote is in flight (after the read, before the batch).
    const racing = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("UPDATE questions SET status = 'scheduled' WHERE id = ?1")
          .bind(q)
          .run();
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    await expect(
      castVote(racing, { questionId: q, userId: voter.id, value: 1 }, T0),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await votesOn(q)).toEqual([]);
    expect(await storedScore(q)).toBe(0);
  });
});

describe('decayed score', () => {
  it('orders GET ?sort=top by decayed score: an older, bigger tally falls below a newer, smaller one', async () => {
    const older = await insertQuestion({ authorId: author.id, createdAt: T0 - 2 * DAY });
    const newer = await insertQuestion({ authorId: author.id, createdAt: T0 - DAY });
    const voters = await Promise.all([1, 2, 3, 4].map(() => createUser()));

    // Day 0: four upvotes on the older question.
    for (const v of voters) expect((await vote(e, v.user, older, 1)).status).toBe(200);
    expect((await topOrder(undefined, [older, newer])).map((q) => [q.id, q.score])).toEqual([
      [older, 4],
      [newer, 0],
    ]);

    // Three days later (one half-life): three upvotes on the newer one. 4 × ½ = 2 < 3.
    setClock(e, T0 + 3 * DAY);
    for (const v of voters.slice(0, 3)) {
      const res = await vote(e, v.user, newer, 1);
      expect(VoteQuestionResponseSchema.parse(await res.json()).score).toBeGreaterThan(0);
    }
    expect((await topOrder(undefined, [older, newer])).map((q) => [q.id, q.score])).toEqual([
      [newer, 3],
      [older, 2],
    ]);
    // The raw tallies still say otherwise.
    expect((await votesOn(older)).length).toBe(4);
    expect((await votesOn(newer)).length).toBe(3);

    // A day and a half later both have decayed by another √2 (1.41 and 2.12), the order holds.
    setClock(e, T0 + 4.5 * DAY);
    expect((await topOrder(undefined, [older, newer])).map((q) => [q.id, q.score])).toEqual([
      [newer, 2],
      [older, 1],
    ]);
  });

  it('a repeat vote replaces the earlier one (recast now); switching sides recomputes the score', async () => {
    const q = await insertQuestion({ authorId: author.id });
    const [a, b] = [await createUser(), await createUser()];
    const scoreOf = async (res: Response) =>
      VoteQuestionResponseSchema.parse(await res.json()).score;

    expect(await scoreOf(await vote(e, a.user, q, 1))).toBe(1);
    // Three days later the vote counts ½; voting again replaces it with a fresh vote worth 1.
    setClock(e, T0 + 3 * DAY);
    expect(await scoreOf(await vote(e, a.user, q, 1))).toBe(1);
    expect(await votesOn(q)).toEqual([
      { user_id: a.id, value: 1, created_at: T0 + 3 * DAY, weight: voteWeight(T0 + 3 * DAY) },
    ]);
    expect(await storedScore(q)).toBe(voteWeight(T0 + 3 * DAY));

    // b downvotes: 1 − 1 = 0. a switches sides: −1 − 1 = −2.
    expect(await scoreOf(await vote(e, b.user, q, -1))).toBe(0);
    expect(await scoreOf(await vote(e, a.user, q, -1))).toBe(-2);
    expect((await votesOn(q)).map((v) => [v.user_id, v.value]).sort()).toEqual(
      [
        [a.id, -1],
        [b.id, -1],
      ].sort(),
    );
    expect(await storedScore(q)).toBeCloseTo(-2 * voteWeight(T0 + 3 * DAY), 6);

    const [listed] = await topOrder(a, [q]);
    expect(listed).toMatchObject({ id: q, score: -2, myVote: -1 });
  });
});
