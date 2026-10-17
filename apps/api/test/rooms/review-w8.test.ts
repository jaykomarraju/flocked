// W8-F1's room fixes (W8-Z's review of wave 8, and the owner's decisions of Oct 16, 2026; spec
// "Profiles, leaderboards and rooms" › Rooms, "Identity and personhood" › Account deletion):
//   * H1: an account owns at most 10 open rooms; past that POST /rooms answers 409 `conflict`, also
//     under concurrent creates (the count is read inside the insert);
//   * L3: the room and member inserts require an active account in SQL, so a deletion or merge that
//     commits after the session was read leaves no room or membership behind;
//   * the 50-member cap counts only members whose account isn't deleted;
//   * L4: a deleted owner's room passes to the oldest active member, else the oldest non-deleted one;
//   * M3: the visit grant only for an active member, as the daily grant;
//   * M2: POST /rooms/:id/questions is rate limited like the other room writes;
//   * M1: a room question is stored only if the round's lock is still ahead after moderation.
import { env } from 'cloudflare:test';
import { ROOM_MAX_MEMBERS, RoomDetailResponseSchema } from '@flocked/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { ownedRoomStatements } from '../../src/rooms/handover.js';
import { verdictFor } from '../questions/routes-helpers.js';
import {
  DAY,
  MINUTE,
  NEXT,
  QUESTION_BODY,
  T0,
  TODAY,
  call,
  createUser,
  errorCode,
  model,
  resetModeration,
  roomBalance,
  roomLedger,
  roomRounds,
  roomsEnv,
  seedRoom,
  seedRoomRound,
  setClock,
  type TestUser,
} from './helpers.js';

let e: Env;
beforeAll(() => {
  e = roomsEnv();
});
afterEach(() => {
  vi.restoreAllMocks();
  setClock(e, T0);
  resetModeration();
});

const create = (as: TestUser, name = 'Flock') =>
  call(e, as.user, 'POST', '/rooms', { name, questionSource: 'custom' });
const join = (as: TestUser, inviteCode: string) =>
  call(e, as.user, 'POST', '/rooms/join', { inviteCode });

async function openRoomsOwnedBy(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM rooms WHERE owner_user_id = ?1 AND closed_at IS NULL',
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function isMember(roomId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS ok FROM room_members WHERE room_id = ?1 AND user_id = ?2',
  )
    .bind(roomId, userId)
    .first();
  return row !== null;
}

/**
 * `db`, with the first `n` reads of an owner's open-room count (createRoom's pre-check) each held,
 * after it is read, until all `n` have been read: `n` concurrent creates all see the same count.
 */
function preChecksTogether(db: D1Database, n: number): D1Database {
  let read = 0;
  let release = () => {};
  const allRead = new Promise<void>((r) => (release = r));
  const held = (stmt: D1PreparedStatement) => ({
    bind: (...args: unknown[]) => {
      const bound = stmt.bind(...args);
      return {
        first: async <T>() => {
          const row = await bound.first<T>();
          if (read < n) {
            read += 1;
            if (read === n) release();
            await allRead;
          }
          return row;
        },
      };
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'prepare') {
        const v: unknown = Reflect.get(target, prop);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      return (sql: string) =>
        sql.startsWith('SELECT COUNT(*) AS n FROM rooms WHERE owner_user_id = ?1')
          ? held(target.prepare(sql))
          : target.prepare(sql);
    },
  });
}

const setStatus = (userId: string, status: string) =>
  env.DB.prepare('UPDATE users SET status = ?2 WHERE id = ?1').bind(userId, status).run();

describe('rooms owned per account (H1)', () => {
  it('takes 10 open rooms, answers 409 conflict for the 11th, and frees a slot when one closes', async () => {
    const owner = await createUser();
    for (let i = 0; i < 10; i++) expect((await create(owner, `Flock ${i}`)).status).toBe(201);
    const res = await create(owner);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect(await openRoomsOwnedBy(owner.id)).toBe(10);
    await env.DB.prepare(
      'UPDATE rooms SET closed_at = ?2 WHERE id = (SELECT id FROM rooms WHERE owner_user_id = ?1 LIMIT 1)',
    )
      .bind(owner.id, T0)
      .run();
    expect((await create(owner)).status).toBe(201);
  });

  it('holds the cap under concurrent creates (read inside the insert)', async () => {
    const owner = await createUser();
    for (let i = 0; i < 8; i++) expect((await create(owner)).status).toBe(201);
    // Every create passes the app-level pre-check (8 open rooms) before any inserts, so only the count
    // read inside the insert can hold the cap (W9-Z: it caught the guard's removal only by timing).
    const gated = { ...e, DB: preChecksTogether(e.DB, 4) };
    const body = { name: 'Flock', questionSource: 'custom' };
    const statuses = await Promise.all(
      [1, 2, 3, 4].map(async () => (await call(gated, owner.user, 'POST', '/rooms', body)).status),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
    expect(await openRoomsOwnedBy(owner.id)).toBe(10);
  });
});

describe('account status in the room and member inserts (L3)', () => {
  it('creates no room for an owner deleted after the session was read', async () => {
    const owner = await createUser();
    await setStatus(owner.id, 'deleted');
    const res = await create(owner);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('account_suspended');
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM rooms WHERE owner_user_id = ?1')
      .bind(owner.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect(await roomLedger(owner.id, 'global')).toEqual([]);
  });

  it('adds no member merged after the session was read', async () => {
    const owner = await createUser();
    const room = await seedRoom({ owner: { user: owner, joinedAt: T0 - DAY } });
    const joiner = await createUser();
    await env.DB.prepare("UPDATE users SET status = 'merged', merged_into = ?2 WHERE id = ?1")
      .bind(joiner.id, owner.id)
      .run();
    const res = await join(joiner, room.inviteCode);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('account_suspended');
    expect(await isMember(room.id, joiner.id)).toBe(false);
    expect(await roomBalance(joiner.id, room.id)).toBeNull();
  });
});

describe('the member cap and deleted accounts', () => {
  it(`counts only members whose account isn't deleted toward the ${ROOM_MAX_MEMBERS}`, async () => {
    const owner = await createUser();
    const members = [{ user: await createUser({ status: 'deleted' }), joinedAt: T0 - DAY + 1 }];
    for (let i = 2; i < ROOM_MAX_MEMBERS; i++) {
      members.push({ user: await createUser(), joinedAt: T0 - DAY + i });
    }
    const room = await seedRoom({ owner: { user: owner, joinedAt: T0 - DAY }, members });
    // 50 rows, 49 of them live: one more joins, then the room is full.
    const last = await createUser();
    expect((await join(last, room.inviteCode)).status).toBe(200);
    const late = await createUser();
    const res = await join(late, room.inviteCode);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('room_full');
  });
});

describe('the hand-over of a deleted owner’s room (L4)', () => {
  async function deleteOwner(owner: TestUser) {
    await setStatus(owner.id, 'deleted');
    await env.DB.batch(ownedRoomStatements(env.DB, owner.id, T0));
  }
  const ownerOf = async (roomId: string) =>
    (
      await env.DB.prepare('SELECT owner_user_id, closed_at FROM rooms WHERE id = ?1')
        .bind(roomId)
        .first<{ owner_user_id: string; closed_at: number | null }>()
    )?.owner_user_id;

  it('passes to the oldest active member before an older suspended one', async () => {
    const owner = await createUser();
    const suspended = await createUser({ status: 'suspended' });
    const active = await createUser();
    const room = await seedRoom({
      owner: { user: owner, joinedAt: T0 - 3 * DAY },
      members: [
        { user: suspended, joinedAt: T0 - 2 * DAY },
        { user: active, joinedAt: T0 - DAY },
      ],
    });
    await deleteOwner(owner);
    expect(await ownerOf(room.id)).toBe(active.id);
  });

  it('else to the oldest member whose account isn’t deleted (a suspended one)', async () => {
    const owner = await createUser();
    const suspended = await createUser({ status: 'suspended' });
    const room = await seedRoom({
      owner: { user: owner, joinedAt: T0 - 3 * DAY },
      members: [
        { user: await createUser({ status: 'deleted' }), joinedAt: T0 - 2 * DAY },
        { user: suspended, joinedAt: T0 - DAY },
      ],
    });
    await deleteOwner(owner);
    expect(await ownerOf(room.id)).toBe(suspended.id);
  });
});

describe('the visit grant (M3)', () => {
  it('pays an active member and not a suspended one', async () => {
    const owner = await createUser();
    const suspended = await createUser({ status: 'suspended' });
    const room = await seedRoom({
      owner: { user: owner, joinedAt: T0 - DAY, balance: 500 },
      members: [{ user: suspended, joinedAt: T0 - DAY + MINUTE, balance: 500 }],
    });
    const open = await seedRoomRound({ roomId: room.id, ...TODAY, status: 'open' });
    for (const u of [suspended, owner]) {
      const res = await call(e, u.user, 'GET', `/rooms/${room.id}`);
      expect(res.status).toBe(200);
      RoomDetailResponseSchema.parse(await res.json());
    }
    expect(await roomBalance(suspended.id, room.id)).toBe(500);
    expect((await roomLedger(suspended.id, room.id)).filter((l) => l.ref_id === open)).toEqual([]);
    expect(await roomBalance(owner.id, room.id)).toBe(600);
  });
});

describe('POST /rooms/:id/questions', () => {
  async function customRoom() {
    const owner = await createUser();
    const room = await seedRoom({
      owner: { user: owner, joinedAt: T0 - DAY, balance: 500 },
      source: 'custom',
    });
    return { owner, room };
  }

  it('is rate limited like the other room writes (M2): 429 before moderation', async () => {
    const { owner, room } = await customRoom();
    const bad = { ...QUESTION_BODY, prompt: '   ' };
    for (let i = 0; i < 30; i++) {
      expect((await call(e, owner.user, 'POST', `/rooms/${room.id}/questions`, bad)).status).toBe(
        400,
      );
    }
    const res = await call(e, owner.user, 'POST', `/rooms/${room.id}/questions`, QUESTION_BODY);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    expect(model.classify).not.toHaveBeenCalled();
  });

  it('stores nothing when the round’s lock passes during moderation (M1): 409 conflict', async () => {
    const { owner, room } = await customRoom();
    setClock(e, NEXT.lockAt - MINUTE);
    model.classify.mockImplementation((q) => {
      setClock(e, NEXT.lockAt);
      return Promise.resolve(verdictFor(q));
    });
    const res = await call(e, owner.user, 'POST', `/rooms/${room.id}/questions`, QUESTION_BODY);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect(model.classify).toHaveBeenCalledTimes(1);
    const next = (await roomRounds(room.id)).find((r) => r.opens_at === NEXT.opensAt);
    expect(next?.question_id ?? null).toBeNull();
    const stored = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE room_id = ?1')
      .bind(room.id)
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });
});
