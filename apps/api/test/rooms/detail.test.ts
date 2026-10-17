// GET /rooms/:id (spec "API"; "Profiles, leaderboards and rooms" › Rooms; "API" › Reveal gating):
// members only (anonymous 401, non-member 404 exactly as an unknown room, `private, no-store`), the
// members with their room balances, the current round, the room-round visit grant (+100 below
// 1,000, a skip final for that round), the room leaderboard (ranks with ties, wins this week,
// streaks with refunds neutral) and member picks, never before the Free mode's `revealed_at`.
import { env } from 'cloudflare:test';
import { RoomDetailResponseSchema, newUlid, type RoomDetailResponse } from '@flocked/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { PRIVATE_CACHE_CONTROL } from '../../src/read/cache.js';
import {
  DAY,
  HOUR,
  MINUTE,
  T0,
  TODAY,
  call,
  createUser,
  errorCode,
  publicUser,
  roomBalance,
  roomLedger,
  roomsEnv,
  seedRoom,
  seedRoomRound,
  type TestUser,
} from './helpers.js';

let e: Env;
beforeAll(() => {
  e = roomsEnv();
  // An open round's live counts come from its RoundDO, which these D1-only rounds don't have; the
  // read falls back to D1 with a warning.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

/** Game day 2026-10-`d`'s window (opens 21:00 New York the day before). */
const day = (d: number) => ({
  opensAt: Date.UTC(2026, 9, d, 1),
  closesAt: Date.UTC(2026, 9, d + 1, 1),
});

async function detail(as: TestUser, roomId: string, at = e): Promise<RoomDetailResponse> {
  const res = await call(at, as.user, 'GET', `/rooms/${roomId}`);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe(PRIVATE_CACHE_CONTROL);
  return RoomDetailResponseSchema.parse(await res.json());
}

/** A room with an owner and members joined an hour apart, each with `balance` room points. */
async function room(n: number, balance = 500) {
  const people = [];
  for (let i = 0; i < n; i++) people.push(await createUser());
  const [owner, ...rest] = people as [TestUser, ...TestUser[]];
  const seeded = await seedRoom({
    owner: { user: owner, joinedAt: T0 - 10 * DAY, balance },
    members: rest.map((u, i) => ({ user: u, joinedAt: T0 - 10 * DAY + (i + 1) * HOUR, balance })),
  });
  return { ...seeded, owner, members: rest, people };
}

describe('access', () => {
  it('Non-member entry and view rejected', async () => {
    const r = await room(2);
    const open = await seedRoomRound({ roomId: r.id, ...TODAY, status: 'open' });
    const outsider = await createUser();

    const view = await call(e, outsider.user, 'GET', `/rooms/${r.id}`);
    const unknown = await call(e, outsider.user, 'GET', `/rooms/${newUlid()}`);
    expect(view.status).toBe(404);
    expect(view.headers.get('Cache-Control')).toBe(PRIVATE_CACHE_CONTROL);
    const body = await view.json();
    expect(body).toEqual(await unknown.json());
    expect(body).toMatchObject({ error: { code: 'not_found' } });

    // Entering the room's open round, or reading it, is refused as for an unknown round.
    const entry = await call(e, outsider.user, 'POST', `/rounds/${open}/entries`, {
      stake: '25',
      ciphertext: 'AAAA',
    });
    expect(entry.status).toBe(404);
    expect(await errorCode(entry)).toBe('not_found');
    expect((await call(e, outsider.user, 'GET', `/rounds/${open}`)).status).toBe(404);
    const entries = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE user_id = ?1')
      .bind(outsider.id)
      .first<{ n: number }>();
    expect(entries?.n).toBe(0);
    // No visit grant for an outsider either.
    expect(await roomBalance(outsider.id, r.id)).toBeNull();
  });

  it('answers 401 without a session, private, no-store', async () => {
    const r = await room(1);
    const res = await call(e, undefined, 'GET', `/rooms/${r.id}`);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
    expect(res.headers.get('Cache-Control')).toBe(PRIVATE_CACHE_CONTROL);
  });

  it('answers 404 to a member of a closed room', async () => {
    const owner = await createUser();
    const closed = await seedRoom({ owner: { user: owner, joinedAt: T0 - DAY }, closedAt: T0 - 1 });
    const res = await call(e, owner.user, 'GET', `/rooms/${closed.id}`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
  });
});

describe('members and the current round', () => {
  it('lists every member with role and balance; a deleted member is the opaque ID alone', async () => {
    const owner = await createUser();
    const member = await createUser();
    const gone = await createUser({ status: 'deleted' });
    const fresh = await createUser();
    const r = await seedRoom({
      owner: { user: owner, joinedAt: T0 - 3 * DAY, balance: 640 },
      members: [
        { user: gone, joinedAt: T0 - 2 * DAY, balance: 300 },
        { user: member, joinedAt: T0 - DAY, balance: 500 },
        { user: fresh, joinedAt: T0 - HOUR },
      ],
    });
    const d = await detail(member, r.id);
    // `memberCount` is the cap's count, so the deleted member is left out of it (W9-F1); every
    // member row is still listed below.
    expect(d.room).toMatchObject({ id: r.id, ownerUserId: owner.id, memberCount: 3 });
    expect(d.members).toEqual([
      { user: publicUser(owner), role: 'owner', joinedAt: T0 - 3 * DAY, balance: '640' },
      {
        user: { id: gone.id, handle: null, displayName: null, avatarUrl: null },
        role: 'member',
        joinedAt: T0 - 2 * DAY,
        balance: '300',
      },
      { user: publicUser(member), role: 'member', joinedAt: T0 - DAY, balance: '500' },
      { user: publicUser(fresh), role: 'member', joinedAt: T0 - HOUR, balance: '0' },
    ]);
    // Before the room's first round: nothing current, nothing revealed.
    expect(d.currentRound).toBeNull();
    expect(d.memberPicks).toBeNull();
    // The leaderboard leaves the deleted account out.
    expect(d.leaderboard.map((row) => row.user.id)).toEqual([owner.id, member.id, fresh.id]);
  });

  it('serves the open round, else the latest one that has opened, never one still ahead', async () => {
    const r = await room(1);
    const past = await seedRoomRound({ roomId: r.id, ...day(14) });
    await seedRoomRound({ roomId: r.id, ...day(16), locked: true, status: 'scheduled' });
    let d = await detail(r.owner, r.id);
    expect(d.currentRound).toMatchObject({ id: past, kind: 'room', roomId: r.id });

    const open = await seedRoomRound({ roomId: r.id, ...TODAY, status: 'open' });
    d = await detail(r.owner, r.id);
    expect(d.currentRound).toMatchObject({ id: open, status: 'open', gameDay: '2026-10-15' });
  });
});

describe('the room-round visit grant', () => {
  it('credits +100 on the first visit while a round is open, once', async () => {
    const r = await room(2);
    const open = await seedRoomRound({ roomId: r.id, ...TODAY, status: 'open' });
    const [member] = r.members as [TestUser];
    let d = await detail(member, r.id);
    expect(d.members.find((m) => m.user.id === member.id)?.balance).toBe('600');
    d = await detail(member, r.id);
    expect(await roomBalance(member.id, r.id)).toBe(600);
    expect(await roomLedger(member.id, r.id)).toEqual([
      { delta: 100, reason: 'room_grant', ref_id: open },
    ]);
    // Only the visitor is credited.
    expect(await roomBalance(r.owner.id, r.id)).toBe(500);
    expect(d.leaderboard[0]).toMatchObject({ rank: 1, user: { id: member.id }, balance: '600' });
  });

  it('skips at 1,000 or more, and the skip stays final for that round after the balance drops', async () => {
    const r = await room(1, 1000);
    const open = await seedRoomRound({ roomId: r.id, ...TODAY, status: 'open' });
    await detail(r.owner, r.id);
    expect(await roomBalance(r.owner.id, r.id)).toBe(1000);
    const skip = await env.DB.prepare(
      'SELECT balance FROM daily_grant_skips WHERE user_id = ?1 AND round_id = ?2',
    )
      .bind(r.owner.id, open)
      .first<{ balance: number }>();
    expect(skip).toEqual({ balance: 1000 });

    await env.DB.prepare(
      'UPDATE point_balances SET balance = 900 WHERE user_id = ?1 AND scope = ?2',
    )
      .bind(r.owner.id, r.id)
      .run();
    await detail(r.owner, r.id);
    expect(await roomBalance(r.owner.id, r.id)).toBe(900);
    expect(await roomLedger(r.owner.id, r.id)).toEqual([]);
  });

  it('credits nothing while no round is open', async () => {
    const r = await room(1);
    await seedRoomRound({ roomId: r.id, ...day(14) });
    await seedRoomRound({ roomId: r.id, opensAt: TODAY.closesAt, closesAt: TODAY.closesAt + DAY });
    // Open in D1 but outside its window (its close alarm hasn't run yet).
    await seedRoomRound({ roomId: r.id, ...day(13), status: 'open' });
    await detail(r.owner, r.id);
    expect(await roomBalance(r.owner.id, r.id)).toBe(500);
    expect(await roomLedger(r.owner.id, r.id)).toEqual([]);
  });
});

describe('the room leaderboard', () => {
  it('ranks by room balance; equal balances share a rank, then the earlier joiner first', async () => {
    const owner = await createUser();
    const [a, b, c, d] = [
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const r = await seedRoom({
      owner: { user: owner, joinedAt: T0 - 5 * DAY, balance: 500 },
      members: [
        { user: a, joinedAt: T0 - 4 * DAY, balance: 700 },
        { user: b, joinedAt: T0 - 6 * DAY, balance: 700 },
        { user: c, joinedAt: T0 - 3 * DAY, balance: 900 },
        { user: d, joinedAt: T0 - 2 * DAY, balance: 500 },
      ],
    });
    const out = await detail(owner, r.id);
    expect(out.leaderboard.map((row) => [row.rank, row.user.id, row.balance])).toEqual([
      [1, c.id, '900'],
      [2, b.id, '700'],
      [2, a.id, '700'],
      [4, owner.id, '500'],
      [4, d.id, '500'],
    ]);
  });

  it('counts wins in the current ISO week and streaks over settled rounds; refunds are neutral', async () => {
    const r = await room(4);
    const [a, b, c, d] = r.people as [TestUser, TestUser, TestUser, TestUser];
    // Game days 2026-10-12 (Mon) .. 10-15 (Thu) are ISO week 2026-W42; 10-10 and 10-11 are W41.
    await seedRoomRound({
      roomId: r.id,
      ...day(14),
      free: { status: 'settled', winner: 0 },
      entries: [
        { user: a, pick: 0 },
        { user: b, pick: 1 },
        { user: c, pick: 'void' },
      ],
    });
    await seedRoomRound({
      roomId: r.id,
      ...day(13),
      free: { status: 'settled', winner: 1 },
      entries: [
        { user: a, pick: 1 },
        { user: b, pick: 1 },
      ],
    });
    await seedRoomRound({
      roomId: r.id,
      ...day(12),
      free: { status: 'refunded' },
      entries: [
        { user: a, pick: 0 },
        { user: b, pick: 0 },
        { user: c, pick: 1 },
      ],
    });
    await seedRoomRound({
      roomId: r.id,
      ...day(11),
      free: { status: 'settled', winner: 0 },
      entries: [
        { user: a, pick: 0 },
        { user: b, pick: 0 },
        { user: c, pick: 0 },
      ],
    });
    await seedRoomRound({
      roomId: r.id,
      ...day(10),
      free: { status: 'settled', winner: 0 },
      entries: [
        { user: a, pick: 1 },
        { user: b, pick: 0 },
        { user: c, pick: 0 },
      ],
    });
    await seedRoomRound({ roomId: r.id, ...day(9), free: { status: 'voided' } });
    // Today's round is open (not final), and a round awaiting its reveal counts for nothing yet.
    await seedRoomRound({ roomId: r.id, ...TODAY, status: 'open' });
    await seedRoomRound({
      roomId: r.id,
      ...day(8),
      free: { status: 'settled', winner: 0, revealedAt: null },
      entries: [{ user: d, pick: 0 }],
    });

    const out = await detail(a, r.id);
    const score = (u: TestUser) => {
      const row = out.leaderboard.find((x) => x.user.id === u.id);
      return [row?.winsThisWeek, row?.streak];
    };
    // a: won 14, 13, (12 refunded), 11, lost 10 → streak 3; this week: 14 and 13.
    expect(score(a)).toEqual([2, 3]);
    // b: lost 14 → no streak; this week: 13.
    expect(score(b)).toEqual([1, 0]);
    // c: VOID on 14 → no streak; absent on 13; won 11 (last week).
    expect(score(c)).toEqual([0, 0]);
    // d: entered only the unrevealed round.
    expect(score(d)).toEqual([0, 0]);
  });
});

describe('member picks', () => {
  it('are hidden before the Free reveal and shown after it, VOID as null', async () => {
    const r = await room(3);
    const [a, b, c] = r.people as [TestUser, TestUser, TestUser];
    const earlier = await seedRoomRound({
      roomId: r.id,
      ...day(13),
      free: { status: 'settled', winner: 1 },
      entries: [{ user: a, pick: 1 }],
    });
    // Settlement has decrypted the entries but not yet set revealed_at: the dangerous window.
    const latest = await seedRoomRound({
      roomId: r.id,
      ...day(14),
      free: { status: 'revealing', revealedAt: null },
      entries: [
        { user: a, pick: 0 },
        { user: b, pick: 1 },
        { user: c, pick: 'void' },
      ],
    });
    let out = await detail(a, r.id);
    // The earlier, revealed round's picks; nothing of the latest one.
    expect(out.memberPicks).toEqual({
      roundId: earlier,
      picks: [{ user: publicUser(a), option: 1 }],
    });
    expect(out.currentRound).toMatchObject({ id: latest });
    expect(out.currentRound?.modes.free?.settlement).toBeNull();

    await env.DB.prepare(
      "UPDATE round_modes SET status = 'settled', revealed_at = ?2, final_at = ?2 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(latest, day(14).closesAt + 5 * MINUTE)
      .run();
    out = await detail(a, r.id);
    expect(out.memberPicks).toEqual({
      roundId: latest,
      picks: [
        { user: publicUser(a), option: 0 },
        { user: publicUser(b), option: 1 },
        { user: publicUser(c), option: null },
      ],
    });
  });
});
