// The admin console's question-queue actions (src/questions/admin.ts; spec "Admin console" ›
// Question queue and Schedule, "Question pipeline" step 4 and House questions): approve, reject with
// a reason (notice, 7-day block), assign to a day, edit before lock (notice, re-index), add a house
// question. Every action writes one audit_log row in the batch of its change.
import { env } from 'cloudflare:test';
import {
  AddHouseQuestionResponseSchema,
  ApproveQuestionResponseSchema,
  AssignQuestionResponseSchema,
  EditQuestionResponseSchema,
  NotifyMessageSchema,
  RejectQuestionResponseSchema,
  dailyClosesAt,
  newUlid,
  type NotifyMessage,
} from '@flocked/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { HttpError } from '../../src/lib/errors.js';
import { withModerationDeps } from '../../src/moderation/deps.js';
import type { DuplicateIndex, ModerationModel } from '../../src/moderation/index.js';
import {
  addHouseQuestion,
  approveQuestion,
  assignQuestion,
  editQuestion,
  rejectQuestion,
} from '../../src/questions/admin.js';

/** 2026-10-15 12:00 UTC: game day 2026-10-15 is open (its question lock has passed). */
const T = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY = 24 * 3_600_000;
const ADMIN = '01K7ADM1N000000000000000AA';

await env.DB.prepare(
  "INSERT INTO users (id, handle, role, ref_code, created_at) VALUES (?1, 'shepherd', 'admin', 'REFADMIN', 0)",
)
  .bind(ADMIN)
  .run();

/** A per-test env: the notify queue and Analytics Engine record, and moderation is faked. */
function testEnv() {
  const sent: NotifyMessage[] = [];
  const points: AnalyticsEngineDataPoint[] = [];
  const add = vi.fn<DuplicateIndex['add']>(() => Promise.resolve());
  const findDuplicate = vi.fn<DuplicateIndex['findDuplicate']>(() => Promise.resolve(null));
  const classify = vi.fn<ModerationModel['classify']>(() =>
    Promise.reject(new Error('admins are not moderated')),
  );
  const e = withModerationDeps(
    {
      ...env,
      QUEUE_NOTIFY: {
        send: (m: NotifyMessage) => {
          sent.push(m);
          return Promise.resolve();
        },
        sendBatch: () => Promise.resolve(),
      } as unknown as Env['QUEUE_NOTIFY'],
      ANALYTICS: { writeDataPoint: (p?: AnalyticsEngineDataPoint) => p && points.push(p) },
    },
    { duplicates: { add, findDuplicate }, model: { classify } },
  );
  return { env: e, sent, points, add, classify };
}

async function insertUser(): Promise<string> {
  const id = newUlid();
  await env.DB.prepare(
    'INSERT INTO users (id, handle, ref_code, created_at) VALUES (?1, ?2, ?3, 0)',
  )
    .bind(id, `ewe_${id.slice(-8).toLowerCase()}`, `REF${id.slice(-8)}`)
    .run();
  return id;
}

interface QuestionSetup {
  author?: string | null;
  status?: 'submitted' | 'rejected' | 'queued' | 'scheduled' | 'used';
  needsReview?: boolean;
  moderation?: Record<string, unknown>;
  rejectedAt?: number;
  prompt?: string;
}

async function insertQuestion(o: QuestionSetup = {}): Promise<string> {
  const id = newUlid();
  const status = o.status ?? 'submitted';
  const rejectedAt = status === 'rejected' ? (o.rejectedAt ?? T - DAY) : null;
  await env.DB.prepare(
    'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, moderation_json, created_at, needs_review, rejection_reason, rejected_at) ' +
      "VALUES (?1, ?2, ?3, ?4, 'food', ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(
      id,
      o.author ?? null,
      o.prompt ?? 'Coffee or tea first thing?',
      JSON.stringify([
        { label: 'Coffee', emoji: '☕' },
        { label: 'Tea', emoji: '' },
      ]),
      status,
      o.moderation ? JSON.stringify(o.moderation) : null,
      T - 2 * DAY,
      o.needsReview ? 1 : 0,
      rejectedAt === null ? null : 'Not a preference.',
      rejectedAt,
    )
    .run();
  return id;
}

async function questionRow(id: string) {
  return env.DB.prepare(
    'SELECT author_user_id, prompt, options_json, category, status, needs_review, rejection_reason, rejected_at FROM questions WHERE id = ?1',
  )
    .bind(id)
    .first<{
      author_user_id: string | null;
      prompt: string;
      options_json: string;
      category: string;
      status: string;
      needs_review: number;
      rejection_reason: string | null;
      rejected_at: number | null;
    }>();
}

async function auditRows(target: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, actor, actor_user_id, action, target, data_json, created_at FROM audit_log WHERE target = ?1 ORDER BY id',
  )
    .bind(target)
    .all<{
      id: string;
      actor: string;
      actor_user_id: string | null;
      action: string;
      target: string;
      data_json: string;
      created_at: number;
    }>();
  return results.map((r) => ({ ...r, data: JSON.parse(r.data_json) as unknown }));
}

/** The HttpError code a call is refused with. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

async function dailyRound(gameDay: string) {
  return env.DB.prepare(
    "SELECT id, question_id, locked_at, opens_at, closes_at, status FROM rounds WHERE kind = 'daily' AND closes_at = ?1",
  )
    .bind(dailyClosesAt(gameDay) * 1000)
    .first<{
      id: string;
      question_id: string | null;
      locked_at: number | null;
      opens_at: number;
      closes_at: number;
      status: string;
    }>();
}

const MODERATION = {
  version: 1,
  decision: 'review',
  reviewCause: 'refusal',
  predictedSplit: 0.8,
};

describe('approveQuestion', () => {
  it('moves a submitted question to queued, clears a pending review, and audits it', async () => {
    const author = await insertUser();
    const id = await insertQuestion({ author, needsReview: true, moderation: MODERATION });
    const t = testEnv();
    const res = ApproveQuestionResponseSchema.parse(await approveQuestion(t.env, ADMIN, id, T));
    expect(res.question).toMatchObject({
      id,
      status: 'queued',
      author: { id: author },
      moderation: MODERATION,
      predictedSplit: 0.8,
    });
    expect(await questionRow(id)).toMatchObject({ status: 'queued', needs_review: 0 });
    expect(await auditRows(id)).toEqual([
      expect.objectContaining({
        id: res.auditId,
        actor: 'admin',
        actor_user_id: ADMIN,
        action: 'question_approve',
        target: id,
        data: { from: 'submitted', needsReview: true },
        created_at: T,
      }),
    ]);
    expect(t.sent).toEqual([]);
  });

  it('refuses every other status with conflict and writes nothing', async () => {
    const t = testEnv();
    for (const status of ['queued', 'scheduled', 'used', 'rejected'] as const) {
      const id = await insertQuestion({ status });
      expect(await refusal(approveQuestion(t.env, ADMIN, id, T)), status).toBe('conflict');
      expect((await questionRow(id))?.status).toBe(status);
      expect(await auditRows(id)).toEqual([]);
    }
    expect(await refusal(approveQuestion(t.env, ADMIN, newUlid(), T))).toBe('not_found');
  });

  it('two concurrent approvals: one wins, the other is conflict, one audit row', async () => {
    const id = await insertQuestion();
    const t = testEnv();
    const results = await Promise.allSettled([
      approveQuestion(t.env, ADMIN, id, T),
      approveQuestion(t.env, ADMIN, id, T),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected && (rejected.reason as HttpError).code).toBe('conflict');
    expect(await auditRows(id)).toHaveLength(1);
  });
});

describe('rejectQuestion', () => {
  it('rejects a submitted or queued question with the reason, audits it and tells the author', async () => {
    for (const setup of [{ needsReview: true }, { status: 'queued' as const }]) {
      const author = await insertUser();
      const id = await insertQuestion({ author, ...setup });
      const t = testEnv();
      const reason = 'It asks for a fact, not a preference.';
      const res = RejectQuestionResponseSchema.parse(
        await rejectQuestion(t.env, ADMIN, id, `  ${reason} `, T),
      );
      expect(res.question).toMatchObject({ id, status: 'rejected' });
      expect(await questionRow(id)).toMatchObject({
        status: 'rejected',
        needs_review: 0,
        rejection_reason: reason,
        rejected_at: T,
      });
      expect(await auditRows(id)).toEqual([
        expect.objectContaining({
          id: res.auditId,
          actor: 'admin',
          actor_user_id: ADMIN,
          action: 'question_reject',
          data: { from: setup.status ?? 'submitted', reason },
        }),
      ]);
      expect(t.sent.map((m) => NotifyMessageSchema.parse(m))).toEqual([
        {
          event: 'question_rejected',
          userId: author,
          dedupeKey: `question_rejected:${id}`,
          payload: { questionId: id, reason },
        },
      ]);
    }
  });

  it('the 5th rejection in 7 days, by moderation or an admin, blocks submission for 7 days', async () => {
    const author = await insertUser();
    // Moderation rejections: three in the window, one just outside it.
    for (const at of [T - 6 * DAY, T - 3 * DAY, T - DAY, T - 8 * DAY]) {
      await insertQuestion({ author, status: 'rejected', rejectedAt: at });
    }
    const blockUntil = async () =>
      (
        await env.DB.prepare('SELECT question_block_until AS until FROM limits WHERE user_id = ?1')
          .bind(author)
          .first<{ until: number | null }>()
      )?.until ?? null;
    const t = testEnv();
    await rejectQuestion(t.env, ADMIN, await insertQuestion({ author }), 'Too vague.', T);
    expect(await blockUntil()).toBeNull(); // 4 in 7 days
    const fifth = T + 60_000;
    await rejectQuestion(t.env, ADMIN, await insertQuestion({ author }), 'Too vague.', fifth);
    expect(await blockUntil()).toBe(fifth + 7 * DAY);
  });

  it('a house question: no notice and no block', async () => {
    const id = await insertQuestion({ status: 'queued' });
    const t = testEnv();
    await rejectQuestion(t.env, ADMIN, id, 'Stale.', T);
    expect((await questionRow(id))?.status).toBe('rejected');
    expect(t.sent).toEqual([]);
  });

  it('refuses a scheduled (unassign first), used (locked) or rejected question, writing nothing', async () => {
    const author = await insertUser();
    const t = testEnv();
    for (const [status, code] of [
      ['scheduled', 'conflict'],
      ['used', 'question_locked'],
      ['rejected', 'conflict'],
    ] as const) {
      const id = await insertQuestion({ author, status });
      expect(await refusal(rejectQuestion(t.env, ADMIN, id, 'No.', T)), status).toBe(code);
      expect((await questionRow(id))?.status).toBe(status);
      expect(await auditRows(id)).toEqual([]);
    }
    expect(t.sent).toEqual([]);
  });

  it('needs a reason of 1 to 500 characters', async () => {
    const id = await insertQuestion();
    const t = testEnv();
    expect(await refusal(rejectQuestion(t.env, ADMIN, id, '   ', T))).toBe('bad_request');
    expect(await refusal(rejectQuestion(t.env, ADMIN, id, 'x'.repeat(501), T))).toBe('bad_request');
    expect((await questionRow(id))?.status).toBe('submitted');
  });
});

describe('assignQuestion', () => {
  it("schedules a queued question on a future day, creating the day's round, which points at it", async () => {
    const id = await insertQuestion({ author: await insertUser(), status: 'queued' });
    const t = testEnv();
    expect(await dailyRound('2026-10-20')).toBeNull();
    const res = AssignQuestionResponseSchema.parse(
      await assignQuestion(t.env, ADMIN, '2026-10-20', id, T),
    );
    const round = await dailyRound('2026-10-20');
    expect(round).toMatchObject({
      id: res.roundId,
      question_id: id,
      locked_at: null,
      status: 'scheduled',
      opens_at: dailyClosesAt('2026-10-19') * 1000,
    });
    expect(res).toEqual({
      gameDay: '2026-10-20',
      roundId: round?.id,
      questionId: id,
      auditId: res.auditId,
    });
    expect((await questionRow(id))?.status).toBe('scheduled');
    expect(await auditRows(id)).toEqual([
      expect.objectContaining({
        id: res.auditId,
        actor: 'admin',
        actor_user_id: ADMIN,
        action: 'question_assign',
        data: { gameDay: '2026-10-20', roundId: res.roundId, replaced: null },
      }),
    ]);
  });

  it('sends the question assigned before back to queued', async () => {
    const first = await insertQuestion({ status: 'queued' });
    const second = await insertQuestion({ status: 'queued' });
    const t = testEnv();
    const a = await assignQuestion(t.env, ADMIN, '2026-10-21', first, T);
    const b = await assignQuestion(t.env, ADMIN, '2026-10-21', second, T);
    expect(b.roundId).toBe(a.roundId);
    expect((await dailyRound('2026-10-21'))?.question_id).toBe(second);
    expect((await questionRow(first))?.status).toBe('queued');
    expect((await questionRow(second))?.status).toBe('scheduled');
    expect((await auditRows(second))[0]?.data).toEqual({
      gameDay: '2026-10-21',
      roundId: a.roundId,
      replaced: first,
    });
  });

  it('refuses a locked round and a day past its question lock (question_locked), writing nothing', async () => {
    const holder = await insertQuestion({ status: 'used' });
    const closesAt = dailyClosesAt('2026-10-22') * 1000;
    await env.DB.prepare(
      "INSERT INTO rounds (id, kind, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json) VALUES (?1, 'daily', ?2, ?3, ?4, 1, 'scheduled', ?5, '{}')",
    )
      .bind(newUlid(), holder, dailyClosesAt('2026-10-21') * 1000, closesAt, T - 1)
      .run();
    const id = await insertQuestion({ status: 'queued' });
    const t = testEnv();
    // Locked round; the open day (its lock at opensAt − 6 h passed); a past day; the lock boundary.
    expect(await refusal(assignQuestion(t.env, ADMIN, '2026-10-22', id, T))).toBe(
      'question_locked',
    );
    expect(await refusal(assignQuestion(t.env, ADMIN, '2026-10-15', id, T))).toBe(
      'question_locked',
    );
    expect(await refusal(assignQuestion(t.env, ADMIN, '2026-10-01', id, T))).toBe(
      'question_locked',
    );
    const lockAt = dailyClosesAt('2026-10-22') * 1000 - 6 * 3_600_000; // opensAt − 6 h
    expect(await refusal(assignQuestion(t.env, ADMIN, '2026-10-23', id, lockAt))).toBe(
      'question_locked',
    );
    expect((await questionRow(id))?.status).toBe('queued');
    expect((await dailyRound('2026-10-22'))?.question_id).toBe(holder);
    expect(await auditRows(id)).toEqual([]);
    // One millisecond before the lock it is still open.
    await assignQuestion(t.env, ADMIN, '2026-10-23', id, lockAt - 1);
    expect((await dailyRound('2026-10-23'))?.question_id).toBe(id);
  });

  it('assigns only a queued question, to a valid game day', async () => {
    const t = testEnv();
    for (const status of ['submitted', 'scheduled', 'used', 'rejected'] as const) {
      const id = await insertQuestion({ status });
      expect(await refusal(assignQuestion(t.env, ADMIN, '2026-10-24', id, T)), status).toBe(
        'conflict',
      );
      expect(await auditRows(id)).toEqual([]);
    }
    const id = await insertQuestion({ status: 'queued' });
    expect(await refusal(assignQuestion(t.env, ADMIN, 'tomorrow', id, T))).toBe('bad_request');
    expect(await refusal(assignQuestion(t.env, ADMIN, '2026-10-24', newUlid(), T))).toBe(
      'not_found',
    );
  });

  it('checks the house backlog after assigning (below 14 it alerts)', async () => {
    // Later than every other action in this file: the alert repeats at most once per 24 h.
    const later = T + 10 * DAY;
    const house = await insertQuestion({ status: 'queued' });
    const t = testEnv();
    await assignQuestion(t.env, ADMIN, '2026-11-05', house, later);
    const alert = t.points.find((p) => p.indexes?.[0] === 'ALERT_SCHEDULE_GAP');
    expect(alert?.blobs?.[3]).toContain('house_backlog_low');
    const row = await env.DB.prepare(
      "SELECT created_at FROM audit_log WHERE action = 'schedule_gap' AND target = 'house_backlog' ORDER BY created_at DESC LIMIT 1",
    ).first<{ created_at: number }>();
    expect(row?.created_at).toBe(later);
  });
});

describe('editQuestion', () => {
  it('edits the wording before lock: audited, the author told with the audit ID, re-indexed', async () => {
    const author = await insertUser();
    const id = await insertQuestion({ author, status: 'scheduled' });
    const t = testEnv();
    const res = EditQuestionResponseSchema.parse(
      await editQuestion(
        t.env,
        ADMIN,
        id,
        {
          prompt: '  Cats or dogs?  ',
          options: [{ label: 'Cats', emoji: '🐈' }, { label: 'Dogs' }],
          reason: 'Clearer wording',
        },
        T,
      ),
    );
    expect(res.question).toMatchObject({
      id,
      prompt: 'Cats or dogs?',
      options: [
        { label: 'Cats', emoji: '🐈' },
        { label: 'Dogs', emoji: '' },
      ],
      category: 'food',
      status: 'scheduled',
    });
    expect(await questionRow(id)).toMatchObject({
      prompt: 'Cats or dogs?',
      options_json: JSON.stringify([
        { label: 'Cats', emoji: '🐈' },
        { label: 'Dogs', emoji: '' },
      ]),
      status: 'scheduled',
    });
    expect(await auditRows(id)).toEqual([
      expect.objectContaining({
        id: res.auditId,
        actor: 'admin',
        actor_user_id: ADMIN,
        action: 'question_edit',
        data: {
          reason: 'Clearer wording',
          changes: {
            prompt: { from: 'Coffee or tea first thing?', to: 'Cats or dogs?' },
            options: {
              from: [
                { label: 'Coffee', emoji: '☕' },
                { label: 'Tea', emoji: '' },
              ],
              to: [
                { label: 'Cats', emoji: '🐈' },
                { label: 'Dogs', emoji: '' },
              ],
            },
          },
        },
      }),
    ]);
    expect(t.sent.map((m) => NotifyMessageSchema.parse(m))).toEqual([
      {
        event: 'question_edited',
        userId: author,
        dedupeKey: `question_edited:${res.auditId}`,
        payload: { questionId: id, auditId: res.auditId },
      },
    ]);
    expect(t.add).toHaveBeenCalledOnce();
    expect(t.add.mock.calls[0]?.[0]).toMatchObject({ id, createdAt: T - 2 * DAY });
    expect(t.add.mock.calls[0]?.[0].text).toContain('Cats or dogs?');
  });

  it('a category-only edit keeps the wording and is not re-indexed', async () => {
    const id = await insertQuestion({ status: 'queued' });
    const t = testEnv();
    const res = await editQuestion(
      t.env,
      ADMIN,
      id,
      { category: 'life', reason: 'Recategorized' },
      T,
    );
    expect(res.question).toMatchObject({ category: 'life', prompt: 'Coffee or tea first thing?' });
    expect((await auditRows(id))[0]?.data).toEqual({
      reason: 'Recategorized',
      changes: { category: { from: 'food', to: 'life' } },
    });
    expect(t.add).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]); // a house question has no author to tell
  });

  it('is refused after lock: a used question, or one a locked round points at', async () => {
    const author = await insertUser();
    const used = await insertQuestion({ author, status: 'used' });
    const stale = await insertQuestion({ author, status: 'scheduled' });
    await env.DB.prepare(
      "INSERT INTO rounds (id, kind, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json) VALUES (?1, 'daily', ?2, ?3, ?4, 1, 'scheduled', ?5, '{}')",
    )
      .bind(
        newUlid(),
        stale,
        dailyClosesAt('2026-10-25') * 1000,
        dailyClosesAt('2026-10-26') * 1000,
        T - 1,
      )
      .run();
    const t = testEnv();
    for (const id of [used, stale]) {
      expect(
        await refusal(editQuestion(t.env, ADMIN, id, { prompt: 'Cats or dogs?', reason: 'r' }, T)),
      ).toBe('question_locked');
      expect((await questionRow(id))?.prompt).toBe('Coffee or tea first thing?');
      expect(await auditRows(id)).toEqual([]);
    }
    expect(t.sent).toEqual([]);
    expect(t.add).not.toHaveBeenCalled();
  });

  it('checks the format, and refuses a rejected question and an edit that changes nothing', async () => {
    const id = await insertQuestion({ author: await insertUser() });
    const t = testEnv();
    const edit = (patch: Parameters<typeof editQuestion>[3]) =>
      refusal(editQuestion(t.env, ADMIN, id, patch, T));
    expect(await edit({ options: [{ label: 'Same' }, { label: ' same ' }], reason: 'r' })).toBe(
      'bad_request',
    );
    expect(
      await edit({ options: [{ label: 'A', emoji: 'ab' }, { label: 'B' }], reason: 'r' }),
    ).toBe('bad_request');
    expect(await edit({ prompt: 'x'.repeat(121), reason: 'r' })).toBe('bad_request');
    expect(await edit({ prompt: 'Coffee or tea first thing?', reason: 'r' })).toBe('bad_request');
    expect(await edit({ prompt: 'Cats or dogs?', reason: ' ' })).toBe('bad_request');
    expect(await auditRows(id)).toEqual([]);
    const rejected = await insertQuestion({ status: 'rejected' });
    expect(
      await refusal(editQuestion(t.env, ADMIN, rejected, { prompt: 'Cats?', reason: 'r' }, T)),
    ).toBe('conflict');
    expect(t.sent).toEqual([]);
  });
});

describe('addHouseQuestion', () => {
  it('adds a queued question with no author: not moderated, indexed and audited', async () => {
    const t = testEnv();
    const res = AddHouseQuestionResponseSchema.parse(
      await addHouseQuestion(
        t.env,
        ADMIN,
        {
          prompt: 'Window or aisle?',
          options: [{ label: 'Window', emoji: '🪟' }, { label: 'Aisle' }],
          category: 'life',
        },
        T,
      ),
    );
    const id = res.question.id;
    expect(res.question).toMatchObject({
      prompt: 'Window or aisle?',
      status: 'queued',
      author: null,
      score: 0,
      createdAt: T,
      moderation: null,
      predictedSplit: null,
    });
    expect(await questionRow(id)).toMatchObject({
      author_user_id: null,
      status: 'queued',
      category: 'life',
      needs_review: 0,
    });
    expect(await auditRows(id)).toEqual([
      expect.objectContaining({
        id: res.auditId,
        actor: 'admin',
        actor_user_id: ADMIN,
        action: 'question_add_house',
        target: id,
      }),
    ]);
    expect(t.classify).not.toHaveBeenCalled();
    expect(t.add).toHaveBeenCalledOnce();
    expect(t.add.mock.calls[0]?.[0]).toMatchObject({ id, createdAt: T });
  });

  it('refuses a bad format with bad_request and stores nothing', async () => {
    const t = testEnv();
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions').first<{
      n: number;
    }>();
    expect(
      await refusal(
        addHouseQuestion(
          t.env,
          ADMIN,
          {
            prompt: 'Yes or yes?',
            options: [{ label: 'Yes' }, { label: 'YES' }],
            category: 'other',
          },
          T,
        ),
      ),
    ).toBe('bad_request');
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions').first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
    expect(t.add).not.toHaveBeenCalled();
  });
});
