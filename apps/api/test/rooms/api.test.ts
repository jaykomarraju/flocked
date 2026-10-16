// POST /rooms and POST /rooms/join (spec "Profiles, leaderboards and rooms" › Rooms; "API"): the
// owner's 500 room points at creation and the room's rounds ahead; joining by invite code with the
// 500 join grant once, the 50-member cap held in SQL, closed and unknown rooms answering 404; and
// suspended accounts refused on every room write with nothing written (spec "Identity and
// personhood" › Identities).
import { env } from 'cloudflare:test';
import {
  CreateRoomResponseSchema,
  InviteCodeSchema,
  JoinRoomResponseSchema,
  ROOM_MAX_MEMBERS,
} from '@flocked/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { PRIVATE_CACHE_CONTROL } from '../../src/read/cache.js';
import { INVITE_CODE_LENGTH, ROOM_DEPS } from '../../src/rooms/create.js';
import {
  DAY,
  NEXT,
  QUESTION_BODY,
  T0,
  call,
  createUser,
  errorCode,
  resetModeration,
  roomBalance,
  roomLedger,
  roomRounds,
  roomsEnv,
  seedRoom,
  type TestUser,
} from './helpers.js';

let e: Env;
beforeAll(() => {
  e = roomsEnv();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetModeration();
});

const create = (as: TestUser | undefined, body: unknown) =>
  call(e, as?.user, 'POST', '/rooms', body);
const join = (as: TestUser | undefined, inviteCode: string) =>
  call(e, as?.user, 'POST', '/rooms/join', { inviteCode });

async function membership(roomId: string, userId: string) {
  return env.DB.prepare(
    'SELECT role, joined_at FROM room_members WHERE room_id = ?1 AND user_id = ?2',
  )
    .bind(roomId, userId)
    .first<{ role: string; joined_at: number }>();
}

async function roomsOwnedBy(userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rooms WHERE owner_user_id = ?1')
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A room with `n` members in all (the owner and n − 1 others). */
async function roomWith(n: number) {
  const owner = await createUser();
  const members = [];
  for (let i = 1; i < n; i++) members.push({ user: await createUser(), joinedAt: T0 - DAY + i });
  return { owner, ...(await seedRoom({ owner: { user: owner, joinedAt: T0 - DAY }, members })) };
}

describe('POST /rooms', () => {
  it('needs a session', async () => {
    const res = await create(undefined, { name: 'Flock', questionSource: 'daily' });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
  });

  it('creates the room: owner membership, 500 room points with their ledger row, rounds ahead', async () => {
    const owner = await createUser();
    const res = await create(owner, { name: '  The Flock  ', questionSource: 'custom' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe(PRIVATE_CACHE_CONTROL);
    const { room } = CreateRoomResponseSchema.parse(await res.json());
    expect(room).toEqual({
      id: room.id,
      name: 'The Flock',
      ownerUserId: owner.id,
      inviteCode: room.inviteCode,
      questionSource: 'custom',
      memberCount: 1,
      createdAt: T0,
    });
    expect(room.inviteCode).toMatch(new RegExp(`^[0-9A-Za-z]{${INVITE_CODE_LENGTH}}$`));
    expect(InviteCodeSchema.safeParse(room.inviteCode).success).toBe(true);

    expect(await membership(room.id, owner.id)).toEqual({ role: 'owner', joined_at: T0 });
    expect(await roomBalance(owner.id, room.id)).toBe(500);
    expect(await roomLedger(owner.id, room.id)).toEqual([
      { delta: 500, reason: 'room_grant', ref_id: room.id },
    ]);
    // The daily slots ahead whose question lock hasn't passed: game days 2026-10-16 and 10-17.
    const rounds = await roomRounds(room.id);
    expect(rounds.map((r) => [r.opens_at, r.closes_at])).toEqual([
      [NEXT.opensAt, NEXT.closesAt],
      [NEXT.opensAt + DAY, NEXT.closesAt + DAY],
    ]);
    for (const r of rounds) {
      expect(r).toMatchObject({ status: 'scheduled', locked_at: null, question_id: null });
    }
  });

  it('refuses a blank or multi-line name with 400 and writes nothing', async () => {
    const owner = await createUser();
    for (const name of ['   ', 'Two\nlines']) {
      const res = await create(owner, { name, questionSource: 'daily' });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    }
    expect((await create(owner, { name: 'x', questionSource: 'other' })).status).toBe(400);
    expect(await roomsOwnedBy(owner.id)).toBe(0);
  });

  it('retries an invite code that is taken', async () => {
    const taken = await roomWith(1);
    const spy = vi
      .spyOn(ROOM_DEPS, 'inviteCode')
      .mockReturnValueOnce(taken.inviteCode)
      .mockReturnValueOnce('FreshCode1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const owner = await createUser();
    const res = await create(owner, { name: 'Second', questionSource: 'daily' });
    expect(res.status).toBe(201);
    const { room } = CreateRoomResponseSchema.parse(await res.json());
    expect(room.inviteCode).toBe('FreshCode1');
    expect(spy).toHaveBeenCalledTimes(2);
    // The failed attempt rolled back whole: one room, one grant.
    expect(await roomsOwnedBy(owner.id)).toBe(1);
    expect(await roomLedger(owner.id, room.id)).toHaveLength(1);
  });
});

describe('POST /rooms/join', () => {
  it('joins with the 500 join grant once; joining again returns the room without a second grant', async () => {
    const room = await roomWith(1);
    const u = await createUser();
    const res = await join(u, room.inviteCode);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(PRIVATE_CACHE_CONTROL);
    const first = JoinRoomResponseSchema.parse(await res.json());
    expect(first.room).toMatchObject({ id: room.id, ownerUserId: room.owner.id, memberCount: 2 });
    expect(await membership(room.id, u.id)).toEqual({ role: 'member', joined_at: T0 });
    expect(await roomBalance(u.id, room.id)).toBe(500);

    // Points spent since: a second join neither credits nor resets.
    await env.DB.prepare(
      'UPDATE point_balances SET balance = 120 WHERE user_id = ?1 AND scope = ?2',
    )
      .bind(u.id, room.id)
      .run();
    const again = await join(u, room.inviteCode);
    expect(again.status).toBe(200);
    expect(JoinRoomResponseSchema.parse(await again.json()).room).toEqual(first.room);
    expect(await roomBalance(u.id, room.id)).toBe(120);
    expect(await roomLedger(u.id, room.id)).toEqual([
      { delta: 500, reason: 'room_grant', ref_id: room.id },
    ]);
  });

  it('answers 404 for an unknown invite code and for a closed room', async () => {
    const u = await createUser();
    const unknown = await join(u, 'NoSuchCode');
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe('not_found');

    const owner = await createUser();
    const closed = await seedRoom({ owner: { user: owner, joinedAt: T0 - DAY }, closedAt: T0 - 1 });
    const res = await join(u, closed.inviteCode);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(await (await join(u, 'NoSuchCode')).json());
    expect(await membership(closed.id, u.id)).toBeNull();
    expect(await roomBalance(u.id, closed.id)).toBeNull();
  });

  it(`takes the ${ROOM_MAX_MEMBERS}th member, then answers 409 room_full and writes nothing`, async () => {
    const room = await roomWith(ROOM_MAX_MEMBERS - 1);
    const last = await createUser();
    expect((await join(last, room.inviteCode)).status).toBe(200);

    const late = await createUser();
    const res = await join(late, room.inviteCode);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('room_full');
    expect(await membership(room.id, late.id)).toBeNull();
    expect(await roomBalance(late.id, room.id)).toBeNull();
    expect(await roomLedger(late.id, room.id)).toEqual([]);
    // A member of a full room joining again still gets the room.
    expect((await join(last, room.inviteCode)).status).toBe(200);
  });

  it('never exceeds the cap under concurrent joins', async () => {
    const room = await roomWith(ROOM_MAX_MEMBERS - 2);
    const joiners = await Promise.all([1, 2, 3, 4].map(() => createUser()));
    const statuses = await Promise.all(
      joiners.map(async (u) => (await join(u, room.inviteCode)).status),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?1')
      .bind(room.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(ROOM_MAX_MEMBERS);
  });
});

describe('suspended accounts', () => {
  it('are refused account_suspended on every room write, with nothing written', async () => {
    const s = await createUser({ status: 'suspended' });
    const created = await create(s, { name: 'Nope', questionSource: 'custom' });
    expect(created.status).toBe(403);
    expect(await errorCode(created)).toBe('account_suspended');
    expect(await roomsOwnedBy(s.id)).toBe(0);

    const room = await roomWith(1);
    const joined = await join(s, room.inviteCode);
    expect(joined.status).toBe(403);
    expect(await errorCode(joined)).toBe('account_suspended');
    expect(await membership(room.id, s.id)).toBeNull();
    expect(await roomBalance(s.id, room.id)).toBeNull();

    // A suspended owner can still read the room, but not set its question.
    const owned = await seedRoom({ owner: { user: s, joinedAt: T0 - DAY, balance: 500 } });
    const set = await call(e, s.user, 'POST', `/rooms/${owned.id}/questions`, QUESTION_BODY);
    expect(set.status).toBe(403);
    expect(await errorCode(set)).toBe('account_suspended');
    const questions = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE room_id = ?1')
      .bind(owned.id)
      .first<{ n: number }>();
    expect(questions?.n).toBe(0);
    expect(await roomRounds(owned.id)).toEqual([]);
    expect((await call(e, s.user, 'GET', `/rooms/${owned.id}`)).status).toBe(200);
  });
});
