// Question lock (spec "Round lifecycle" › Scheduling; "Question pipeline" › House questions): when it
// happens, what it freezes, idempotence and immutability, house-question gap fills (ALERT-6), and the
// target-round check on non-default timing.
import { env } from 'cloudflare:test';
import {
  LOCKED_CONFIG_DEFAULTS,
  freeConfigHash,
  newUlid,
  questionHash,
  type LockedConfig,
  type QuestionOption,
} from '@flocked/shared';
import { firstRoundAtOrAfter } from '@flocked/tlock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import { freeLockItem, lockRound, type QuestionRow } from '../../src/scheduler/lock.js';
import { alertSpy, drand } from '../anchor-do/helpers.js';
import { HOUR, MIN, insertQuestion, modeRows, roundRow } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

let day = 0;
/** A fresh daily round (its own game day), with an optional scheduled question. */
async function newRound(questionId: string | null = null) {
  const slot = dailySlot(`2026-12-${String(++day).padStart(2, '0')}`);
  const id = (await insertDailyRound(env.DB, slot)) as string;
  if (questionId) {
    await env.DB.prepare('UPDATE rounds SET question_id = ?2 WHERE id = ?1')
      .bind(id, questionId)
      .run();
  }
  return { id, slot, lockAt: slot.opensAt - 6 * HOUR };
}

describe('lockRound', () => {
  it('freezes the question and config into rounds, creates round_modes, and marks the question used', async () => {
    const author = newUlid();
    const qId = await insertQuestion({ author, status: 'scheduled' });
    const r = await newRound(qId);
    const out = await lockRound(env, drand, await roundRow(r.id), r.lockAt);
    expect(out).toEqual({ status: 'locked', houseFill: false });

    const row = await roundRow(r.id);
    expect(row).toMatchObject({
      question_id: qId,
      locked_at: r.lockAt,
      status: 'scheduled',
      beacon_round: firstRoundAtOrAfter(drand, r.slot.closesAt / 1000 + 120),
    });
    expect(JSON.parse(row.config_json!)).toEqual({
      beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
      free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: author },
    });
    expect(await modeRows(r.id)).toEqual([
      { mode: 'free', status: 'pending', chain_round_id: null, lock_tx: null },
    ]);
    const q = await env.DB.prepare('SELECT status FROM questions WHERE id = ?1').bind(qId).first();
    expect(q).toEqual({ status: 'used' });
  });

  it('is idempotent and the locked round is immutable', async () => {
    const r = await newRound(await insertQuestion({ status: 'scheduled' }));
    await lockRound(env, drand, await roundRow(r.id), r.lockAt);
    const before = await roundRow(r.id);
    expect(await lockRound(env, drand, before, r.lockAt + MIN)).toEqual({
      status: 'already_locked',
    });
    // A stale read of the unlocked row cannot lock it a second time either.
    expect(
      await lockRound(
        env,
        drand,
        { ...before, locked_at: null, config_json: null },
        r.lockAt + MIN,
      ),
    ).toEqual({ status: 'already_locked' });
    expect(await roundRow(r.id)).toEqual(before);
    expect(await modeRows(r.id)).toHaveLength(1);

    for (const set of [
      "config_json = '{}'",
      'question_id = NULL',
      'beacon_round = beacon_round + 1',
      'closes_at = closes_at + 1000',
      'locked_at = NULL',
    ]) {
      await expect(
        env.DB.prepare(`UPDATE rounds SET ${set} WHERE id = ?1`).bind(r.id).run(),
      ).rejects.toThrow(/round_locked/);
    }
    // Status still moves.
    await env.DB.prepare("UPDATE rounds SET status = 'open' WHERE id = ?1").bind(r.id).run();
    expect((await roundRow(r.id)).status).toBe('open');
  });

  it('fills a gap with the top house question and raises ALERT_SCHEDULE_GAP (ALERT-6)', async () => {
    const alerts = alertSpy();
    await insertQuestion({ score: 5 });
    const top = await insertQuestion({ score: 9 });
    await insertQuestion({ score: 9, author: newUlid() }); // not a house question
    const r = await newRound();
    expect(await lockRound(env, drand, await roundRow(r.id), r.lockAt)).toEqual({
      status: 'locked',
      houseFill: true,
    });
    const row = await roundRow(r.id);
    expect(row.question_id).toBe(top);
    expect((JSON.parse(row.config_json!) as LockedConfig).free?.awardRecipient).toBeNull();
    expect(alerts.codes()).toEqual(['ALERT_SCHEDULE_GAP']);
    const audit = await env.DB.prepare(
      "SELECT data_json FROM audit_log WHERE action = 'schedule_gap' AND target = ?1",
    )
      .bind(r.id)
      .first<{ data_json: string }>();
    expect(JSON.parse(audit!.data_json)).toMatchObject({ reason: 'no_question', filledWith: top });
  });

  it('a rejected scheduled question is a gap too', async () => {
    const r = await newRound(await insertQuestion({ status: 'rejected', author: newUlid() }));
    const house = await insertQuestion({ score: 100 });
    await lockRound(env, drand, await roundRow(r.id), r.lockAt);
    expect((await roundRow(r.id)).question_id).toBe(house);
  });

  it('with no house question left it refuses, alerting at most once an hour', async () => {
    await env.DB.prepare("UPDATE questions SET status = 'used' WHERE author_user_id IS NULL").run();
    const alerts = alertSpy();
    const r = await newRound();
    const refused = { status: 'refused', reason: 'no_house_question' };
    expect(await lockRound(env, drand, await roundRow(r.id), r.lockAt)).toEqual(refused);
    expect(await lockRound(env, drand, await roundRow(r.id), r.lockAt + MIN)).toEqual(refused);
    expect(alerts.codes()).toEqual(['ALERT_SCHEDULE_GAP']);
    expect(await lockRound(env, drand, await roundRow(r.id), r.lockAt + HOUR + MIN)).toEqual(
      refused,
    );
    expect(alerts.codes()).toEqual(['ALERT_SCHEDULE_GAP', 'ALERT_SCHEDULE_GAP']);
    expect((await roundRow(r.id)).locked_at).toBeNull();
  });
});

describe('the target-round check at lock', () => {
  async function customRound(closesAt: number, beaconDelay: number) {
    const id = newUlid();
    const qId = await insertQuestion({ status: 'scheduled' });
    const config = {
      beaconDelay,
      free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
    };
    await env.DB.prepare(
      "INSERT INTO rounds (id, kind, question_id, opens_at, closes_at, config_json) VALUES (?1, 'daily', ?2, ?3, ?4, ?5)",
    )
      .bind(id, qId, closesAt - 24 * HOUR, closesAt, JSON.stringify(config))
      .run();
    return roundRow(id);
  }

  it('refuses a non-default close whose 10-minute delay cannot be met', async () => {
    // A close off the drand grid: the first round at or after close + 600 s is after close + 600 s.
    let close = Date.UTC(2027, 1, 3, 2, 0, 1) / 1000;
    while ((close + 600 - drand.genesis) % drand.period === 0) close += 1;
    const r = await customRound(close * 1000, 600);
    const alerts = alertSpy();
    expect(await lockRound(env, drand, r, r.opens_at - 6 * HOUR)).toEqual({
      status: 'refused',
      reason: 'beacon_too_late',
    });
    expect(alerts.codes()).toEqual(['ALERT_SCHEDULE_GAP']);
    expect((await roundRow(r.id)).locked_at).toBeNull();
  });

  it('accepts a non-default beaconDelay it can meet', async () => {
    const close = Date.UTC(2027, 1, 4, 2, 0, 0) / 1000; // 21:00 EST
    const r = await customRound(close * 1000, 60);
    expect((await lockRound(env, drand, r, r.opens_at - 6 * HOUR)).status).toBe('locked');
    expect((await roundRow(r.id)).beacon_round).toBe(firstRoundAtOrAfter(drand, close + 60));
  });

  it('refuses a lock whose beacon time has already passed', async () => {
    const close = Date.UTC(2027, 1, 5, 2, 0, 0);
    const r = await customRound(close, 120);
    expect(await lockRound(env, drand, r, close + 10 * MIN)).toMatchObject({
      status: 'refused',
      reason: 'beacon_in_past',
    });
  });
});

describe('the Free lock leaf', () => {
  it('commits closesAt, beaconRound, the question hash and configHash = freeConfigHash(config)', async () => {
    const qId = await insertQuestion({ status: 'scheduled', author: newUlid() });
    const r = await newRound(qId);
    await lockRound(env, drand, await roundRow(r.id), r.lockAt);
    const row = await roundRow(r.id);
    const q = (await env.DB.prepare('SELECT * FROM questions WHERE id = ?1')
      .bind(qId)
      .first()) as unknown as QuestionRow;
    const leaf = freeLockItem(row, q);
    expect(leaf).toMatchObject({
      roundId: r.id,
      mode: 'free',
      closesAtSec: r.slot.closesAt / 1000,
      beaconRound: row.beacon_round,
    });
    expect(leaf.configHash).toBe(freeConfigHash(JSON.parse(row.config_json!) as LockedConfig));
    expect(leaf.questionHash).toBe(
      questionHash({
        prompt: q.prompt,
        options: JSON.parse(q.options_json) as [QuestionOption, QuestionOption],
      }),
    );
  });
});
