// Room rounds in the scheduler (spec "Profiles, leaderboards and rooms" › Rooms: room rounds use the
// daily schedule and the RoundDO class, one per room round; "Round lifecycle" › Scheduling). The
// hourly job creates them ahead for every open room; the lock picks their question (a mirror room's
// is the daily question of the same slot, a custom room's the owner's) and freezes minEntrants 3 and
// no creator award; a room round with nothing to lock, or of a closed room, closes quietly; Stakes
// stays behind `rooms.stakes.enabled`; and the tick locks a slot's daily round first and initialises
// one RoundDO per locked room round.
import { env } from 'cloudflare:test';
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  ROOM_MIN_QUALIFYING_ENTRANTS,
  addGameDays,
  type LockedConfig,
} from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomSlotsAhead } from '../../src/rooms/schedule.js';
import {
  createRoomRoundsAhead,
  createRoundsAhead,
  dailySlot,
  insertDailyRound,
  slotsAhead,
  type DailySlot,
} from '../../src/scheduler/create.js';
import { lockRound } from '../../src/scheduler/lock.js';
import { schedulerTick } from '../../src/scheduler/tick.js';
import { alertSpy, drand } from '../anchor-do/helpers.js';
import {
  chainHarness,
  creatorHarness,
  insertQuestion,
  modeRows,
  roundRow,
  setClock,
} from '../scheduler/helpers.js';
import {
  HOUR,
  MIN,
  insertRoom,
  insertRoomQuestion,
  insertRoomRoundRow,
  insertUser,
  setStakesFlags,
} from './round-helpers.js';

afterEach(() => vi.restoreAllMocks());

const h = creatorHarness();
const TREASURY = '0x000000000000000000000000000000000000beef';
const STAKES_DRAFT = {
  beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
  free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
  stakes: { ...LOCKED_CONFIG_DEFAULTS.stakes, creator: TREASURY },
};

const configOf = async (id: string): Promise<LockedConfig> =>
  LockedConfigSchema.parse(JSON.parse((await roundRow(id)).config_json ?? 'null'));

async function roomRounds(roomId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, question_id, opens_at, closes_at, status, config_json FROM rounds WHERE kind = 'room' AND room_id = ?1 ORDER BY closes_at",
  )
    .bind(roomId)
    .all<{
      id: string;
      question_id: string | null;
      opens_at: number;
      closes_at: number;
      status: string;
      config_json: string | null;
    }>();
  return results;
}

async function gapRows(roundId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule_gap' AND target = ?1",
  )
    .bind(roundId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

let days = 0;
/** A fresh daily slot (its own game day) for one test; `lockAt` is its question lock. */
function freshSlot(): DailySlot & { lockAt: number } {
  const slot = dailySlot(addGameDays('2027-09-01', ++days * 3));
  return { ...slot, lockAt: slot.opensAt - 6 * HOUR };
}

/** The daily round of `slot`, with a scheduled question by `author` (default: a house question). */
async function dailyRound(slot: DailySlot, author: string | null = null) {
  const id = (await insertDailyRound(env.DB, slot)) as string;
  const qId = await insertQuestion({ author, status: 'scheduled' });
  await env.DB.prepare('UPDATE rounds SET question_id = ?2 WHERE id = ?1').bind(id, qId).run();
  return { id, qId };
}

describe('room round creation (the hourly job)', () => {
  it('creates one room round per open mirror and custom room per slot whose lock is ahead, idempotently; none for a closed room', async () => {
    const mirror = await insertRoom({ source: 'daily' });
    const custom = await insertRoom({ source: 'custom' });
    const closed = await insertRoom({ source: 'custom', closedAt: 1 });
    // 3 h before a daily slot opens: its lock has passed, so it gets no room round.
    const t = dailySlot('2027-08-10').opensAt - 3 * HOUR;
    const slots = roomSlotsAhead(t);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    expect(slots.length).toBeLessThan(slotsAhead(t).length);

    const created = await createRoundsAhead(env, t);
    for (const room of [mirror, custom]) {
      const rows = await roomRounds(room.roomId);
      expect(rows.map((r) => [r.opens_at, r.closes_at])).toEqual(
        slots.map((s) => [s.opensAt, s.closesAt]),
      );
      for (const r of rows) {
        expect(r).toMatchObject({ question_id: null, status: 'scheduled', config_json: null });
        expect(created).toContain(r.id);
      }
    }
    expect(await roomRounds(closed.roomId)).toEqual([]);
    // The daily rounds come first, then exactly the new room rounds.
    expect(created).toHaveLength(slotsAhead(t).length + 2 * slots.length);

    // Idempotent: the next hour's run finds every round there.
    expect(await createRoundsAhead(env, t + 1)).toEqual([]);
    expect(await roomRounds(mirror.roomId)).toHaveLength(slots.length);
  });

  it('pages through the open rooms, filling only the slots a room is missing', async () => {
    const t = dailySlot('2027-08-20').opensAt - 3 * HOUR;
    const slots = roomSlotsAhead(t);
    const rooms = [];
    for (let i = 0; i < 3; i++)
      rooms.push(await insertRoom({ source: i === 1 ? 'custom' : 'daily' }));
    // One room already has the first slot's round (made at room creation, say).
    const existing = await insertRoomRoundRow(rooms[0]!.roomId, slots[0]!);
    const { results: open } = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM rooms WHERE closed_at IS NULL',
    ).all<{ n: number }>();

    const created = await createRoomRoundsAhead(env.DB, t, 1);
    expect(created).toHaveLength((open[0]?.n ?? 0) * slots.length - 1);
    expect(created).not.toContain(existing);
    for (const room of rooms) expect(await roomRounds(room.roomId)).toHaveLength(slots.length);
    expect(await createRoomRoundsAhead(env.DB, t, 1)).toEqual([]);
  });
});

describe('room round lock', () => {
  it('a mirror room’s round waits for the daily lock, quietly, then takes the daily question', async () => {
    const s = freshSlot();
    const author = await insertUser();
    const daily = await dailyRound(s, author);
    const { roomId } = await insertRoom({ source: 'daily' });
    const id = await insertRoomRoundRow(roomId, s);
    const alerts = alertSpy();

    expect(await lockRound(h.env, drand, await roundRow(id), s.lockAt)).toEqual({
      status: 'refused',
      reason: 'awaiting_daily',
    });
    expect(await roundRow(id)).toMatchObject({ status: 'scheduled', locked_at: null });
    expect(alerts.codes()).toEqual([]);
    expect(await gapRows(id)).toBe(0);

    expect((await lockRound(h.env, drand, await roundRow(daily.id), s.lockAt)).status).toBe(
      'locked',
    );
    const notices = h.notify.messages.length; // the daily lock's question_used to the author
    expect(await lockRound(h.env, drand, await roundRow(id), s.lockAt + MIN)).toEqual({
      status: 'locked',
      houseFill: false,
    });
    const row = await roundRow(id);
    expect(row).toMatchObject({ question_id: daily.qId, locked_at: s.lockAt + MIN });
    expect(row.beacon_round).toBe((await roundRow(daily.id)).beacon_round);
    // The room minimum and no creator award, though the daily round pays its author one.
    expect((await configOf(id)).free).toMatchObject({
      minEntrants: ROOM_MIN_QUALIFYING_ENTRANTS,
      awardRecipient: null,
    });
    expect((await configOf(daily.id)).free).toMatchObject({
      minEntrants: 1,
      awardRecipient: author,
    });
    expect((await modeRows(id)).map((m) => m.mode)).toEqual(['free']);
    expect(h.notify.messages.length).toBe(notices);
    expect(alerts.codes()).toEqual([]);
  });

  it('a mirror room’s round on a day with no daily round closes quietly', async () => {
    const s = freshSlot();
    const daily = (await insertDailyRound(env.DB, s)) as string;
    await env.DB.prepare("UPDATE rounds SET status = 'closed' WHERE id = ?1").bind(daily).run();
    const { roomId } = await insertRoom({ source: 'daily' });
    const id = await insertRoomRoundRow(roomId, s);
    const alerts = alertSpy();
    expect(await lockRound(h.env, drand, await roundRow(id), s.lockAt)).toEqual({
      status: 'closed',
      reason: 'no_daily_round',
    });
    expect(await roundRow(id)).toMatchObject({ status: 'closed', locked_at: null });
    expect(alerts.codes()).toEqual([]);
    expect(await gapRows(id)).toBe(0);
  });

  it('a custom room’s round locks with the owner’s question, minEntrants 3 and no creator award', async () => {
    const s = freshSlot();
    const { roomId, owner } = await insertRoom({ source: 'custom' });
    const qId = await insertRoomQuestion(roomId, { author: owner });
    const id = await insertRoomRoundRow(roomId, s, { questionId: qId });
    const notices = h.notify.messages.length;
    expect(await lockRound(h.env, drand, await roundRow(id), s.lockAt)).toEqual({
      status: 'locked',
      houseFill: false,
    });
    expect(await roundRow(id)).toMatchObject({ question_id: qId, locked_at: s.lockAt });
    expect(await configOf(id)).toEqual({
      beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
      free: { ...LOCKED_CONFIG_DEFAULTS.free, minEntrants: 3, awardRecipient: null },
    });
    const q = await env.DB.prepare('SELECT status FROM questions WHERE id = ?1').bind(qId).first();
    expect(q).toEqual({ status: 'used' });
    // question_used is for daily rounds' authors only.
    expect(h.notify.messages.length).toBe(notices);
  });

  it('a custom room’s round without a usable question of its own closes quietly, for good', async () => {
    const alerts = alertSpy();
    const { roomId } = await insertRoom({ source: 'custom' });
    const other = await insertRoom({ source: 'custom' });
    const cases = [
      null,
      await insertRoomQuestion(roomId, { status: 'rejected' }),
      await insertRoomQuestion(roomId, { status: 'submitted' }),
      await insertRoomQuestion(other.roomId), // another room's question
      await insertQuestion({ status: 'scheduled' }), // a public question
    ];
    for (const questionId of cases) {
      const s = freshSlot();
      const id = await insertRoomRoundRow(roomId, s, { questionId });
      expect(
        await lockRound(h.env, drand, await roundRow(id), s.lockAt),
        String(questionId),
      ).toEqual({ status: 'closed', reason: 'no_question' });
      expect(await roundRow(id)).toMatchObject({ status: 'closed', locked_at: null });
      expect(await gapRows(id)).toBe(0);
      // Final: a later call (a stale row included) never locks it.
      expect(
        await lockRound(
          h.env,
          drand,
          { ...(await roundRow(id)), status: 'scheduled' },
          s.lockAt + MIN,
        ),
      ).toEqual({ status: 'already_locked' });
      expect((await lockRound(h.env, drand, await roundRow(id), s.lockAt + MIN)).status).toBe(
        'refused',
      );
    }
    expect(alerts.codes()).toEqual([]);
  });

  it('a closed room’s round closes quietly, even with a question', async () => {
    const s = freshSlot();
    const { roomId } = await insertRoom({ source: 'custom' });
    const qId = await insertRoomQuestion(roomId);
    const id = await insertRoomRoundRow(roomId, s, { questionId: qId });
    await env.DB.prepare('UPDATE rooms SET closed_at = ?2 WHERE id = ?1')
      .bind(roomId, s.lockAt)
      .run();
    const alerts = alertSpy();
    expect(await lockRound(h.env, drand, await roundRow(id), s.lockAt)).toEqual({
      status: 'closed',
      reason: 'room_closed',
    });
    expect(await roundRow(id)).toMatchObject({
      status: 'closed',
      locked_at: null,
      question_id: qId,
    });
    expect(alerts.codes()).toEqual([]);
    expect(await gapRows(id)).toBe(0);
  });
});

describe('Stakes in room rounds', () => {
  async function lockDraft(draft: object) {
    const s = freshSlot();
    const { roomId } = await insertRoom({ source: 'custom' });
    const id = await insertRoomRoundRow(roomId, s, {
      questionId: await insertRoomQuestion(roomId),
      draft,
    });
    expect((await lockRound(h.env, drand, await roundRow(id), s.lockAt)).status).toBe('locked');
    return { config: await configOf(id), modes: (await modeRows(id)).map((m) => m.mode) };
  }

  it('without rooms.stakes.enabled and mode.stakes.enabled both on, a draft’s Stakes section is stripped', async () => {
    for (const flags of [
      { rooms: false, stakes: false },
      { rooms: false, stakes: true },
      { rooms: true, stakes: false },
    ]) {
      await setStakesFlags(flags);
      const { config, modes } = await lockDraft(STAKES_DRAFT);
      expect(config.stakes, JSON.stringify(flags)).toBeUndefined();
      expect(config.free?.minEntrants).toBe(3);
      expect(modes).toEqual(['free']);
    }
    // A Stakes-only draft still leaves the room its Free mode.
    await setStakesFlags({ rooms: false, stakes: false });
    const stakesOnly = await lockDraft({
      beaconDelay: STAKES_DRAFT.beaconDelay,
      stakes: STAKES_DRAFT.stakes,
    });
    expect(stakesOnly.config.free).toMatchObject({ minEntrants: 3, awardRecipient: null });
    expect(stakesOnly.modes).toEqual(['free']);
  });

  it('with both flags on it keeps the draft’s Stakes mode, with minEntrants 3 and the draft’s creator', async () => {
    await setStakesFlags({ rooms: true, stakes: true });
    try {
      const { config, modes } = await lockDraft(STAKES_DRAFT);
      expect(config.stakes).toMatchObject({
        stake: LOCKED_CONFIG_DEFAULTS.stakes.stake,
        minEntrants: 3,
        creator: TREASURY,
        payoutAddress: null,
      });
      expect(config.free?.minEntrants).toBe(3);
      expect(modes).toEqual(['free', 'stakes']);
      // A room draft without Stakes stays Free only.
      expect((await lockDraft({ beaconDelay: 120 })).modes).toEqual(['free']);
    } finally {
      await setStakesFlags({ rooms: false, stakes: false });
    }
  });
});

describe('the tick and room rounds', () => {
  it('locks a slot’s daily round before its room rounds and initialises one RoundDO per room round', async () => {
    const s = freshSlot();
    const daily = await dailyRound(s);
    const mirror = await insertRoom({ source: 'daily' });
    const custom = await insertRoom({ source: 'custom' });
    // An ID that sorts before the daily round's: only the kind ordering locks the daily first.
    const mirrorRound = await insertRoomRoundRow(mirror.roomId, s, {
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(mirrorRound < daily.id).toBe(true);
    const customRound = await insertRoomRoundRow(custom.roomId, s, {
      questionId: await insertRoomQuestion(custom.roomId),
    });
    const chain = await chainHarness(s.lockAt);
    setClock(s.lockAt);
    const report = await schedulerTick(env, chain.deps);
    expect(report.locks[daily.id]).toBe('locked');
    expect(report.locks[mirrorRound]).toBe('locked');
    expect(report.locks[customRound]).toBe('locked');
    expect((await roundRow(mirrorRound)).question_id).toBe(daily.qId);
    for (const id of [daily.id, mirrorRound, customRound]) {
      expect(report.initialized).toContain(id);
      expect(report.lockLeaves).toContain(id);
    }
    for (const id of [mirrorRound, customRound]) {
      const state = await env.ROUND.get(env.ROUND.idFromName(id)).getState();
      expect(state).toMatchObject({
        roundId: id,
        status: 'scheduled',
        opensAt: s.opensAt,
        closesAt: s.closesAt,
      });
      expect(state.modes).toEqual({ free: { status: 'pending', entrantCount: 0, pool: '0' } });
    }

    // A custom room's round with nothing to lock is reported closed and leaves the next tick alone.
    const later = freshSlot();
    const empty = await insertRoomRoundRow(custom.roomId, later);
    setClock(later.lockAt);
    const next = await schedulerTick(env, chain.deps);
    expect(next.locks[empty]).toBe('closed:no_question');
    setClock(later.lockAt + MIN);
    expect((await schedulerTick(env, chain.deps)).locks[empty]).toBeUndefined();
  });
});
