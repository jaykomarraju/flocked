// POST /rooms/:id/questions (spec "API": owner only, before the next room round's question lock;
// "Profiles, leaderboards and rooms" › Rooms: a custom room's question goes through the same
// moderation step). Who may set it, the target round, the moderation outcomes (pass, reject, review,
// a duplicate of a public question counting as a pass), replacing before the lock, the lock passed
// or won by a race (409, nothing stored), and the shared 3-per-game-day submission allowance.
import { env } from 'cloudflare:test';
import { QuestionsListResponseSchema, SetRoomQuestionResponseSchema } from '@flocked/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { insertRoomRoundsAhead } from '../../src/rooms/schedule.js';
import { REJECT_REASON, verdictFor } from '../questions/routes-helpers.js';
import {
  DAY,
  MINUTE,
  NEXT,
  QUESTION_BODY,
  T0,
  call,
  createUser,
  duplicates,
  errorCode,
  insertQuestion,
  model,
  publicUser,
  resetModeration,
  roomRounds,
  roomsEnv,
  seedRoom,
  setClock,
  type TestUser,
} from './helpers.js';

let e: Env;
beforeAll(() => {
  e = roomsEnv();
});
afterEach(() => {
  setClock(e, T0);
  resetModeration();
});

interface StoredQuestion {
  id: string;
  author_user_id: string;
  status: string;
  needs_review: number;
  rejection_reason: string | null;
  room_id: string | null;
  moderation_json: string;
}

async function stored(id: string): Promise<StoredQuestion> {
  const row = await env.DB.prepare('SELECT * FROM questions WHERE id = ?1')
    .bind(id)
    .first<StoredQuestion>();
  if (!row) throw new Error(`question ${id} not stored`);
  return row;
}

async function roomQuestionCount(roomId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE room_id = ?1')
    .bind(roomId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A custom room with its owner and one member. */
async function customRoom(source: 'custom' | 'daily' = 'custom', closedAt?: number) {
  const owner = await createUser();
  const member = await createUser();
  const room = await seedRoom({
    owner: { user: owner, joinedAt: T0 - DAY, balance: 500 },
    members: [{ user: member, joinedAt: T0 - DAY + MINUTE, balance: 500 }],
    source,
    ...(closedAt === undefined ? {} : { closedAt }),
  });
  return { ...room, owner, member };
}

const setQuestion = (as: TestUser | undefined, roomId: string, body: unknown = QUESTION_BODY) =>
  call(e, as?.user, 'POST', `/rooms/${roomId}/questions`, body);

async function created(res: Response) {
  expect(res.status, await res.clone().text()).toBe(201);
  return SetRoomQuestionResponseSchema.parse(await res.json());
}

const withPrompt = (prompt: string) => ({ ...QUESTION_BODY, prompt });

describe('who may set it', () => {
  it('needs the owner of an open custom room', async () => {
    const r = await customRoom();
    expect(await errorCode(await setQuestion(undefined, r.id))).toBe('unauthorized');
    const outsider = await createUser();
    const out = await setQuestion(outsider, r.id);
    expect(out.status).toBe(404);
    expect(await errorCode(out)).toBe('not_found');
    const member = await setQuestion(r.member, r.id);
    expect(member.status).toBe(403);
    expect(await errorCode(member)).toBe('forbidden');

    const mirror = await customRoom('daily');
    const m = await setQuestion(mirror.owner, mirror.id);
    expect(m.status).toBe(409);
    expect(await errorCode(m)).toBe('conflict');

    const closed = await customRoom('custom', T0 - 1);
    expect((await setQuestion(closed.owner, closed.id)).status).toBe(404);

    expect(model.classify).not.toHaveBeenCalled();
    for (const id of [r.id, mirror.id, closed.id]) expect(await roomQuestionCount(id)).toBe(0);
  });

  it('validates the format like POST /questions (400)', async () => {
    const r = await customRoom();
    const same = { ...QUESTION_BODY, options: [{ label: 'Same' }, { label: ' same ' }] };
    expect((await setQuestion(r.owner, r.id, same)).status).toBe(400);
    expect((await setQuestion(r.owner, r.id, withPrompt('   '))).status).toBe(400);
    expect(
      (await setQuestion(r.owner, r.id, { ...QUESTION_BODY, turnstileToken: 'x' })).status,
    ).toBe(400);
    expect(await roomQuestionCount(r.id)).toBe(0);
  });
});

describe('moderation outcomes', () => {
  it('pass: scheduled on the next room round, private to the room, never indexed', async () => {
    const r = await customRoom();
    const out = await created(await setQuestion(r.owner, r.id));
    expect(out.moderation).toEqual({ outcome: 'queued', reason: null });
    expect(out.question).toMatchObject({
      prompt: 'Window seat or aisle seat?',
      status: 'scheduled',
      author: publicUser(r.owner),
      createdAt: T0,
    });
    const rounds = await roomRounds(r.id);
    const next = rounds.find((x) => x.opens_at === NEXT.opensAt);
    expect(out.roundId).toBe(next?.id);
    expect(next?.question_id).toBe(out.question.id);
    expect(rounds.filter((x) => x.id !== out.roundId).map((x) => x.question_id)).toEqual([null]);
    expect(await stored(out.question.id)).toMatchObject({
      status: 'scheduled',
      needs_review: 0,
      room_id: r.id,
      author_user_id: r.owner.id,
    });
    expect(duplicates.add).not.toHaveBeenCalled();
  });

  it('the owner may replace it on the same round before the lock', async () => {
    const r = await customRoom();
    const first = await created(await setQuestion(r.owner, r.id));
    const second = await created(
      await setQuestion(r.owner, r.id, withPrompt('Beach or mountains?')),
    );
    expect(second.roundId).toBe(first.roundId);
    const round = (await roomRounds(r.id)).find((x) => x.id === first.roundId);
    expect(round?.question_id).toBe(second.question.id);
  });

  it('reject: stored rejected with its reason; the round keeps its question', async () => {
    const r = await customRoom();
    const kept = await created(await setQuestion(r.owner, r.id));
    const out = await created(await setQuestion(r.owner, r.id, withPrompt('Rude one? #reject')));
    expect(out.moderation).toEqual({ outcome: 'rejected', reason: REJECT_REASON });
    expect(out.question.status).toBe('rejected');
    expect(out.roundId).toBe(kept.roundId);
    expect(await stored(out.question.id)).toMatchObject({
      status: 'rejected',
      rejection_reason: REJECT_REASON,
      room_id: r.id,
    });
    const round = (await roomRounds(r.id)).find((x) => x.id === kept.roundId);
    expect(round?.question_id).toBe(kept.question.id);
  });

  it('review: stored for an admin (submitted, needs_review); nothing set on the round', async () => {
    const r = await customRoom();
    const out = await created(await setQuestion(r.owner, r.id, withPrompt('Hmm? #review')));
    expect(out.moderation).toEqual({ outcome: 'review', reason: null });
    expect(out.question.status).toBe('submitted');
    expect(await stored(out.question.id)).toMatchObject({
      status: 'submitted',
      needs_review: 1,
      room_id: r.id,
    });
    expect((await roomRounds(r.id)).map((x) => x.question_id)).toEqual([null, null]);
    expect(duplicates.add).not.toHaveBeenCalled();
  });

  it('a duplicate of a public question is no reason to refuse a room question', async () => {
    const r = await customRoom();
    const publicId = await insertQuestion('Window seat or aisle seat?', T0 - DAY);
    duplicates.findDuplicate.mockResolvedValue({ id: publicId, score: 0.97 });
    const out = await created(await setQuestion(r.owner, r.id));
    expect(out.moderation).toEqual({ outcome: 'queued', reason: null });
    expect(out.question.status).toBe('scheduled');
    const json = JSON.parse((await stored(out.question.id)).moderation_json) as Record<
      string,
      unknown
    >;
    expect(json).toMatchObject({ decision: 'pass', reason: null, duplicateOf: publicId });

    // A failed duplicate lookup doesn't send it to review either.
    duplicates.findDuplicate.mockRejectedValue(new Error('vectorize down'));
    const again = await created(await setQuestion(r.owner, r.id, withPrompt('Tea or coffee?')));
    expect(again.moderation.outcome).toBe('queued');

    // A failed check still rejects, duplicate or not.
    duplicates.findDuplicate.mockResolvedValue({ id: publicId, score: 0.97 });
    const bad = await created(await setQuestion(r.owner, r.id, withPrompt('Rude one? #reject')));
    expect(bad.moderation).toEqual({ outcome: 'rejected', reason: REJECT_REASON });
  });
});

describe('the target round and its lock', () => {
  it("after the next slot's lock, the question goes to the slot after it", async () => {
    const r = await customRoom();
    setClock(e, NEXT.lockAt + MINUTE);
    const out = await created(await setQuestion(r.owner, r.id));
    const target = (await roomRounds(r.id)).find((x) => x.id === out.roundId);
    expect(target?.opens_at).toBe(NEXT.opensAt + DAY);
  });

  it('answers 409 when no room round can take a question', async () => {
    const r = await customRoom();
    await insertRoomRoundsAhead(env.DB, r.id, T0);
    await env.DB.prepare("UPDATE rounds SET status = 'closed' WHERE room_id = ?1").bind(r.id).run();
    const res = await setQuestion(r.owner, r.id);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect(model.classify).not.toHaveBeenCalled();
    expect(await roomQuestionCount(r.id)).toBe(0);
  });

  it('answers 409 and stores nothing when the round locks while moderation runs', async () => {
    const r = await customRoom();
    const locked = await insertQuestion('Locked in?', T0 - DAY);
    model.classify.mockImplementationOnce(async (q) => {
      // The scheduler's lock wins the race for the target round.
      await env.DB.prepare(
        "UPDATE rounds SET question_id = ?2, beacon_round = 1, config_json = '{}', locked_at = ?3 " +
          "WHERE id = (SELECT id FROM rounds WHERE room_id = ?1 AND kind = 'room' ORDER BY opens_at LIMIT 1)",
      )
        .bind(r.id, locked, T0)
        .run();
      return verdictFor(q);
    });
    const res = await setQuestion(r.owner, r.id);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect(await roomQuestionCount(r.id)).toBe(0);
    const [first] = await roomRounds(r.id);
    expect(first?.question_id).toBe(locked);
  });
});

describe('the submission allowance', () => {
  it('counts toward the 3 question submissions per game day, shared with POST /questions', async () => {
    const r = await customRoom();
    for (const p of ['One?', 'Two?', 'Three?']) {
      await created(await setQuestion(r.owner, r.id, withPrompt(p)));
    }
    const res = await setQuestion(r.owner, r.id, withPrompt('Four?'));
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(model.classify).toHaveBeenCalledTimes(3);
    const quota = await call(e, r.owner.user, 'GET', '/questions');
    expect(QuestionsListResponseSchema.parse(await quota.json()).quota?.remainingToday).toBe(0);
  });
});
