// DO-5 (reconnect snapshot): every connection, a reconnect included, starts with a fresh `state`: the
// current counts and status, and a mode's result only once its `revealed_at` is set. One Free round
// is driven by its RoundDO through open, entries, close, the beacon (settlement starts), the window
// where the settlement record is in D1 but `revealed_at` is null, and the reveal; a viewer reconnects
// at each step. Also: the catch-up after `state` for an event D1 doesn't show yet.
import { env } from 'cloudflare:test';
import type { SettleMessage, WsStateMessage } from '@flocked/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnchorDO } from '../../src/do/anchor-do.js';
import type { AnchorCommitItem } from '../../src/do/types.js';
import { viewerStub } from '../../src/ws/shards.js';
import {
  BASE_OPENS_AT,
  HOUR,
  alarmAt,
  createRound,
  createUser,
  okValue,
  sealedPick,
  setClock,
  useTestSigner,
  type TestRound,
} from '../round-do/helpers.js';
import { closeAll, connect, hubIdle, snapshot, stateOf, until } from './helpers.js';

const OPENS_AT = BASE_OPENS_AT + 50 * 24 * HOUR;
const TALLY = [
  { headcount: 1, total: '25' },
  { headcount: 2, total: '75' },
];

const original = { QUEUE_SETTLE: env.QUEUE_SETTLE, QUEUE_NOTIFY: env.QUEUE_NOTIFY };
const submitCommit = Object.getOwnPropertyDescriptor(AnchorDO.prototype, 'submitCommit');
const settled: SettleMessage[] = [];

beforeAll(() => {
  useTestSigner();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(AnchorDO.prototype, 'submitCommit', {
    configurable: true,
    writable: true,
    value: (item: AnchorCommitItem) =>
      Promise.resolve({ queued: [item.roundKey], alreadyAnchored: [] }),
  });
  Object.assign(env, {
    QUEUE_SETTLE: {
      send: (body: SettleMessage) => {
        settled.push(body);
        return Promise.resolve();
      },
    },
    QUEUE_NOTIFY: { send: () => Promise.resolve(), sendBatch: () => Promise.resolve() },
  });
});
afterAll(() => {
  Object.assign(env, original);
  if (submitCommit) Object.defineProperty(AnchorDO.prototype, 'submitCommit', submitCommit);
  vi.restoreAllMocks();
});

async function enter(r: TestRound, option: 0 | 1, stake: string) {
  const userId = await createUser(1000);
  okValue(
    await r.stub.enterFree({
      roundId: r.locked.roundId,
      userId,
      body: { stake, ciphertext: await sealedPick(r.locked, option) },
    }),
  );
}

const free = (s: WsStateMessage) => s.modes.free;

describe('DO-5: a reconnect gets a fresh state', () => {
  it('current counts and status at every step, and the result only after the reveal', async () => {
    setClock(OPENS_AT + HOUR);
    const r = await createRound({ kind: 'daily', opensAt: OPENS_AT, modes: ['free'] });
    const id = r.locked.roundId;
    await r.stub.init(r.locked);

    // Open, no entries.
    const first = await connect(id);
    expect(stateOf(first)).toMatchObject({ status: 'open', serverTime: OPENS_AT + HOUR });
    expect(free(stateOf(first))).toMatchObject({ status: 'pending', entrantCount: 0, pool: '0' });

    // Entries; the connected viewer gets coalesced counts, a reconnect gets them in its state.
    await enter(r, 0, '25');
    await enter(r, 1, '25');
    await enter(r, 1, '50');
    await hubIdle(r.stub, id);
    await until(() => first.of('counts').at(-1)?.modes.free?.entrantCount === 3);
    first.ws.close(1000, 'reconnecting');
    setClock(OPENS_AT + 2 * HOUR);
    const again = await snapshot(id);
    expect(again).toMatchObject({ status: 'open', serverTime: OPENS_AT + 2 * HOUR });
    expect(free(again)).toMatchObject({ entrantCount: 3, pool: '100', result: null });

    // Close: the viewer gets `closed`; a reconnect reads closed, the counts now from D1.
    const watcher = await connect(id);
    await alarmAt(r.stub, r.locked.closesAt);
    await hubIdle(r.stub, id);
    await until(() => watcher.of('closed').length === 1);
    expect(watcher.of('closed')[0]).toMatchObject({
      closesAt: r.locked.closesAt / 1000,
      beaconRound: r.locked.beaconRound,
      beaconTime: r.locked.beaconTimeSec,
    });
    const closed = await snapshot(id);
    expect(closed.status).toBe('closed');
    expect(free(closed)).toMatchObject({ status: 'pending', entrantCount: 3, pool: '100' });

    // Beacon time: settlement is enqueued and `revealing` broadcast. D1 still says pending (the
    // SettlementDO moves it), so a reconnect gets `state` and then `revealing` as a catch-up.
    await alarmAt(r.stub, r.locked.beaconTimeSec * 1000);
    await hubIdle(r.stub, id);
    expect(settled.map((s) => s.roundId)).toContain(id);
    await until(() => watcher.of('revealing').length === 1);
    const caught = await connect(id);
    expect(caught.messages.map((m) => m.type)).toEqual(['state', 'revealing']);
    await closeAll([caught]);

    // The window: the settlement record (tally, winner) is in D1, `revealed_at` is still null.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE round_modes SET status = 'revealing' WHERE round_id = ?1 AND mode = 'free'",
      ).bind(id),
      env.DB.prepare(
        `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json, winners_json)
         VALUES (?1, 'free', 0, 'settled', 1, ?2, '{"winner":0}')`,
      ).bind(id, JSON.stringify(TALLY)),
    ]);
    const windowed = await snapshot(id);
    expect(free(windowed)).toMatchObject({ status: 'revealing', revealedAt: null, result: null });

    // The reveal: `revealed_at`, then the RoundDO's result (as applyFree orders them).
    const revealedAt = r.locked.beaconTimeSec * 1000 + 30_000;
    setClock(revealedAt);
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'settled', revealed_at = ?2, final_at = ?2 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(id, revealedAt)
      .run();
    await r.stub.onModeResult('free', {
      outcome: 'revealed',
      winningOption: 0,
      tally: [
        { headcount: 1, total: '25' },
        { headcount: 2, total: '75' },
      ],
      bundleHash: `0x${'ab'.repeat(32)}`,
      revealedAt,
    });
    await hubIdle(r.stub, id);
    await until(() => watcher.of('revealed').length === 1);
    expect(watcher.of('revealed')[0]).toEqual({
      type: 'revealed',
      roundId: id,
      mode: 'free',
      winningOption: 0,
      tally: TALLY,
    });
    const after = await snapshot(id);
    expect(free(after)).toEqual({
      status: 'settled',
      entrantCount: 3,
      pool: '100',
      revealedAt,
      claimsOpenAt: null,
      refundReason: null,
      result: { winningOption: 0, tally: TALLY },
    });
    // The watcher saw each event once, in order, after its state.
    expect(watcher.messages.map((m) => m.type).filter((t) => t !== 'counts')).toEqual([
      'state',
      'closed',
      'revealing',
      'revealed',
    ]);
    await closeAll([watcher]);
  });

  it('an event D1 does not show yet is sent right after state, in order; once D1 has it, not again', async () => {
    setClock(OPENS_AT + 3 * 24 * HOUR);
    const r = await createRound({
      kind: 'daily',
      opensAt: OPENS_AT + 3 * 24 * HOUR - HOUR,
      modes: ['stakes'],
    });
    const id = r.locked.roundId;
    await r.stub.init(r.locked);
    // As the Stakes indexer does: the RoundDO hears of the confirmed proposal before D1 is written.
    const claimsOpenAt = r.locked.closesAt + 2 * HOUR;
    const revealed = {
      type: 'revealed' as const,
      roundId: id,
      mode: 'stakes' as const,
      winningOption: 1 as const,
      tally: TALLY,
      claimsOpenAt,
    };
    for (let shard = 0; shard < 16; shard++) await viewerStub(env, id, shard).broadcast(revealed);
    const v = await connect(id);
    expect(v.messages).toEqual([expect.objectContaining({ type: 'state' }), revealed]);
    expect(stateOf(v).modes.stakes?.result).toBeNull();
    await closeAll([v]);

    // D1 catches up: the state shows the result, and nothing is replayed.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE round_modes SET status = 'settle_proposed', revealed_at = ?2, claims_open_at = ?3 WHERE round_id = ?1",
      ).bind(id, r.locked.closesAt + 200_000, claimsOpenAt),
      env.DB.prepare(
        `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json, winners_json)
         VALUES (?1, 'stakes', 0, 'settled', 1, ?2, '{"winner":1}')`,
      ).bind(id, JSON.stringify(TALLY)),
    ]);
    // A snapshot kept by the shard expires after a second.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const w = await connect(id);
    expect(w.messages.map((m) => m.type)).toEqual(['state']);
    expect(stateOf(w).modes.stakes).toMatchObject({
      status: 'settle_proposed',
      claimsOpenAt,
      result: { winningOption: 1, tally: TALLY },
    });
    await closeAll([w]);
  });
});

describe('the snapshot a shard keeps (at most one D1 read per shard per second)', () => {
  it('is patched by counts, dropped by any other message, and read again after a second', async () => {
    setClock(OPENS_AT + 5 * 24 * HOUR);
    const r = await createRound({ kind: 'daily', opensAt: OPENS_AT + 5 * 24 * HOUR - HOUR });
    const id = r.locked.roundId;
    await r.stub.init(r.locked);
    const shard = viewerStub(env, id, 3);
    const sub = { roundId: id, shard: 3, shardCount: 16, membersOnly: false };
    const read = async () => (await shard.subscribe(sub)).modes.free;
    expect(await read()).toMatchObject({ status: 'pending', entrantCount: 0 });

    // Kept: a D1 change with no message isn't seen within the second...
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'revealing' WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(id)
      .run();
    expect(await read()).toMatchObject({ status: 'pending' });
    // ...counts are patched into it...
    await shard.broadcast({
      type: 'counts',
      roundId: id,
      modes: { free: { entrantCount: 7, pool: '70' } },
    });
    expect(await read()).toMatchObject({ status: 'pending', entrantCount: 7, pool: '70' });
    // ...and any other message drops it: the next read is fresh.
    await shard.broadcast({ type: 'revealing', roundId: id, mode: 'free' });
    expect(await read()).toMatchObject({ status: 'revealing', entrantCount: 0 });

    // Without a message, a kept snapshot is read again once a second has passed.
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'refunded', refund_reason = 8, final_at = ?2 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(id, OPENS_AT + 5 * 24 * HOUR)
      .run();
    expect(await read()).toMatchObject({ status: 'revealing' });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await read()).toMatchObject({ status: 'refunded', refundReason: 8 });
  });
});
