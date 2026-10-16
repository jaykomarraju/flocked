// POST /questions (spec "Question pipeline" steps 1-2; "Anti-abuse": Turnstile and the spam rule):
// the format, the 3-per-game-day limit, Turnstile, synchronous moderation (fake model and index) and
// the status flow (decision E4): pass → the vote queue; reject → `rejected` with its reason; review
// → `submitted` with `needs_review`, for an admin only.
import { env } from 'cloudflare:test';
import { QuestionsListResponseSchema, SubmitQuestionResponseSchema } from '@flocked/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import type { ModelVerdict } from '../../src/moderation/index.js';
import { isSingleEmoji } from '../../src/questions/format.js';
import { realSession } from '../helpers/index.js';
import {
  MINUTE,
  REJECT_REASON,
  T0,
  T0_DAY_END,
  VALID_BODY,
  call,
  countQuestions,
  createUser,
  duplicates,
  errorCode,
  list,
  model,
  questionsEnv,
  setClock,
  siteverify,
  submit,
  verdictFor,
  vote,
} from './routes-helpers.js';

let e: Env;
beforeAll(() => {
  e = questionsEnv();
});
beforeEach(() => {
  setClock(e, T0);
  model.classify.mockClear();
  model.classify.mockImplementation((q) => Promise.resolve(verdictFor(q)));
  duplicates.add.mockClear();
  siteverify.mockClear();
});

interface StoredQuestion {
  id: string;
  author_user_id: string | null;
  prompt: string;
  options_json: string;
  category: string;
  status: string;
  moderation_json: string | null;
  score: number;
  created_at: number;
  needs_review: number;
  rejection_reason: string | null;
  rejected_at: number | null;
}

async function stored(id: string): Promise<StoredQuestion> {
  const row = await env.DB.prepare('SELECT * FROM questions WHERE id = ?1')
    .bind(id)
    .first<StoredQuestion>();
  if (!row) throw new Error(`question ${id} not stored`);
  return row;
}

async function created(res: Response) {
  expect(res.status).toBe(201);
  return SubmitQuestionResponseSchema.parse(await res.json());
}

/** The public vote queue's IDs (newest 100). */
async function publicQueue(): Promise<string[]> {
  const res = await list(e, undefined, '?status=queued&sort=new&limit=100');
  return QuestionsListResponseSchema.parse(await res.json()).questions.map((q) => q.id);
}

const body = (prompt: string, extra: Record<string, unknown> = {}) => ({
  ...VALID_BODY,
  prompt,
  ...extra,
});

describe('moderation outcomes', () => {
  it('pass: 201, stored trimmed in the vote queue, public and open for votes', async () => {
    const u = await createUser();
    const res = await submit(e, u.user, {
      prompt: '  Window seat or aisle seat?  ',
      options: [{ label: ' Window ', emoji: '🪟' }, { label: 'Aisle' }],
      category: 'life',
      turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
    });
    const out = await created(res);
    expect(out.question).toEqual({
      id: out.question.id,
      prompt: 'Window seat or aisle seat?',
      options: [
        { label: 'Window', emoji: '🪟' },
        { label: 'Aisle', emoji: '' },
      ],
      category: 'life',
      status: 'submitted',
      score: 0,
      author: { id: u.id, handle: u.handle, displayName: `Name ${u.handle}`, avatarUrl: null },
      createdAt: T0,
    });
    expect(out.moderation).toEqual({ outcome: 'queued', reason: null });
    expect(out.quota).toEqual({ remainingToday: 2, rejectionsLast7Days: 0, blockedUntil: null });

    const row = await stored(out.question.id);
    expect(row).toMatchObject({
      author_user_id: u.id,
      prompt: 'Window seat or aisle seat?',
      options_json: JSON.stringify([
        { label: 'Window', emoji: '🪟' },
        { label: 'Aisle', emoji: '' },
      ]),
      status: 'submitted',
      needs_review: 0,
      rejection_reason: null,
      rejected_at: null,
      created_at: T0,
    });
    expect(JSON.parse(row.moderation_json!)).toMatchObject({ decision: 'pass', checkedAt: T0 });

    // Moderation saw the cleaned question; Turnstile saw the token; the index got the question.
    expect(model.classify).toHaveBeenCalledTimes(1);
    expect(model.classify.mock.calls[0]![0]).toEqual({
      prompt: 'Window seat or aisle seat?',
      options: [{ label: 'Window', emoji: '🪟' }, { label: 'Aisle' }],
      category: 'life',
    });
    expect((siteverify.mock.calls[0]![1]!.body as FormData).get('response')).toBe(
      'XXXX.DUMMY.TOKEN.XXXX',
    );
    expect(duplicates.add).toHaveBeenCalledTimes(1);
    expect(duplicates.add.mock.calls[0]![0]).toMatchObject({ id: out.question.id, createdAt: T0 });

    expect(await publicQueue()).toContain(out.question.id);
    const voter = await createUser();
    expect((await vote(e, voter.user, out.question.id, 1)).status).toBe(200);
  });

  it('reject: stored rejected with the reason, which the author gets; counts toward the block', async () => {
    const u = await createUser();
    const out = await created(await submit(e, u.user, body('#reject Should we ban fun?')));
    expect(out.question.status).toBe('rejected');
    expect(out.moderation).toEqual({ outcome: 'rejected', reason: REJECT_REASON });
    expect(out.quota).toEqual({ remainingToday: 2, rejectionsLast7Days: 1, blockedUntil: null });
    expect(await stored(out.question.id)).toMatchObject({
      status: 'rejected',
      needs_review: 0,
      rejection_reason: REJECT_REASON,
      rejected_at: T0,
    });
    expect(JSON.parse((await stored(out.question.id)).moderation_json!)).toMatchObject({
      decision: 'reject',
      reason: REJECT_REASON,
    });
    expect(duplicates.add).not.toHaveBeenCalled();
    expect(await publicQueue()).not.toContain(out.question.id);
    const voter = await createUser();
    const res = await vote(e, voter.user, out.question.id, 1);
    expect(res.status).toBe(409);
  });

  it('review: stored submitted with needs_review; not listed publicly; no votes', async () => {
    const u = await createUser();
    const out = await created(await submit(e, u.user, body('#review Cake or pie?')));
    expect(out.question.status).toBe('submitted');
    expect(out.moderation).toEqual({ outcome: 'review', reason: null });
    expect(out.quota).toEqual({ remainingToday: 2, rejectionsLast7Days: 0, blockedUntil: null });
    const row = await stored(out.question.id);
    expect(row).toMatchObject({
      status: 'submitted',
      needs_review: 1,
      rejection_reason: null,
      rejected_at: null,
    });
    expect(JSON.parse(row.moderation_json!)).toMatchObject({
      decision: 'review',
      reviewCause: 'refusal',
    });
    // Indexed, so a later near-duplicate is still caught.
    expect(duplicates.add).toHaveBeenCalledTimes(1);
    expect(await publicQueue()).not.toContain(out.question.id);
    expect((await list(e, u.user, '?status=queued')).status).toBe(200);
    const voter = await createUser();
    const res = await vote(e, voter.user, out.question.id, 1);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
  });

  it('a failed model call also goes to review, never to an automatic rejection', async () => {
    const u = await createUser();
    model.classify.mockImplementationOnce(() =>
      Promise.resolve<ModelVerdict>({ kind: 'error', error: 'timeout' }),
    );
    const out = await created(await submit(e, u.user, body('Sunrise or sunset?')));
    expect(out.moderation.outcome).toBe('review');
    expect(await stored(out.question.id)).toMatchObject({ status: 'submitted', needs_review: 1 });
  });
});

describe('3 submissions per game day', () => {
  it('a 4th in the game day is 429 rate_limited (Retry-After: the game day’s end), before Turnstile and moderation; the next game day is fresh', async () => {
    const u = await createUser();
    const prompts = ['Tea or coffee?', '#reject Is water wet?', '#review Mountains or sea?'];
    for (const [i, prompt] of prompts.entries()) {
      setClock(e, T0 + i * MINUTE);
      const out = await created(await submit(e, u.user, body(prompt)));
      expect(out.quota.remainingToday).toBe(2 - i);
    }
    model.classify.mockClear();
    siteverify.mockClear();

    for (const t of [T0 + 3 * MINUTE, T0_DAY_END - 1]) {
      setClock(e, t);
      const res = await submit(e, u.user, body('Cats or dogs?'));
      expect(res.status).toBe(429);
      expect(await errorCode(res)).toBe('rate_limited');
      expect(res.headers.get('Retry-After')).toBe(String(Math.ceil((T0_DAY_END - t) / 1000)));
    }
    expect(model.classify).not.toHaveBeenCalled();
    expect(siteverify).not.toHaveBeenCalled();
    expect(await countQuestions(u.id)).toBe(3);

    // 21:00 New York: a new game day.
    setClock(e, T0_DAY_END);
    const out = await created(await submit(e, u.user, body('Cats or dogs?')));
    expect(out.quota).toEqual({ remainingToday: 2, rejectionsLast7Days: 1, blockedUntil: null });
    expect(await countQuestions(u.id)).toBe(4);
  });

  it('two concurrent submissions for the last slot: one is stored, the other is 429', async () => {
    const u = await createUser();
    for (const prompt of ['Tea or coffee?', 'Beach or pool?']) {
      await created(await submit(e, u.user, body(prompt)));
    }
    // Both requests pass the quota check before either stores: moderation waits for both.
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothIn = new Promise<void>((resolve) => (release = resolve));
    model.classify.mockImplementation(async (q) => {
      if (++arrived === 2) release();
      await bothIn;
      return verdictFor(q);
    });
    const results = await Promise.all([
      submit(e, u.user, body('Summer or winter?')),
      submit(e, u.user, body('Books or films?')),
    ]);
    expect(arrived).toBe(2);
    expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
    const refused = results.find((r) => r.status === 429)!;
    expect(await errorCode(refused)).toBe('rate_limited');
    expect(await countQuestions(u.id)).toBe(3);
  });
});

describe('Turnstile', () => {
  it('a token is required: 403 turnstile_failed without one, before moderation', async () => {
    const u = await createUser();
    const res = await submit(e, u.user, { ...VALID_BODY, turnstileToken: undefined });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('turnstile_failed');
    expect(siteverify).not.toHaveBeenCalled();
    expect(model.classify).not.toHaveBeenCalled();
    expect(await countQuestions(u.id)).toBe(0);
  });

  it('a token siteverify rejects: 403 turnstile_failed, nothing stored', async () => {
    const u = await createUser();
    siteverify.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ success: false, 'error-codes': ['invalid-input-response'] })),
    );
    const res = await submit(e, u.user, body('Cats or dogs?', { turnstileToken: 'bad' }));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('turnstile_failed');
    expect(siteverify).toHaveBeenCalledTimes(1);
    expect(model.classify).not.toHaveBeenCalled();
    expect(await countQuestions(u.id)).toBe(0);
  });
});

describe('format (spec "Core game rules" › Question format)', () => {
  const opts = (a: Record<string, unknown>, b: Record<string, unknown> = { label: 'No' }) => ({
    options: [a, b],
  });
  it.each([
    ['a prompt over 120 characters', body('x'.repeat(120) + '?')],
    ['an empty prompt', body('')],
    ['a prompt of spaces', body('    ')],
    ['a prompt over two lines', body('Cats\nor dogs?')],
    [
      'labels equal after trimming and case folding',
      body('Q?', opts({ label: 'Yes' }, { label: ' YES ' })),
    ],
    ['a label over 24 characters', body('Q?', opts({ label: 'y'.repeat(25) }))],
    ['a label of spaces', body('Q?', opts({ label: '   ' }))],
    ['an emoji that is text', body('Q?', opts({ label: 'Yes', emoji: 'ok' }))],
    ['two emoji', body('Q?', opts({ label: 'Yes', emoji: '👍👍' }))],
    ['an empty emoji', body('Q?', opts({ label: 'Yes', emoji: '' }))],
    ['three options', body('Q?', { options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] })],
    ['one option', body('Q?', { options: [{ label: 'A' }] })],
    ['a category off the list', body('Q?', { category: 'sports' })],
    ['no category', { prompt: 'Q?', options: VALID_BODY.options, turnstileToken: 'x' }],
    ['an unknown field', body('Q?', { status: 'queued' })],
  ])('%s is 400 bad_request and never reaches Turnstile or moderation', async (_what, b) => {
    const u = await createUser();
    const res = await submit(e, u.user, b);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('bad_request');
    expect(siteverify).not.toHaveBeenCalled();
    expect(model.classify).not.toHaveBeenCalled();
    expect(await countQuestions(u.id)).toBe(0);
  });

  it('a prompt of exactly 120 characters and single emoji of every shape are accepted', async () => {
    const u = await createUser();
    const out = await created(
      await submit(e, u.user, body('y'.repeat(119) + '?', opts({ label: 'Yes', emoji: '👩🏽‍💻' }))),
    );
    expect(out.question.prompt).toHaveLength(120);
    expect(out.question.options[0].emoji).toBe('👩🏽‍💻');
    for (const ok of ['👍', '👍🏽', '🇺🇸', '1️⃣', '❤️', '👩‍👩‍👧', '🏳️‍🌈']) {
      expect(isSingleEmoji(ok), ok).toBe(true);
    }
    for (const bad of ['a', '1', '👍👍', '👍 ', ':)', '🇺🇸🇺🇸', '']) {
      expect(isSingleEmoji(bad), bad).toBe(false);
    }
  });
});

describe('who can submit', () => {
  it('401 without a session', async () => {
    const res = await submit(e, undefined);
    expect(res.status).toBe(401);
  });

  it('a suspended account: 403 account_suspended before anything else is checked', async () => {
    const u = await createUser({ status: 'suspended' });
    const { headers } = await realSession(e, u.id);
    for (const b of [VALID_BODY, { prompt: '' }, body('Q?', { turnstileToken: undefined })]) {
      const res = await call(e, undefined, 'POST', '/questions', b, headers);
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('account_suspended');
    }
    expect(siteverify).not.toHaveBeenCalled();
    expect(model.classify).not.toHaveBeenCalled();
    expect(await countQuestions(u.id)).toBe(0);
  });
});
