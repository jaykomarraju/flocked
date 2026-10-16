// Submission limits (spec "Anti-abuse" › Spam questions; the API part of E2E-13): after 5 rejected
// submissions in 7 days, question submission is blocked for 7 days; play is unaffected. And the game
// day the 3-per-day limit counts in: 21:00 to 21:00 New York.
import { env } from 'cloudflare:test';
import {
  ErrorEnvelopeSchema,
  QuestionsListResponseSchema,
  SubmitQuestionResponseSchema,
  newUlid,
  type QuestionQuota,
} from '@flocked/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { gameDayWindow } from '../../src/questions/quota.js';
import {
  BASE_OPENS_AT,
  createRound,
  createUser as createPlayer,
  sealedPick,
  useTestSigner,
  type TestRound,
} from '../round-do/helpers.js';
import { fakeUser } from '../helpers/index.js';
import {
  DAY,
  HOUR,
  MINUTE,
  call,
  countQuestions,
  createUser,
  errorCode,
  list,
  model,
  questionsEnv,
  setClock,
  submit,
  VALID_BODY,
  insertQuestion,
  verdictFor,
  vote,
} from './routes-helpers.js';

const BLOCK = 7 * DAY;
/** 2026-10-07 12:00 New York: game day 2026-10-07. */
const DAY_A = Date.UTC(2026, 9, 7, 16, 0, 0);
/** 2026-10-07 22:00 New York: game day 2026-10-08 (the room round below is open). */
const DAY_B = Date.UTC(2026, 9, 8, 2, 0, 0);

let e: Env;
beforeAll(() => {
  useTestSigner();
  e = questionsEnv();
});
beforeEach(() => {
  model.classify.mockClear();
});

const reject = (n: number) => ({ ...VALID_BODY, prompt: `#reject Bad question ${n}?` });
const pass = (n: number) => ({ ...VALID_BODY, prompt: `Good question ${n}?` });

/** Submits at `t`; answers the response's quota (201 expected). */
async function submitAt(as: { id: string }, t: number, body: unknown): Promise<QuestionQuota> {
  setClock(e, t);
  const res = await submit(e, fakeUser({ id: as.id }), body);
  expect(res.status).toBe(201);
  return SubmitQuestionResponseSchema.parse(await res.json()).quota;
}

async function blockUntil(userId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT question_block_until AS until FROM limits WHERE user_id = ?1',
  )
    .bind(userId)
    .first<{ until: number | null }>();
  return row?.until ?? null;
}

describe('gameDayWindow', () => {
  it('runs 21:00 to 21:00 New York', () => {
    const t = Date.UTC(2026, 9, 15, 16, 0, 0); // 12:00 EDT
    expect(gameDayWindow(t)).toEqual({
      start: Date.UTC(2026, 9, 15, 1, 0, 0),
      end: Date.UTC(2026, 9, 16, 1, 0, 0),
    });
    // 21:00 itself starts the next game day.
    expect(gameDayWindow(Date.UTC(2026, 9, 16, 1, 0, 0)).start).toBe(
      Date.UTC(2026, 9, 16, 1, 0, 0),
    );
    expect(gameDayWindow(Date.UTC(2026, 9, 16, 1, 0, 0) - 1).end).toBe(
      Date.UTC(2026, 9, 16, 1, 0, 0),
    );
  });

  it('is 25 hours on the day daylight saving time ends', () => {
    // 2026-11-01: EDT until 02:00, EST after. 21:00 EDT Oct 31 → 21:00 EST Nov 1.
    expect(gameDayWindow(Date.UTC(2026, 10, 1, 17, 0, 0))).toEqual({
      start: Date.UTC(2026, 10, 1, 1, 0, 0),
      end: Date.UTC(2026, 10, 2, 2, 0, 0),
    });
  });
});

describe('the 7-day block after 5 rejections (E2E-13)', () => {
  let round: TestRound;
  let roomId: string;
  beforeAll(async () => {
    roomId = newUlid();
    round = await createRound({ roomId, opensAt: BASE_OPENS_AT });
    setClock(e, BASE_OPENS_AT + HOUR);
    await round.stub.init(round.locked);
  });

  it('the 5th rejection within 7 days blocks submission until 7 days after it; play and votes are unaffected; then it ends', async () => {
    const u = { id: await createPlayer(500, roomId) };
    // Game day 2026-10-07: three rejections.
    for (let i = 0; i < 3; i++) await submitAt(u, DAY_A + i * MINUTE, reject(i));
    // Game day 2026-10-08: the 4th leaves submission open.
    expect(await submitAt(u, DAY_B, reject(3))).toEqual({
      remainingToday: 2,
      rejectionsLast7Days: 4,
      blockedUntil: null,
    });
    expect(await blockUntil(u.id)).toBeNull();
    // The 5th blocks for 7 days from now.
    const t5 = DAY_B + MINUTE;
    expect(await submitAt(u, t5, reject(4))).toEqual({
      remainingToday: 1,
      rejectionsLast7Days: 5,
      blockedUntil: t5 + BLOCK,
    });
    expect(await blockUntil(u.id)).toBe(t5 + BLOCK);

    // The next submission (with a slot left today) is 403 submission_blocked, saying until when.
    model.classify.mockClear();
    setClock(e, t5 + MINUTE);
    const res = await submit(e, fakeUser({ id: u.id }), pass(5));
    expect(res.status).toBe(403);
    const { error } = ErrorEnvelopeSchema.parse(await res.json());
    expect(error.code).toBe('submission_blocked');
    expect(error.message).toContain(new Date(t5 + BLOCK).toISOString());
    expect(model.classify).not.toHaveBeenCalled();
    expect(await countQuestions(u.id)).toBe(5);
    const listed = QuestionsListResponseSchema.parse(
      await (await list(e, fakeUser({ id: u.id }))).json(),
    );
    expect(listed.quota?.blockedUntil).toBe(t5 + BLOCK);

    // Play is unaffected: the blocked user enters a round (their first Free entry of the day)...
    const entry = await call(
      e,
      fakeUser({ id: u.id }),
      'POST',
      `/rounds/${round.locked.roundId}/entries`,
      {
        stake: '25',
        ciphertext: await sealedPick(round.locked),
        turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
      },
    );
    expect(entry.status).toBe(201);
    // ...and votes on the queue.
    const q = await insertQuestion({ authorId: null, status: 'queued' });
    expect((await vote(e, fakeUser({ id: u.id }), q, 1)).status).toBe(200);

    // Still blocked a millisecond before the end, on any day.
    setClock(e, t5 + BLOCK - 1);
    const late = await submit(e, fakeUser({ id: u.id }), pass(6));
    expect(await errorCode(late)).toBe('submission_blocked');

    // At the end the block is over, and the rejections have aged out of the window.
    expect(await submitAt(u, t5 + BLOCK, pass(7))).toEqual({
      remainingToday: 2,
      rejectionsLast7Days: 0,
      blockedUntil: null,
    });
  });

  it('4 rejections within 7 days leave submission open', async () => {
    const u = await createUser();
    for (let i = 0; i < 3; i++) await submitAt(u, DAY_A + i * MINUTE, reject(i));
    await submitAt(u, DAY_B, reject(3));
    expect(await submitAt(u, DAY_B + MINUTE, pass(4))).toEqual({
      remainingToday: 1,
      rejectionsLast7Days: 4,
      blockedUntil: null,
    });
    expect(await submitAt(u, DAY_B + 2 * MINUTE, pass(5))).toMatchObject({ blockedUntil: null });
    expect(await blockUntil(u.id)).toBeNull();
  });

  it('rejections older than 7 days don’t count', async () => {
    const [late, early] = [await createUser(), await createUser()];
    for (const u of [late, early]) {
      for (let i = 0; i < 3; i++) await submitAt(u, DAY_A + i * MINUTE, reject(i));
      await submitAt(u, DAY_B, reject(3));
    }
    // A 5th rejection just after the first three left the window: 2 in 7 days, no block.
    expect(await submitAt(late, DAY_A + 2 * MINUTE + BLOCK + 1, reject(4))).toEqual({
      remainingToday: 2,
      rejectionsLast7Days: 2,
      blockedUntil: null,
    });
    expect(await submitAt(late, DAY_A + 3 * MINUTE + BLOCK, pass(5))).toMatchObject({
      blockedUntil: null,
    });
    // A 5th rejection while the first three are still inside the window blocks.
    const t5 = DAY_A + BLOCK - 1;
    expect(await submitAt(early, t5, reject(4))).toMatchObject({
      rejectionsLast7Days: 5,
      blockedUntil: t5 + BLOCK,
    });
  });

  it('a block that lands while the submission is in moderation stops it: 403, nothing stored', async () => {
    const u = await createUser();
    setClock(e, DAY_B);
    // An admin rejects the author's 5th question elsewhere while this one is being moderated.
    model.classify.mockImplementationOnce(async (q) => {
      await env.DB.prepare('INSERT INTO limits (user_id, question_block_until) VALUES (?1, ?2)')
        .bind(u.id, DAY_B + BLOCK)
        .run();
      return verdictFor(q);
    });
    const res = await submit(e, u.user, pass(0));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('submission_blocked');
    expect(model.classify).toHaveBeenCalledTimes(1);
    expect(await countQuestions(u.id)).toBe(0);
  });
});
