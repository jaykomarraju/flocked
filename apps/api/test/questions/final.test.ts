// The post-final question handler (src/questions/final.ts): split quality per settled mode of a
// daily round ("Question pipeline" step 5), the author's `question_used` (settled) notice, and
// idempotency (a retried settlement or a re-processed chain event calls it again).
import { env } from 'cloudflare:test';
import { NotifyMessageSchema, newUlid, type Mode, type NotifyMessage } from '@flocked/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { onQuestionModeFinal, splitQuality } from '../../src/questions/final.js';

const T = Date.UTC(2026, 9, 15, 12, 0, 0);
const HOUR = 3_600_000;

/** A per-test env whose notify queue records what is sent. */
function testEnv() {
  const sent: NotifyMessage[] = [];
  const send = vi.fn((m: NotifyMessage) => {
    sent.push(m);
    return Promise.resolve();
  });
  const queue = { send, sendBatch: vi.fn(() => Promise.resolve()) };
  const e = {
    ...env,
    ENVIRONMENT: 'local' as const,
    FLOCKED_TEST_CLOCK: String(T),
    QUEUE_NOTIFY: queue as unknown as Env['QUEUE_NOTIFY'],
  };
  return { env: e, sent, send };
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

interface ModeSetup {
  status: string;
  /** The current settlement record; omitted for none. */
  outcome?: 'settled' | 'refunded' | 'voided';
  headcounts?: [number, number];
  /** A superseded earlier record (Stakes: a vetoed proposal). */
  superseded?: { outcome: 'settled' | 'refunded'; headcounts: [number, number] };
}

let closeSeq = 0;

/** A locked round (daily unless `room`) with one mode in the given state; returns its IDs. */
async function setup(
  mode: Mode,
  m: ModeSetup,
  o: { author?: string | null; room?: boolean } = {},
): Promise<{ roundId: string; questionId: string }> {
  const roundId = newUlid();
  const questionId = newUlid();
  const closesAt = Date.UTC(2026, 9, 9, 1) + ++closeSeq * 24 * HOUR;
  const db = env.DB;
  const roomId = o.room ? newUlid() : null;
  const tally = (n: [number, number]) =>
    JSON.stringify([
      { headcount: n[0], total: String(n[0] * 100) },
      { headcount: n[1], total: String(n[1] * 100) },
    ]);
  const record = (seq: number, outcome: string, n: [number, number], superseded: number | null) =>
    db
      .prepare(
        'INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json, superseded_at) ' +
          'VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)',
      )
      .bind(roundId, mode, seq, outcome, tally(n), superseded);
  const terminal = ['settled', 'refunded', 'voided'].includes(m.status);
  await db.batch([
    db
      .prepare(
        "INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at) VALUES (?1, ?2, 'Sheep or goats?', ?3, 'food', 'used', 0)",
      )
      .bind(
        questionId,
        o.author ?? null,
        JSON.stringify([
          { label: 'Sheep', emoji: '' },
          { label: 'Goats', emoji: '' },
        ]),
      ),
    db
      .prepare(
        'INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json) ' +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'closed', ?7, '{}')",
      )
      .bind(
        roundId,
        roomId ? 'room' : 'daily',
        roomId,
        questionId,
        closesAt - 24 * HOUR,
        closesAt,
        closesAt - 30 * HOUR,
      ),
    db
      .prepare('INSERT INTO round_modes (round_id, mode, status, final_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(roundId, mode, m.status, terminal ? closesAt + HOUR : null),
    ...(m.superseded
      ? [record(0, m.superseded.outcome, m.superseded.headcounts, closesAt + HOUR)]
      : []),
    ...(m.outcome ? [record(m.superseded ? 1 : 0, m.outcome, m.headcounts ?? [3, 2], null)] : []),
  ]);
  return { roundId, questionId };
}

async function splits(roundId: string) {
  const { results } = await env.DB.prepare(
    'SELECT round_id, mode, question_id, split_quality, entrants, created_at FROM question_splits WHERE round_id = ?1 ORDER BY mode',
  )
    .bind(roundId)
    .all<{
      round_id: string;
      mode: string;
      question_id: string;
      split_quality: number;
      entrants: number;
      created_at: number;
    }>();
  return results;
}

describe('splitQuality (1 − (maxShare − 0.5) / 0.5)', () => {
  it('is 1.0 for an even split, 0.8 for 60/40 either way round, 0.02 for 99/1', () => {
    expect(splitQuality(50, 50)).toBe(1);
    expect(splitQuality(60, 40)).toBe(0.8);
    expect(splitQuality(40, 60)).toBe(0.8);
    expect(splitQuality(99, 1)).toBe(0.02);
    expect(splitQuality(3, 1)).toBe(0.5);
  });

  it('refuses headcounts with no valid entry', () => {
    expect(() => splitQuality(0, 0)).toThrow(RangeError);
    expect(() => splitQuality(-1, 3)).toThrow(RangeError);
  });
});

describe('onQuestionModeFinal', () => {
  it('records a settled Free mode of a daily round and tells the author', async () => {
    const author = await insertUser();
    const { roundId, questionId } = await setup(
      'free',
      { status: 'settled', outcome: 'settled', headcounts: [60, 40] },
      { author },
    );
    const t = testEnv();
    await onQuestionModeFinal(t.env, { roundId, mode: 'free' });
    expect(await splits(roundId)).toEqual([
      {
        round_id: roundId,
        mode: 'free',
        question_id: questionId,
        split_quality: 0.8,
        entrants: 100,
        created_at: T,
      },
    ]);
    expect(t.sent).toHaveLength(1);
    expect(NotifyMessageSchema.parse(t.sent[0])).toEqual({
      event: 'question_used',
      userId: author,
      dedupeKey: `question_used:${questionId}:settled`,
      payload: { questionId, stage: 'settled', roundId },
    });
  });

  it('uses the valid headcounts: an even split is 1.0 and a 99/1 split 0.02', async () => {
    const even = await setup('free', { status: 'settled', outcome: 'settled', headcounts: [7, 7] });
    const lopsided = await setup('free', {
      status: 'settled',
      outcome: 'settled',
      headcounts: [99, 1],
    });
    const t = testEnv();
    await onQuestionModeFinal(t.env, { roundId: even.roundId, mode: 'free' });
    await onQuestionModeFinal(t.env, { roundId: lopsided.roundId, mode: 'free' });
    expect(await splits(even.roundId)).toMatchObject([{ split_quality: 1, entrants: 14 }]);
    expect(await splits(lopsided.roundId)).toMatchObject([{ split_quality: 0.02, entrants: 100 }]);
  });

  it('is idempotent: called twice, one row and the same dedupe key', async () => {
    const author = await insertUser();
    const { roundId, questionId } = await setup(
      'free',
      { status: 'settled', outcome: 'settled', headcounts: [2, 3] },
      { author },
    );
    const first = testEnv();
    await onQuestionModeFinal(first.env, { roundId, mode: 'free' });
    const second = testEnv();
    Object.assign(second.env, { FLOCKED_TEST_CLOCK: String(T + HOUR) });
    await onQuestionModeFinal(second.env, { roundId, mode: 'free' });
    expect(await splits(roundId)).toMatchObject([
      { mode: 'free', split_quality: 0.8, entrants: 5, created_at: T },
    ]);
    const keys = [...first.sent, ...second.sent].map((m) => m.dedupeKey);
    expect(new Set(keys)).toEqual(new Set([`question_used:${questionId}:settled`]));
  });

  it('records each settled mode once, under one notice key for the question', async () => {
    const author = await insertUser();
    const { roundId, questionId } = await setup(
      'free',
      { status: 'settled', outcome: 'settled', headcounts: [1, 1] },
      { author },
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO round_modes (round_id, mode, status, final_at) VALUES (?1, 'stakes', 'settled', 1)",
      ).bind(roundId),
      env.DB.prepare(
        "INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json) VALUES (?1, 'stakes', 0, 'settled', 1, ?2)",
      ).bind(
        roundId,
        JSON.stringify([
          { headcount: 3, total: '30000000' },
          { headcount: 1, total: '10000000' },
        ]),
      ),
    ]);
    const t = testEnv();
    await onQuestionModeFinal(t.env, { roundId, mode: 'free' });
    await onQuestionModeFinal(t.env, { roundId, mode: 'stakes' });
    expect(await splits(roundId)).toMatchObject([
      { mode: 'free', question_id: questionId, split_quality: 1, entrants: 2 },
      { mode: 'stakes', question_id: questionId, split_quality: 0.5, entrants: 4 },
    ]);
    expect(t.sent.map((m) => m.dedupeKey)).toEqual([
      `question_used:${questionId}:settled`,
      `question_used:${questionId}:settled`,
    ]);
  });

  it('writes nothing for a refunded or voided mode (no creator credit either)', async () => {
    const author = await insertUser();
    const refunded = await setup(
      'free',
      { status: 'refunded', outcome: 'refunded', headcounts: [5, 5] },
      { author },
    );
    const voided = await setup('free', { status: 'voided' }, { author });
    const vetoed = await setup(
      'stakes',
      {
        status: 'refunded',
        outcome: 'refunded',
        headcounts: [3, 1],
        superseded: { outcome: 'settled', headcounts: [3, 1] },
      },
      { author },
    );
    const t = testEnv();
    for (const [r, mode] of [
      [refunded, 'free'],
      [voided, 'free'],
      [vetoed, 'stakes'],
    ] as const) {
      await onQuestionModeFinal(t.env, { roundId: r.roundId, mode });
      expect(await splits(r.roundId)).toEqual([]);
    }
    expect(t.sent).toEqual([]);
  });

  it('writes nothing when the mode was refunded after a settle record (veto before the row was superseded)', async () => {
    const author = await insertUser();
    const { roundId } = await setup(
      'stakes',
      { status: 'refunded', outcome: 'settled', headcounts: [3, 1] },
      { author },
    );
    const t = testEnv();
    await onQuestionModeFinal(t.env, { roundId, mode: 'stakes' });
    expect(await splits(roundId)).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('counts a Stakes mode finalized in the same batch (status not yet settled, record settled)', async () => {
    const { roundId } = await setup('stakes', {
      status: 'settle_proposed',
      outcome: 'settled',
      headcounts: [3, 1],
    });
    const t = testEnv();
    await onQuestionModeFinal(t.env, { roundId, mode: 'stakes' });
    expect(await splits(roundId)).toMatchObject([{ mode: 'stakes', split_quality: 0.5 }]);
  });

  it('records nothing for a refund proposal finalized in the same batch, or a mode with no record', async () => {
    const author = await insertUser();
    const refund = await setup(
      'stakes',
      { status: 'refund_proposed', outcome: 'refunded', headcounts: [2, 2] },
      { author },
    );
    const pending = await setup('free', { status: 'pending' }, { author });
    const t = testEnv();
    await onQuestionModeFinal(t.env, { roundId: refund.roundId, mode: 'stakes' });
    await onQuestionModeFinal(t.env, { roundId: pending.roundId, mode: 'free' });
    expect(await splits(refund.roundId)).toEqual([]);
    expect(await splits(pending.roundId)).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('reads the current record: a vetoed refund proposal that later settled counts as settled', async () => {
    const { roundId } = await setup('stakes', {
      status: 'settled',
      outcome: 'settled',
      headcounts: [3, 1],
      superseded: { outcome: 'refunded', headcounts: [3, 1] },
    });
    const t = testEnv();
    await onQuestionModeFinal(t.env, { roundId, mode: 'stakes' });
    expect(await splits(roundId)).toMatchObject([{ mode: 'stakes', split_quality: 0.5 }]);
  });

  it('daily rounds only: a room round records nothing', async () => {
    const author = await insertUser();
    const { roundId } = await setup(
      'free',
      { status: 'settled', outcome: 'settled', headcounts: [2, 2] },
      { author, room: true },
    );
    const t = testEnv();
    await onQuestionModeFinal(t.env, { roundId, mode: 'free' });
    expect(await splits(roundId)).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('records a house question without a notice', async () => {
    const { roundId, questionId } = await setup('free', {
      status: 'settled',
      outcome: 'settled',
      headcounts: [4, 6],
    });
    const t = testEnv();
    await onQuestionModeFinal(t.env, { roundId, mode: 'free' });
    expect(await splits(roundId)).toMatchObject([{ question_id: questionId, split_quality: 0.8 }]);
    expect(t.sent).toEqual([]);
  });

  it('a failed send is logged, not raised, and the split is still recorded', async () => {
    const author = await insertUser();
    const { roundId } = await setup(
      'free',
      { status: 'settled', outcome: 'settled', headcounts: [1, 2] },
      { author },
    );
    const t = testEnv();
    t.send.mockImplementationOnce(() => Promise.reject(new Error('queue down')));
    await expect(onQuestionModeFinal(t.env, { roundId, mode: 'free' })).resolves.toBeUndefined();
    expect(await splits(roundId)).toHaveLength(1);
  });

  it('ignores an unknown round', async () => {
    const t = testEnv();
    await expect(
      onQuestionModeFinal(t.env, { roundId: newUlid(), mode: 'free' }),
    ).resolves.toBeUndefined();
    expect(t.sent).toEqual([]);
  });
});
