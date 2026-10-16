// The house backlog alert (spec "Question pipeline" › House questions: "The admin is also alerted
// when the backlog drops below 14"): `queued` questions with no author are counted; below 14 an
// audit row and ALERT_SCHEDULE_GAP (`house_backlog_low`) at most once per 24 hours. The lock checks
// it after using a house question.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOUSE_BACKLOG_ALERT_EVERY_MS,
  HOUSE_BACKLOG_TARGET,
  checkHouseBacklog,
} from '../../src/questions/backlog.js';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import { lockRound } from '../../src/scheduler/lock.js';
import { alertSpy, drand } from '../anchor-do/helpers.js';
import {
  HOUR,
  creatorHarness,
  gapReasons,
  insertQuestion,
  roundRow,
} from '../scheduler/helpers.js';

afterEach(() => vi.restoreAllMocks());

const T0 = Date.UTC(2027, 7, 2, 12, 0, 0);

async function backlogAudit() {
  const { results } = await env.DB.prepare(
    "SELECT data_json, created_at FROM audit_log WHERE action = 'schedule_gap' AND target = ?1 ORDER BY created_at",
  )
    .bind(HOUSE_BACKLOG_TARGET)
    .all<{ data_json: string; created_at: number }>();
  return results.map((r) => ({ ...JSON.parse(r.data_json), at: r.created_at }) as object);
}

const clearBacklog = () =>
  env.DB.prepare("UPDATE questions SET status = 'used' WHERE author_user_id IS NULL").run();
const clearAudit = () =>
  env.DB.prepare('DELETE FROM audit_log WHERE target = ?1').bind(HOUSE_BACKLOG_TARGET).run();

describe('checkHouseBacklog', () => {
  it('counts only queued house questions; 13 alerts, 14 does not', async () => {
    for (let i = 0; i < 13; i++) await insertQuestion();
    // Not in the backlog: authored, or no longer queued.
    await insertQuestion({ author: newUlid() });
    await insertQuestion({ status: 'scheduled' });
    await insertQuestion({ status: 'used' });
    await insertQuestion({ status: 'submitted' });
    const alerts = alertSpy();
    expect(await checkHouseBacklog(env, T0)).toEqual({ count: 13, alerted: true });
    expect(gapReasons(alerts.spy)).toEqual(['house_backlog_low']);
    expect(await backlogAudit()).toEqual([
      { reason: 'house_backlog_low', count: 13, min: 14, at: T0 },
    ]);

    await clearAudit();
    await insertQuestion();
    expect(await checkHouseBacklog(env, T0 + 1)).toEqual({ count: 14, alerted: false });
    expect(await backlogAudit()).toEqual([]);
    expect(gapReasons(alerts.spy)).toEqual(['house_backlog_low']);
    await clearBacklog();
  });

  it('alerts at most once per 24 hours while the backlog stays low', async () => {
    await clearAudit();
    for (let i = 0; i < 3; i++) await insertQuestion();
    const alerts = alertSpy();
    const t = T0 + 10 * 24 * HOUR;
    const checks = [
      [t, true],
      [t + HOUR, false],
      [t + HOUSE_BACKLOG_ALERT_EVERY_MS - 1, false],
      [t + HOUSE_BACKLOG_ALERT_EVERY_MS, true],
      [t + HOUSE_BACKLOG_ALERT_EVERY_MS + 1, false],
    ] as const;
    for (const [at, alerted] of checks) {
      expect(await checkHouseBacklog(env, at)).toEqual({ count: 3, alerted });
    }
    expect(gapReasons(alerts.spy)).toEqual(['house_backlog_low', 'house_backlog_low']);
    expect((await backlogAudit()).map((a) => (a as { at: number }).at)).toEqual([
      t,
      t + HOUSE_BACKLOG_ALERT_EVERY_MS,
    ]);
    await clearBacklog();
  });
});

describe('the lock checks the backlog', () => {
  const h = creatorHarness();
  let day = 0;
  async function round(questionId: string | null) {
    const slot = dailySlot(`2027-09-${String(++day).padStart(2, '0')}`);
    const id = (await insertDailyRound(env.DB, slot)) as string;
    if (questionId) {
      await env.DB.prepare('UPDATE rounds SET question_id = ?2 WHERE id = ?1')
        .bind(id, questionId)
        .run();
    }
    return { id, lockAt: slot.opensAt - 6 * HOUR };
  }

  it('after a lock that used a house question, not after an authored one', async () => {
    await clearAudit();
    await insertQuestion({ score: 3 });
    const alerts = alertSpy();

    // An authored question: no backlog check, even though the backlog is low.
    const authored = await round(await insertQuestion({ author: newUlid(), status: 'scheduled' }));
    expect(await lockRound(h.env, drand, await roundRow(authored.id), authored.lockAt)).toEqual({
      status: 'locked',
      houseFill: false,
    });
    expect(gapReasons(alerts.spy)).toEqual([]);

    // A gap filled with the last house question: the gap, then the empty backlog.
    const filled = await round(null);
    expect(await lockRound(h.env, drand, await roundRow(filled.id), filled.lockAt)).toEqual({
      status: 'locked',
      houseFill: true,
    });
    expect(gapReasons(alerts.spy)).toEqual(['no_question', 'house_backlog_low']);
    expect(await backlogAudit()).toEqual([
      { reason: 'house_backlog_low', count: 0, min: 14, at: filled.lockAt },
    ]);
  });
});
