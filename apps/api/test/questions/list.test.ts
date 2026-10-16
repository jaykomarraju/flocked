// GET /questions (spec "API": "Questions in the voting queue"; "Question pipeline" step 3): the vote
// queue by decayed score (top 50, one page) or by creation time (keyset pages); scheduled questions
// only for their author; used questions of daily rounds; the caller's votes and quota when signed in.
import { env } from 'cloudflare:test';
import {
  QUEUE_TOP_LIMIT,
  QuestionsListResponseSchema,
  newUlid,
  type QuestionsListResponse,
} from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import {
  InvalidQuestionRowError,
  questionView,
  type QuestionRow,
} from '../../src/questions/rows.js';
import { voteWeight } from '../../src/questions/score.js';
import {
  DAY,
  HOUR,
  T0,
  createUser,
  errorCode,
  insertQuestion,
  insertRound,
  list,
  questionsEnv,
  voteRow,
  type TestUser,
} from './routes-helpers.js';

let e: Env;
let author: TestUser;
beforeAll(async () => {
  e = questionsEnv();
  author = await createUser();
});

async function ok(res: Response): Promise<QuestionsListResponse> {
  expect(res.status).toBe(200);
  return QuestionsListResponseSchema.parse(await res.json());
}

const ids = (body: QuestionsListResponse) => body.questions.map((q) => q.id);

/** The vote queue in `sort=new` order, straight from D1. */
async function queueByNew(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM questions WHERE status IN ('submitted', 'queued') AND needs_review = 0 ORDER BY created_at DESC, id DESC",
  ).all<{ id: string }>();
  return results.map((r) => r.id);
}

// Runs first: the questions below outscore everything the later tests add (score 0).
describe('sort=top', () => {
  const seeded: string[] = [];
  beforeAll(async () => {
    // 55 questions scoring 1..55 now (stored epoch-scaled, as votes cast at T0 would be).
    for (let k = 1; k <= 55; k++) {
      seeded.push(
        await insertQuestion({
          authorId: author.id,
          score: k * voteWeight(T0),
          createdAt: T0 - DAY - k * HOUR,
        }),
      );
    }
  });

  it('is the top 50 by decayed score, highest first, in one page (the default sort)', async () => {
    const body = await ok(await list(e, undefined));
    expect(body.questions).toHaveLength(QUEUE_TOP_LIMIT);
    expect(ids(body)).toEqual([...seeded].reverse().slice(0, 50));
    expect(body.questions.map((q) => q.score)).toEqual(
      Array.from({ length: 50 }, (_, i) => 55 - i),
    );
    expect(body.nextCursor).toBeNull();
    expect(ids(await ok(await list(e, undefined, '?status=queued&sort=top')))).toEqual(ids(body));
  });

  it('`limit` shortens it but never past 50', async () => {
    expect(ids(await ok(await list(e, undefined, '?limit=10')))).toEqual(
      [...seeded].reverse().slice(0, 10),
    );
    expect((await ok(await list(e, undefined, '?limit=100'))).questions).toHaveLength(50);
  });

  it('breaks ties by age, oldest first', async () => {
    const newer = await insertQuestion({ score: 60 * voteWeight(T0), createdAt: T0 - HOUR });
    const older = await insertQuestion({ score: 60 * voteWeight(T0), createdAt: T0 - 2 * HOUR });
    expect(ids(await ok(await list(e, undefined, '?limit=2')))).toEqual([older, newer]);
    await env.DB.prepare('UPDATE questions SET score = 0 WHERE id IN (?1, ?2)')
      .bind(newer, older)
      .run();
  });

  it('takes no cursor: 400', async () => {
    const res = await list(e, undefined, '?sort=top&cursor=abc');
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('bad_request');
  });
});

describe('sort=new', () => {
  it('pages through the whole queue by creation time, newest first, ties by ID', async () => {
    // Three questions created in the same millisecond.
    const tie = T0 - 30 * 60_000;
    for (let i = 0; i < 3; i++) await insertQuestion({ authorId: author.id, createdAt: tie });
    const expected = await queueByNew();
    expect(expected.length).toBeGreaterThan(50);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?sort=new&limit=7${cursor ? `&cursor=${cursor}` : ''}`;
      const body = await ok(await list(e, undefined, query));
      expect(body.questions.length).toBeLessThanOrEqual(7);
      seen.push(...ids(body));
      cursor = body.nextCursor;
      pages++;
      // A question submitted meanwhile is newer than every cursor: it never shifts a page.
      if (pages === 2) await insertQuestion({ authorId: author.id, createdAt: T0 });
    } while (cursor !== null);
    expect(seen).toEqual(expected);
    expect(pages).toBe(Math.ceil(expected.length / 7));
  });

  it('defaults to 20 a page', async () => {
    const body = await ok(await list(e, undefined, '?sort=new'));
    expect(body.questions).toHaveLength(20);
    expect(body.nextCursor).not.toBeNull();
  });

  it('refuses a malformed cursor or limit: 400', async () => {
    for (const q of [
      '?sort=new&cursor=bm9wZQ',
      '?sort=new&cursor=WzEsMl0',
      '?sort=new&limit=0',
      '?sort=new&limit=101',
      '?sort=old',
      '?status=rejected',
      '?status=submitted',
    ]) {
      const res = await list(e, undefined, q);
      expect(res.status, q).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    }
  });
});

describe('statuses', () => {
  it('queued (the default) is the vote queue: never a pending review, rejected, scheduled or used question', async () => {
    const passed = await insertQuestion({ authorId: author.id, status: 'submitted' });
    const approved = await insertQuestion({ authorId: author.id, status: 'queued' });
    const house = await insertQuestion({ authorId: null, status: 'queued' });
    const hidden = await Promise.all([
      insertQuestion({ authorId: author.id, status: 'submitted', needsReview: true }),
      insertQuestion({ authorId: author.id, status: 'rejected' }),
      insertQuestion({ authorId: author.id, status: 'scheduled' }),
      insertQuestion({ authorId: author.id, status: 'used' }),
    ]);
    for (const query of ['?sort=new&limit=100', '?status=queued&sort=new&limit=100']) {
      const listed = ids(await ok(await list(e, author.user, query)));
      expect(listed).toEqual(expect.arrayContaining([passed, approved, house]));
      for (const id of hidden) expect(listed).not.toContain(id);
    }
  });

  it('scheduled lists only the caller’s own scheduled questions; none for anyone else', async () => {
    const mine = await insertQuestion({ authorId: author.id, status: 'scheduled' });
    const someone = await createUser();
    const theirs = await insertQuestion({ authorId: someone.id, status: 'scheduled' });

    const anonymous = await ok(await list(e, undefined, '?status=scheduled'));
    expect(anonymous.questions).toEqual([]);
    expect(anonymous.quota).toBeNull();
    const other = await createUser();
    expect((await ok(await list(e, other.user, '?status=scheduled'))).questions).toEqual([]);

    const own = await ok(await list(e, author.user, '?status=scheduled&sort=new'));
    expect(own.questions.every((q) => q.status === 'scheduled')).toBe(true);
    expect(ids(own)).toContain(mine);
    expect(ids(own)).not.toContain(theirs);
    expect(ids(await ok(await list(e, someone.user, '?status=scheduled')))).toEqual([theirs]);
  });

  it('used lists the questions of locked daily rounds, never a room round’s', async () => {
    const daily = await insertQuestion({ authorId: author.id, status: 'used' });
    await insertRound(daily, 'daily', T0 - 2 * DAY);
    const room = await insertQuestion({ authorId: author.id, status: 'used' });
    await insertRound(room, 'room', T0 - 2 * DAY);
    const queued = await insertQuestion({ authorId: author.id, status: 'queued' });
    await insertRound(queued, 'daily', T0 - 3 * DAY);

    for (const sort of ['top', 'new']) {
      const body = await ok(await list(e, undefined, `?status=used&sort=${sort}`));
      expect(ids(body)).toEqual([daily]);
      expect(body.questions[0]).toMatchObject({ status: 'used', author: { id: author.id } });
    }
  });
});

describe('signed in', () => {
  it('each question carries the caller’s vote; anonymous callers get null votes and quota', async () => {
    const voter = await createUser();
    // The newest questions of the file so far.
    const up = await insertQuestion({ authorId: author.id, createdAt: T0 + 1000 });
    const down = await insertQuestion({ authorId: author.id, createdAt: T0 + 2000 });
    const none = await insertQuestion({ authorId: author.id, createdAt: T0 + 3000 });
    const other = await createUser();
    await env.DB.batch([
      voteRow(up, voter.id, 1, T0),
      voteRow(down, voter.id, -1, T0),
      voteRow(none, other.id, 1, T0),
    ]);

    const mine = await ok(await list(e, voter.user, '?sort=new&limit=3'));
    expect(mine.questions.map((q) => [q.id, q.myVote])).toEqual([
      [none, null],
      [down, -1],
      [up, 1],
    ]);
    expect(mine.quota).toEqual({ remainingToday: 3, rejectionsLast7Days: 0, blockedUntil: null });

    const anonymous = await ok(await list(e, undefined, '?sort=new&limit=3'));
    expect(anonymous.questions.map((q) => q.myVote)).toEqual([null, null, null]);
    expect(anonymous.quota).toBeNull();
  });

  it('quota counts the caller’s submissions this game day and rejections in 7 days', async () => {
    const u = await createUser();
    await insertQuestion({ authorId: u.id, createdAt: T0 - HOUR });
    await insertQuestion({ authorId: u.id, status: 'rejected', createdAt: T0 - 2 * HOUR });
    // Yesterday's game day: counts as a rejection, not toward today's 3.
    await insertQuestion({ authorId: u.id, status: 'rejected', createdAt: T0 - DAY });
    const body = await ok(await list(e, u.user));
    expect(body.quota).toEqual({ remainingToday: 1, rejectionsLast7Days: 2, blockedUntil: null });
  });

  it('caches anonymous reads publicly (5 s) and never a signed-in one', async () => {
    expect((await list(e, undefined)).headers.get('Cache-Control')).toBe('public, max-age=5');
    expect((await list(e, author.user)).headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('authors', () => {
  it('serves the public profile; a deleted or merged account only as its ID; house questions none', async () => {
    const deleted = await createUser({ status: 'deleted' });
    const merged = await createUser({ status: 'merged', mergedInto: author.id });
    const suspended = await createUser({ status: 'suspended' });
    const at = T0 + 10_000; // the newest questions of the file so far
    const q = {
      active: await insertQuestion({ authorId: author.id, createdAt: at }),
      suspended: await insertQuestion({ authorId: suspended.id, createdAt: at + 1 }),
      deleted: await insertQuestion({ authorId: deleted.id, createdAt: at + 2 }),
      merged: await insertQuestion({ authorId: merged.id, createdAt: at + 3 }),
      missing: await insertQuestion({ authorId: newUlid(), createdAt: at + 4 }),
      house: await insertQuestion({ authorId: null, createdAt: at + 5 }),
    };
    const body = await ok(await list(e, undefined, '?sort=new&limit=6'));
    const authorOf = (id: string) => body.questions.find((x) => x.id === id)?.author;
    const anonymized = (id: string) => ({ id, handle: null, displayName: null, avatarUrl: null });
    expect(authorOf(q.active)).toEqual({
      id: author.id,
      handle: author.handle,
      displayName: `Name ${author.handle}`,
      avatarUrl: null,
    });
    expect(authorOf(q.suspended)).toMatchObject({ id: suspended.id, handle: suspended.handle });
    expect(authorOf(q.deleted)).toEqual(anonymized(deleted.id));
    expect(authorOf(q.merged)).toEqual(anonymized(merged.id));
    const missingAuthor = authorOf(q.missing);
    expect(missingAuthor).toMatchObject({ handle: null, displayName: null, avatarUrl: null });
    expect(authorOf(q.house)).toBeNull();
  });
});

describe('stored values that fail their schema', () => {
  it('fail the read (500) instead of being served', async () => {
    const bad = await insertQuestion({
      authorId: author.id,
      status: 'used',
      options: [
        { label: 'An option label far longer than allowed', emoji: '' },
        { label: 'No', emoji: '' },
      ],
    });
    await insertRound(bad, 'daily', T0 - 5 * DAY);
    try {
      const res = await list(e, undefined, '?status=used');
      expect(res.status).toBe(500);
      expect(await errorCode(res)).toBe('internal');
    } finally {
      await env.DB.prepare('DELETE FROM questions WHERE id = ?1').bind(bad).run();
    }
  });

  it('questionView throws for a bad category, status or options', () => {
    const row: QuestionRow = {
      id: newUlid(T0),
      author_user_id: null,
      prompt: 'Cats or dogs?',
      options_json: JSON.stringify([
        { label: 'Cats', emoji: '' },
        { label: 'Dogs', emoji: '' },
      ]),
      category: 'life',
      status: 'queued',
      moderation_json: null,
      score: 0,
      created_at: T0,
      needs_review: 0,
      rejection_reason: null,
      rejected_at: null,
    };
    expect(questionView(row, null, T0)).toMatchObject({ category: 'life', score: 0 });
    for (const bad of [
      { category: 'sports' },
      { status: 'pending' },
      { options_json: '[{"label":"Cats","emoji":""}]' },
      { options_json: '[{"label":"","emoji":""},{"label":"Dogs","emoji":""}]' },
      { options_json: 'not json' },
    ]) {
      expect(() => questionView({ ...row, ...bad }, null, T0)).toThrow(InvalidQuestionRowError);
    }
  });
});
