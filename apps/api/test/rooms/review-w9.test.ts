// W9-F1's room fixes (the owner's decisions of Oct 16, 2026):
//   * the successor of a deleted owner's room is an active member, else a suspended one; a merged
//     account never takes a room, and a room whose other members are all merged or deleted closes
//     (spec "Identity and personhood" › Account deletion);
//   * the room view's `memberCount` is the cap's count: members whose account isn't deleted (spec
//     "Profiles, leaderboards and rooms" › Rooms).
import { env } from 'cloudflare:test';
import { RoomDetailResponseSchema } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { ownedRoomStatements } from '../../src/rooms/handover.js';
import { DAY, T0, call, createUser, roomsEnv, seedRoom, type TestUser } from './helpers.js';

let e: Env;
beforeAll(() => {
  e = roomsEnv();
});

const setStatus = (userId: string, status: string, mergedInto: string | null = null) =>
  env.DB.prepare('UPDATE users SET status = ?2, merged_into = ?3 WHERE id = ?1')
    .bind(userId, status, mergedInto)
    .run();

/** A member whose account was merged into `into` after joining. */
async function mergedUser(into: TestUser): Promise<TestUser> {
  const u = await createUser();
  await setStatus(u.id, 'merged', into.id);
  return u;
}

async function deleteOwner(owner: TestUser): Promise<void> {
  await setStatus(owner.id, 'deleted');
  await env.DB.batch(ownedRoomStatements(env.DB, owner.id, T0));
}

async function roomRow(roomId: string) {
  return env.DB.prepare('SELECT owner_user_id, closed_at FROM rooms WHERE id = ?1')
    .bind(roomId)
    .first<{ owner_user_id: string; closed_at: number | null }>();
}

describe('the successor of a deleted owner’s room', () => {
  it('never a merged account: a suspended member takes it over the older merged one', async () => {
    // A suspended member, not the older merged one: `ORDER BY su.status <> 'active'` alone would
    // take the merged account here, because neither candidate is active.
    const owner = await createUser();
    const keeper = await createUser();
    const merged = await mergedUser(keeper);
    const suspended = await createUser({ status: 'suspended' });
    const room = await seedRoom({
      owner: { user: owner, joinedAt: T0 - 4 * DAY },
      members: [
        { user: merged, joinedAt: T0 - 3 * DAY },
        { user: suspended, joinedAt: T0 - DAY },
      ],
    });
    await deleteOwner(owner);
    expect(await roomRow(room.id)).toEqual({ owner_user_id: suspended.id, closed_at: null });
  });

  it('closes the room when every other member is merged or deleted', async () => {
    const owner = await createUser();
    const keeper = await createUser();
    const room = await seedRoom({
      owner: { user: owner, joinedAt: T0 - 4 * DAY },
      members: [
        { user: await mergedUser(keeper), joinedAt: T0 - 3 * DAY },
        { user: await createUser({ status: 'deleted' }), joinedAt: T0 - 2 * DAY },
      ],
    });
    await deleteOwner(owner);
    expect(await roomRow(room.id)).toEqual({ owner_user_id: owner.id, closed_at: T0 });
    // The membership rows stay as they were: nobody was made owner.
    const { results } = await env.DB.prepare(
      "SELECT role FROM room_members WHERE room_id = ?1 AND role = 'owner'",
    )
      .bind(room.id)
      .all<{ role: string }>();
    expect(results.map((r) => r.role)).toEqual(['owner']);
  });
});

describe('the room view’s memberCount', () => {
  it('counts the members the cap counts: a deleted account is left out', async () => {
    const owner = await createUser();
    const other = await createUser();
    const room = await seedRoom({
      owner: { user: owner, joinedAt: T0 - 3 * DAY, balance: 500 },
      members: [
        { user: other, joinedAt: T0 - 2 * DAY, balance: 500 },
        { user: await createUser({ status: 'deleted' }), joinedAt: T0 - DAY },
      ],
    });
    const res = await call(e, owner.user, 'GET', `/rooms/${room.id}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const detail = RoomDetailResponseSchema.parse(await res.json());
    expect(detail.room.memberCount).toBe(2);
    // Every member row is still served, the deleted one anonymized.
    expect(detail.members).toHaveLength(3);
  });
});
