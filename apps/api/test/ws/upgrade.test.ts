// GET /rounds/:id/ws (W7-A): the upgrade sits behind the room-round gate (spec "API" › Reveal gating:
// room rounds are members only on every WebSocket; anonymous 401, non-member 404 exactly as for a
// round that doesn't exist), and a connection's first message is the `state` snapshot.
import { env } from 'cloudflare:test';
import { ErrorEnvelopeSchema, newUlid } from '@flocked/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signIn } from '../gating/helpers.js';
import {
  BASE_OPENS_AT,
  HOUR,
  createRound,
  createUser,
  setClock,
  type TestRound,
} from '../round-do/helpers.js';
import { closeAll, connect, stateOf, until, upgrade } from './helpers.js';

const OPENS_AT = BASE_OPENS_AT + 40 * 24 * HOUR;
const NOW = OPENS_AT + 2 * HOUR;

let room: TestRound;
let daily: TestRound;
let member: Record<string, string>;
let outsider: Record<string, string>;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setClock(NOW);
  const roomId = newUlid();
  room = await createRound({ kind: 'room', roomId, opensAt: OPENS_AT, modes: ['free'] });
  daily = await createRound({ kind: 'daily', opensAt: OPENS_AT, modes: ['free', 'stakes'] });
  await room.stub.init(room.locked);
  await daily.stub.init(daily.locked);
  member = await signIn(await createUser(100, roomId));
  outsider = await signIn(await createUser(100));
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe('room rounds: members only, checked at the upgrade', () => {
  it('anonymous 401; a signed-in non-member 404, the same answer as for no round', async () => {
    const anon = await upgrade(room.locked.roundId);
    expect(anon.status).toBe(401);
    expect(ErrorEnvelopeSchema.parse(anon.json).error.code).toBe('unauthorized');

    const nonMember = await upgrade(room.locked.roundId, outsider);
    const none = await upgrade(newUlid(), outsider);
    expect(nonMember.status).toBe(404);
    expect(nonMember.json).toEqual(none.json);
    expect(nonMember.viewer).toBeNull();
  });

  it('a member connects and gets the round’s state first', async () => {
    const v = await connect(room.locked.roundId, member);
    const s = stateOf(v);
    expect(s).toMatchObject({
      roundId: room.locked.roundId,
      status: 'open',
      opensAt: room.locked.opensAt / 1000,
      closesAt: room.locked.closesAt / 1000,
      beaconRound: room.locked.beaconRound,
      beaconTime: room.locked.beaconTimeSec,
      serverTime: NOW,
    });
    expect(s.modes).toEqual({
      free: {
        status: 'pending',
        entrantCount: 0,
        pool: '0',
        revealedAt: null,
        claimsOpenAt: null,
        refundReason: null,
        result: null,
      },
    });
    await closeAll([v]);
  });
});

describe('public rounds', () => {
  it('anyone connects, signed in or not', async () => {
    for (const headers of [{}, outsider]) {
      const v = await connect(daily.locked.roundId, headers);
      expect(Object.keys(stateOf(v).modes).sort()).toEqual(['free', 'stakes']);
      await closeAll([v]);
    }
  });

  it('a GET without the upgrade answers 400 bad_request; an unknown or unlocked round 404', async () => {
    const res = await upgrade(daily.locked.roundId, { Upgrade: '' });
    expect(res.status).toBe(400);
    expect(ErrorEnvelopeSchema.parse(res.json).error.code).toBe('bad_request');

    const unknown = await upgrade(newUlid());
    expect(unknown.status).toBe(404);
    // A round whose question isn't locked yet is not public (spec "API" › Reveal gating).
    const unlocked = newUlid();
    await env.DB.prepare(
      `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, config_json)
       VALUES (?1, 'daily', NULL, ?2, ?3, ?4, 1, 'scheduled', '{}')`,
    )
      .bind(unlocked, newUlid(), OPENS_AT + 24 * HOUR, OPENS_AT + 48 * HOUR)
      .run();
    expect((await upgrade(unlocked)).status).toBe(404);
  });

  it('"ping" is answered "pong" by the runtime; nothing else is sent back', async () => {
    const v = await connect(daily.locked.roundId);
    v.ws.send('ping');
    await until(() => v.pongs === 1);
    expect(v.messages.map((m) => m.type)).toEqual(['state']);
    await closeAll([v]);
  });
});
