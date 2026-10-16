// The game day with no daily round (decision E4; spec "Question pipeline" › House questions: "If
// nothing can be locked (no scheduled question and an empty backlog), that game day has no daily
// round. The admin is alerted"). The daily round is closed unlocked at its question lock, with an
// audit row and ALERT_SCHEDULE_GAP (`no_daily_round`); it never locks later, nothing recreates it,
// the reads never show it, and the next day's round is unaffected. A custom room's round without a
// question closes too, but quietly (W8-D; more in test/rooms/rounds.test.ts).
import { env } from 'cloudflare:test';
import { addGameDays, newUlid } from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readToday } from '../../src/read/rounds.js';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import { lockRound } from '../../src/scheduler/lock.js';
import { schedulerTick } from '../../src/scheduler/tick.js';
import { alertSpy, drand } from '../anchor-do/helpers.js';
import { request } from '../read/helpers.js';
import {
  HOUR,
  MIN,
  chainHarness,
  gapReasons,
  insertQuestion,
  roundRow,
  setClock,
} from '../scheduler/helpers.js';

afterEach(() => vi.restoreAllMocks());

async function gapAudit(roundId: string) {
  const { results } = await env.DB.prepare(
    "SELECT data_json, created_at FROM audit_log WHERE action = 'schedule_gap' AND target = ?1",
  )
    .bind(roundId)
    .all<{ data_json: string; created_at: number }>();
  return results.map((r) => ({ ...JSON.parse(r.data_json), at: r.created_at }) as object);
}

async function dailyRounds(closesAt: number) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM rounds WHERE kind = 'daily' AND closes_at = ?1",
  )
    .bind(closesAt)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

describe('a daily round with no question and an empty house backlog', () => {
  it('is refused and closed unlocked, with an audit row and one alert; the reads never show it', async () => {
    // This file starts with no questions at all: the backlog is empty.
    const slot = dailySlot('2027-06-02');
    const id = (await insertDailyRound(env.DB, slot)) as string;
    const lockAt = slot.opensAt - 6 * HOUR;
    const alerts = alertSpy();
    expect(await lockRound(env, drand, await roundRow(id), lockAt)).toEqual({
      status: 'refused',
      reason: 'no_house_question',
    });
    expect(await roundRow(id)).toMatchObject({
      status: 'closed',
      locked_at: null,
      question_id: null,
      config_json: null,
    });
    expect(await gapAudit(id)).toEqual([
      {
        reason: 'no_daily_round',
        gameDay: '2027-06-02',
        opensAt: slot.opensAt,
        alerted: true,
        at: lockAt,
      },
    ]);
    expect(alerts.codes()).toEqual(['ALERT_SCHEDULE_GAP']);
    expect(gapReasons(alerts.spy)).toEqual(['no_daily_round']);

    // Every later call (a stale read included) leaves it as it is, without alerting again.
    await insertQuestion({ score: 1 }); // a house question arrives
    expect(await lockRound(env, drand, await roundRow(id), lockAt + MIN)).toEqual({
      status: 'refused',
      reason: 'no_daily_round',
    });
    const stale = { ...(await roundRow(id)), status: 'scheduled' as const };
    expect(await lockRound(env, drand, stale, lockAt + 2 * MIN)).toEqual({
      status: 'already_locked',
    });
    expect(await roundRow(id)).toMatchObject({ status: 'closed', locked_at: null });
    expect(alerts.codes()).toEqual(['ALERT_SCHEDULE_GAP']);
    await env.DB.prepare("UPDATE questions SET status = 'used' WHERE author_user_id IS NULL").run();

    // The reads require locked_at: no such round, and no round today.
    expect((await request(`/rounds/${id}`)).status).toBe(404);
    expect((await readToday(env, slot.opensAt + HOUR)).round).toBeNull();
  });

  it('the tick: no lock after a house question arrives, no new round for the day, the next day locks', async () => {
    const prev = dailySlot('2027-06-09');
    const day = dailySlot('2027-06-10');
    const next = dailySlot(addGameDays('2027-06-10', 1));
    const lockAt = day.opensAt - 6 * HOUR;
    const h = await chainHarness(lockAt);
    // The day before is locked already (with the last house question); the next one exists.
    const prevId = (await insertDailyRound(env.DB, prev)) as string;
    await insertQuestion({ score: 1 });
    expect(
      await lockRound(env, drand, await roundRow(prevId), prev.opensAt - 6 * HOUR),
    ).toMatchObject({ status: 'locked' });
    const id = (await insertDailyRound(env.DB, day)) as string;
    const nextId = (await insertDailyRound(env.DB, next)) as string;

    const alerts = alertSpy();
    setClock(lockAt);
    let report = await schedulerTick(env, h.deps);
    expect(report.locks[id]).toBe('refused:no_house_question');
    expect(report.createdForGap).toEqual([]);
    expect(await roundRow(id)).toMatchObject({ status: 'closed', locked_at: null });
    expect(gapReasons(alerts.spy)).toEqual(['no_daily_round']);

    // A house question arrives: the closed day stays closed, and nothing recreates it.
    const house = await insertQuestion({ score: 5 });
    setClock(lockAt + MIN);
    report = await schedulerTick(env, h.deps);
    expect(report.locks[id]).toBeUndefined();
    expect(report.createdForGap).toEqual([]);
    expect(await roundRow(id)).toMatchObject({ status: 'closed', locked_at: null });
    expect(await dailyRounds(day.closesAt)).toEqual([id]);

    // The next day's round locks at its own lock, with that house question.
    setClock(next.opensAt - 6 * HOUR);
    report = await schedulerTick(env, h.deps);
    expect(report.locks[nextId]).toBe('locked');
    expect(report.locks[id]).toBeUndefined();
    expect(report.createdForGap).toEqual([]);
    expect(await roundRow(nextId)).toMatchObject({ question_id: house });
    expect(await roundRow(id)).toMatchObject({ status: 'closed', locked_at: null });
    expect(gapReasons(alerts.spy).filter((g) => g === 'no_daily_round')).toHaveLength(1);
  });

  it('a custom room round without a question is closed unlocked, quietly (no alert, no gap row)', async () => {
    const slot = dailySlot('2027-06-20');
    const id = newUlid();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rooms (id, name, owner_user_id, invite_code, question_source, created_at) VALUES ('room-e4', 'E4', ?1, 'invite-e4', 'custom', 0)",
      ).bind(newUlid()),
      env.DB.prepare(
        "INSERT INTO rounds (id, kind, room_id, opens_at, closes_at) VALUES (?1, 'room', 'room-e4', ?2, ?3)",
      ).bind(id, slot.opensAt, slot.closesAt),
    ]);
    const alerts = alertSpy();
    expect(await lockRound(env, drand, await roundRow(id), slot.opensAt - 6 * HOUR)).toEqual({
      status: 'closed',
      reason: 'no_question',
    });
    expect(await roundRow(id)).toMatchObject({ status: 'closed', locked_at: null });
    expect(alerts.codes()).toEqual([]);
    expect(await gapAudit(id)).toEqual([]);
  });
});
