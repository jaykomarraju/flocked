// A room owner deletes their account (spec "Identity and personhood" › Account deletion: "Rooms the
// user owns pass to the oldest remaining member by join time. A room with no other member is
// closed."; decision B5), through DELETE /me with real sessions: the oldest remaining member (a
// deleted one skipped; ties by user ID) becomes the owner and can set the room's question, the
// deleted user's membership stays with the anonymized account; a room left without members closes:
// no joins, its unlocked room rounds close, its locked ones play out.
import { env } from 'cloudflare:test';
import { RoomDetailResponseSchema } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { withModerationDeps } from '../../src/moderation/deps.js';
import { insertRoomRoundsAhead } from '../../src/rooms/schedule.js';
import { call, errorCode } from '../auth/fixtures.js';
import { seedFixture } from '../helpers/index.js';
import { account, identityEnv, type Account, type IdentityTest } from '../identity/fixtures.js';
import {
  DAY,
  HOUR,
  QUESTION_BODY,
  createUser,
  duplicates,
  model,
  seedRoom,
  seedRoomRound,
} from './helpers.js';

let t: IdentityTest;
beforeAll(async () => {
  await seedFixture(env.DB);
  t = await identityEnv();
  withModerationDeps(t.env, { model, duplicates });
});

const del = (who: Account) => call(t.env, 'DELETE', '/me', undefined, who.headers);

async function roomRow(id: string) {
  return env.DB.prepare('SELECT owner_user_id, closed_at FROM rooms WHERE id = ?1')
    .bind(id)
    .first<{ owner_user_id: string; closed_at: number | null }>();
}

async function roles(roomId: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    'SELECT user_id, role FROM room_members WHERE room_id = ?1',
  )
    .bind(roomId)
    .all<{ user_id: string; role: string }>();
  return Object.fromEntries(results.map((r) => [r.user_id, r.role]));
}

describe('DELETE /me by a room owner', () => {
  it('hands the room to the oldest remaining member, who can then set its question', async () => {
    const now = Date.now();
    const owner = await account(t);
    const oldest = await account(t);
    const later = await account(t);
    const room = await seedRoom({
      owner: { user: owner, joinedAt: now - 3 * DAY, balance: 500 },
      members: [
        { user: later, joinedAt: now - DAY, balance: 500 },
        { user: oldest, joinedAt: now - 2 * DAY, balance: 500 },
      ],
      source: 'custom',
    });

    const res = await del(owner);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await roomRow(room.id)).toEqual({ owner_user_id: oldest.id, closed_at: null });
    expect(await roles(room.id)).toEqual({
      [owner.id]: 'member',
      [oldest.id]: 'owner',
      [later.id]: 'member',
    });

    const view = await call(t.env, 'GET', `/rooms/${room.id}`, undefined, oldest.headers);
    expect(view.status).toBe(200);
    const detail = RoomDetailResponseSchema.parse(await view.json());
    expect(detail.room.ownerUserId).toBe(oldest.id);
    expect(detail.members.map((m) => [m.user.id, m.role])).toEqual([
      [owner.id, 'member'],
      [oldest.id, 'owner'],
      [later.id, 'member'],
    ]);
    // The deleted account stays a member, anonymized.
    expect(detail.members[0]?.user).toEqual({
      id: owner.id,
      handle: null,
      displayName: null,
      avatarUrl: null,
    });

    const set = await call(
      t.env,
      'POST',
      `/rooms/${room.id}/questions`,
      QUESTION_BODY,
      oldest.headers,
    );
    expect(set.status, await set.clone().text()).toBe(201);
    const notOwner = await call(
      t.env,
      'POST',
      `/rooms/${room.id}/questions`,
      QUESTION_BODY,
      later.headers,
    );
    expect(notOwner.status).toBe(403);
    expect(await errorCode(notOwner)).toBe('forbidden');
  });

  it('skips an older member whose account is deleted; equal join times go to the lower user ID', async () => {
    const now = Date.now();
    const owner = await account(t);
    const gone = await createUser({ status: 'deleted' });
    const [x, y] = [await account(t), await account(t)].sort((a, b) => (a.id < b.id ? -1 : 1)) as [
      Account,
      Account,
    ];
    const room = await seedRoom({
      owner: { user: owner, joinedAt: now - 3 * DAY },
      members: [
        { user: gone, joinedAt: now - 2 * DAY },
        { user: y, joinedAt: now - DAY },
        { user: x, joinedAt: now - DAY },
      ],
    });
    expect((await del(owner)).status).toBe(200);
    expect(await roomRow(room.id)).toEqual({ owner_user_id: x.id, closed_at: null });
    expect(await roles(room.id)).toMatchObject({
      [owner.id]: 'member',
      [gone.id]: 'member',
      [x.id]: 'owner',
      [y.id]: 'member',
    });
  });

  it('closes a room left without members: no joins, unlocked rounds closed, locked ones untouched', async () => {
    const now = Date.now();
    const owner = await account(t);
    const alone = await seedRoom({ owner: { user: owner, joinedAt: now - 3 * DAY, balance: 500 } });
    // Its only other member's account is deleted already: closes too.
    const gone = await createUser({ status: 'deleted' });
    const deserted = await seedRoom({
      owner: { user: owner, joinedAt: now - 3 * DAY },
      members: [{ user: gone, joinedAt: now - 2 * DAY }],
    });
    // A room the user only belongs to is not touched.
    const host = await account(t);
    const visited = await seedRoom({
      owner: { user: host, joinedAt: now - 4 * DAY },
      members: [{ user: owner, joinedAt: now - 3 * DAY }],
    });

    const locked = await seedRoomRound({
      roomId: alone.id,
      opensAt: now - 2 * HOUR,
      status: 'open',
    });
    const unlocked = await insertRoomRoundsAhead(env.DB, alone.id, now);
    expect(unlocked.length).toBeGreaterThan(0);
    const before = await env.DB.prepare('SELECT status, locked_at FROM rounds WHERE id = ?1')
      .bind(locked)
      .first();

    expect((await del(owner)).status).toBe(200);
    for (const id of [alone.id, deserted.id]) {
      const row = await roomRow(id);
      expect(row?.owner_user_id).toBe(owner.id);
      expect(row?.closed_at).toBeGreaterThanOrEqual(now);
    }
    expect(await roomRow(visited.id)).toEqual({ owner_user_id: host.id, closed_at: null });
    expect(await roles(visited.id)).toEqual({ [host.id]: 'owner', [owner.id]: 'member' });
    // Memberships stay with the anonymized account.
    expect(await roles(alone.id)).toEqual({ [owner.id]: 'owner' });

    const { results } = await env.DB.prepare(
      'SELECT id, status, locked_at FROM rounds WHERE room_id = ?1 AND locked_at IS NULL',
    )
      .bind(alone.id)
      .all<{ id: string; status: string }>();
    expect(results.map((r) => r.id).sort()).toEqual([...unlocked].sort());
    expect(results.every((r) => r.status === 'closed')).toBe(true);
    expect(
      await env.DB.prepare('SELECT status, locked_at FROM rounds WHERE id = ?1')
        .bind(locked)
        .first(),
    ).toEqual(before);
    // A closed room gets no new rounds.
    expect(await insertRoomRoundsAhead(env.DB, alone.id, now + DAY)).toEqual([]);

    const joiner = await account(t);
    const join = await call(
      t.env,
      'POST',
      '/rooms/join',
      { inviteCode: alone.inviteCode },
      joiner.headers,
    );
    expect(join.status).toBe(404);
    expect(await errorCode(join)).toBe('not_found');
    expect(await roles(alone.id)).toEqual({ [owner.id]: 'owner' });
  });
});
