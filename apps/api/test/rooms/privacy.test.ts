// Room questions are private to the room (migration 0019; spec "Profiles, leaderboards and rooms" ›
// Rooms): whatever their status — scheduled by the owner, `queued` (say, approved from admin review)
// or `used` by a locked room round — they never appear in GET /questions (top, new, any status
// filter), never take votes, never show on the author's public profile, and never count as a
// duplicate of a public submission (the local duplicate stand-in reads D1; Vectorize never indexes
// them). The rubric model is faked; the duplicate index is the real local one.
import { env } from 'cloudflare:test';
import {
  QuestionsListResponseSchema,
  addGameDays,
  openGameDayAt,
  SetRoomQuestionResponseSchema,
  SubmitQuestionResponseSchema,
  UserProfileResponseSchema,
} from '@flocked/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { FALLBACK_REASONS } from '../../src/moderation/decide.js';
import { approveQuestion, assignQuestion } from '../../src/questions/admin.js';
import {
  DAY,
  QUESTION_BODY,
  T0,
  call,
  createUser,
  roomsEnv,
  seedRoom,
  type TestUser,
} from './helpers.js';

const siteverify = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.resolve(Response.json({ success: true })),
);

let e: Env;
let owner: TestUser;
let other: TestUser;
/** The room's questions: scheduled (set by the owner), queued, used. */
let roomQuestions: string[];
let publicQuestion: string;

const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

beforeAll(async () => {
  e = roomsEnv(T0, { fakeDuplicates: false, turnstileFetch: siteverify });
  owner = await createUser();
  other = await createUser();
  const room = await seedRoom({
    owner: { user: owner, joinedAt: T0 - 5 * DAY, balance: 500 },
    members: [{ user: other, joinedAt: T0 - 4 * DAY, balance: 500 }],
    source: 'custom',
  });
  const set = await call(e, owner.user, 'POST', `/rooms/${room.id}/questions`, QUESTION_BODY);
  expect(set.status).toBe(201);
  const scheduled = SetRoomQuestionResponseSchema.parse(await set.json()).question.id;

  // A room question in the states an admin approval or the lock would leave it in.
  const insert = (id: string, prompt: string, status: string) =>
    env.DB.prepare(
      "INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at, room_id) VALUES (?1, ?2, ?3, ?4, 'life', ?5, ?6, ?7)",
    )
      .bind(
        id,
        owner.id,
        prompt,
        JSON.stringify([
          { label: 'Yes', emoji: '' },
          { label: 'No', emoji: '' },
        ]),
        status,
        T0 - DAY,
        room.id,
      )
      .run();
  const queued = '01K7R00M000000000000000001';
  const used = '01K7R00M000000000000000002';
  await insert(queued, 'Room only: approved?', 'queued');
  await insert(used, 'Room only: used?', 'used');
  roomQuestions = [scheduled, queued, used];

  const pub = await call(e, owner.user, 'POST', '/questions', {
    ...QUESTION_BODY,
    prompt: 'Sunrise or sunset?',
    turnstileToken: TOKEN,
  });
  expect(pub.status).toBe(201);
  publicQuestion = SubmitQuestionResponseSchema.parse(await pub.json()).question.id;
});

async function listed(as: TestUser | undefined, query: string): Promise<string[]> {
  const res = await call(e, as?.user, 'GET', `/questions${query}`);
  expect(res.status).toBe(200);
  return QuestionsListResponseSchema.parse(await res.json()).questions.map((q) => q.id);
}

describe('room questions stay in the room', () => {
  it('are never listed by GET /questions, for anyone, in any sort or status', async () => {
    for (const as of [undefined, owner, other]) {
      for (const query of [
        '',
        '?sort=new',
        '?status=queued&sort=new&limit=100',
        '?status=scheduled',
        '?status=scheduled&sort=new',
        '?status=used',
        '?status=used&sort=new',
      ]) {
        const ids = await listed(as, query);
        for (const id of roomQuestions) expect(ids, `${query} as ${as?.id}`).not.toContain(id);
      }
    }
    // The public one is in the queue.
    expect(await listed(undefined, '?sort=new')).toContain(publicQuestion);
  });

  it('take no votes', async () => {
    for (const id of roomQuestions) {
      const res = await call(e, other.user, 'POST', `/questions/${id}/vote`, { value: 1 });
      expect(res.status).toBe(409);
    }
    const votes = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM question_votes WHERE question_id IN (SELECT value FROM json_each(?1))',
    )
      .bind(JSON.stringify(roomQuestions))
      .first<{ n: number }>();
    expect(votes?.n).toBe(0);
  });

  it("are not on the author's public profile", async () => {
    const res = await call(e, undefined, 'GET', `/users/${owner.handle}`);
    expect(res.status).toBe(200);
    const profile = UserProfileResponseSchema.parse(await res.json());
    expect(profile.questions.map((q) => q.id)).toEqual([]);
    // The public question shows once queued (an admin approval; `submitted` isn't listed).
    await env.DB.prepare("UPDATE questions SET status = 'queued' WHERE id = ?1")
      .bind(publicQuestion)
      .run();
    const after = UserProfileResponseSchema.parse(
      await (await call(e, undefined, 'GET', `/users/${owner.handle}`)).json(),
    );
    expect(after.questions.map((q) => q.id)).toEqual([publicQuestion]);
  });

  it('never block a public duplicate; a public question still does', async () => {
    // The same text as the owner's room question: a public submission passes.
    const res = await call(e, other.user, 'POST', '/questions', {
      ...QUESTION_BODY,
      turnstileToken: TOKEN,
    });
    const out = SubmitQuestionResponseSchema.parse(await res.json());
    expect(out.moderation).toEqual({ outcome: 'queued', reason: null });
    for (const prompt of ['Room only: approved?', 'Room only: used?']) {
      const r = await call(e, other.user, 'POST', '/questions', {
        prompt,
        options: [{ label: 'Yes' }, { label: 'No' }],
        category: 'life',
        turnstileToken: TOKEN,
      });
      expect(SubmitQuestionResponseSchema.parse(await r.json()).moderation.outcome).toBe('queued');
    }

    // The stand-in does find public duplicates.
    const dup = await call(e, (await createUser()).user, 'POST', '/questions', {
      ...QUESTION_BODY,
      prompt: 'Sunrise or sunset?',
      turnstileToken: TOKEN,
    });
    expect(SubmitQuestionResponseSchema.parse(await dup.json()).moderation).toEqual({
      outcome: 'rejected',
      reason: FALLBACK_REASONS.duplicate,
    });
  });

  it("can't be approved into the public queue or assigned to a daily round by an admin", async () => {
    const [, queued] = roomQuestions;
    if (!queued) throw new Error('no queued room question');
    const review = '01K7R00M000000000000000003';
    await env.DB.prepare(
      "INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, needs_review, created_at, room_id) VALUES (?1, ?2, 'Room only: review?', ?3, 'life', 'submitted', 1, ?4, ?5)",
    )
      .bind(
        review,
        owner.id,
        JSON.stringify([{ label: 'Yes' }, { label: 'No' }]),
        T0 - DAY,
        (
          await env.DB.prepare('SELECT room_id FROM questions WHERE id = ?1')
            .bind(queued)
            .first<{ room_id: string }>()
        )?.room_id,
      )
      .run();
    const admin = '01K7R00A000000000000000001';
    await expect(approveQuestion(e, admin, review, T0)).rejects.toMatchObject({
      code: 'conflict',
    });
    const gameDay = addGameDays(openGameDayAt(Math.floor(T0 / 1000)), 3);
    await expect(assignQuestion(e, admin, gameDay, queued, T0)).rejects.toMatchObject({
      code: 'conflict',
    });
    const rows = await env.DB.prepare(
      'SELECT id, status, needs_review FROM questions WHERE id IN (?1, ?2) ORDER BY id',
    )
      .bind(queued, review)
      .all();
    expect(rows.results).toEqual([
      { id: queued, status: 'queued', needs_review: 0 },
      { id: review, status: 'submitted', needs_review: 1 },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM rounds WHERE kind = 'daily' AND question_id = ?1",
      )
        .bind(queued)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});
