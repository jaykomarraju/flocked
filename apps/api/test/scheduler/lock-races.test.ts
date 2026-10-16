// The lock against the writes that change a round's question after the tick read it (W8-F1 M1, L1).
// The tick reads its due rounds, then locks them one by one; a room question stored, an Assign or a
// Reject can commit in between, and before the fix the lock acted on what it had read: a custom
// room's round closed `no_question` under a question just stored (the owner told "queued"), a
// replaced room question or an assigned daily question was overwritten (left `scheduled` on no
// round), and a Reject of the top house question was overwritten by `used`. Each test forces that
// order: the round row is read first (or the Reject lands just before the lock's batch).
import { env } from 'cloudflare:test';
import { addGameDays } from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import { lockRound } from '../../src/scheduler/lock.js';
import { drand } from '../anchor-do/helpers.js';
import { insertRoom, insertRoomQuestion, insertRoomRoundRow } from '../rooms/round-helpers.js';
import { HOUR, creatorHarness, insertQuestion, roundRow } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

const h = creatorHarness();
let days = 0;
function freshSlot() {
  const slot = dailySlot(addGameDays('2030-01-01', ++days * 3));
  return { ...slot, lockAt: slot.opensAt - 6 * HOUR };
}

async function statusOf(questionId: string): Promise<string | undefined> {
  const row = await env.DB.prepare('SELECT status FROM questions WHERE id = ?1')
    .bind(questionId)
    .first<{ status: string }>();
  return row?.status;
}

const setQuestion = (roundId: string, questionId: string) =>
  env.DB.prepare('UPDATE rounds SET question_id = ?2 WHERE id = ?1')
    .bind(roundId, questionId)
    .run();

/** h.env whose D1 runs `sql` (bound to `args`) just before the first batch: a write racing the lock. */
function racingEnv(sql: string, ...args: unknown[]): Env {
  let raced = false;
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await target
              .prepare(sql)
              .bind(...args)
              .run();
          }
          return target.batch(stmts);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { ...h.env, DB: db };
}

describe('a room question stored after the tick read the round (M1)', () => {
  it('is locked: the quiet no_question close applies only to the question_id read', async () => {
    const s = freshSlot();
    const { roomId, owner } = await insertRoom({ source: 'custom' });
    const id = await insertRoomRoundRow(roomId, s);
    const read = await roundRow(id); // no question yet
    const qId = await insertRoomQuestion(roomId, { author: owner });
    await setQuestion(id, qId);

    expect(await lockRound(h.env, drand, read, s.lockAt)).toEqual({
      status: 'locked',
      houseFill: false,
    });
    expect(await roundRow(id)).toMatchObject({
      status: 'scheduled',
      question_id: qId,
      locked_at: s.lockAt,
    });
    expect(await statusOf(qId)).toBe('used');
  });

  it('a replacement stored after the read is the one locked; the replaced one stays off the round', async () => {
    const s = freshSlot();
    const { roomId, owner } = await insertRoom({ source: 'custom' });
    const first = await insertRoomQuestion(roomId, { author: owner });
    const id = await insertRoomRoundRow(roomId, s, { questionId: first });
    const read = await roundRow(id);
    const second = await insertRoomQuestion(roomId, { author: owner });
    await setQuestion(id, second);

    expect(await lockRound(h.env, drand, read, s.lockAt)).toMatchObject({ status: 'locked' });
    expect((await roundRow(id)).question_id).toBe(second);
    expect(await statusOf(second)).toBe('used');
    expect(await statusOf(first)).toBe('scheduled');
  });
});

describe('the daily lock against Assign and Reject (L1)', () => {
  it('an Assign committed after the read is locked, not overwritten by a house fill', async () => {
    const s = freshSlot();
    const id = (await insertDailyRound(env.DB, s)) as string;
    const house = await insertQuestion({ status: 'queued', score: 1_000_000 });
    const read = await roundRow(id); // no question: the lock would fill it from the house backlog
    const assigned = await insertQuestion({ status: 'scheduled' });
    await setQuestion(id, assigned);

    expect(await lockRound(h.env, drand, read, s.lockAt)).toEqual({
      status: 'locked',
      houseFill: false,
    });
    expect((await roundRow(id)).question_id).toBe(assigned);
    expect(await statusOf(assigned)).toBe('used');
    expect(await statusOf(house)).toBe('queued');
  });

  it('an Assign committed after the read is locked, not closed as a no-round day', async () => {
    const s = freshSlot();
    const id = (await insertDailyRound(env.DB, s)) as string;
    // An empty house backlog: the lock would close the game day.
    await env.DB.prepare(
      "UPDATE questions SET status = 'used' WHERE author_user_id IS NULL AND status = 'queued'",
    ).run();
    const read = await roundRow(id);
    const assigned = await insertQuestion({ status: 'scheduled' });
    await setQuestion(id, assigned);

    expect(await lockRound(h.env, drand, read, s.lockAt)).toEqual({
      status: 'locked',
      houseFill: false,
    });
    expect(await roundRow(id)).toMatchObject({ status: 'scheduled', question_id: assigned });
  });

  it('a Reject of the top house question during the lock stays rejected; the next one is locked', async () => {
    const s = freshSlot();
    const id = (await insertDailyRound(env.DB, s)) as string;
    const top = await insertQuestion({ status: 'queued', score: 3_000_000 });
    const next = await insertQuestion({ status: 'queued', score: 2_000_000 });
    const e = racingEnv(
      "UPDATE questions SET status = 'rejected', rejection_reason = 'r', rejected_at = ?2 WHERE id = ?1",
      top,
      s.lockAt,
    );

    expect(await lockRound(e, drand, await roundRow(id), s.lockAt)).toEqual({
      status: 'locked',
      houseFill: true,
    });
    expect((await roundRow(id)).question_id).toBe(next);
    expect(await statusOf(top)).toBe('rejected');
    expect(await statusOf(next)).toBe('used');
  });
});
