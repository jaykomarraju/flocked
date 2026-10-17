// Outcome producers (src/notify/outcomes.ts): what each enqueue point puts on the notify queue.
import { env } from 'cloudflare:test';
import type { NotifyMessage } from '@flocked/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import {
  enqueueVoidOutcomes,
  modeOutcomeMessages,
  notifyOnModeFinal,
} from '../../src/notify/outcomes.js';
import { seedFixture, type Fixture } from '../helpers/index.js';
import { seedEntry, seedResult } from './helpers.js';

let ids: Fixture['ids'];
let round: string;
let sent: NotifyMessage[] = [];
const queueEnv = () =>
  ({
    ...env,
    QUEUE_NOTIFY: {
      send: (m: NotifyMessage) => Promise.resolve(void sent.push(m)),
      sendBatch: (ms: { body: NotifyMessage }[]) =>
        Promise.resolve(void sent.push(...ms.map((m) => m.body))),
    },
  }) as unknown as Env;

const NEXT = '01K70000000000000000000098';

beforeAll(async () => {
  const fx = await seedFixture(env.DB);
  ids = fx.ids;
  round = fx.round.id;
  await seedEntry(env.DB, round, 'free', ids.user, 0, { stake: 100 });
  await seedEntry(env.DB, round, 'free', ids.otherUser, 1, { stake: 50 });
  await seedEntry(env.DB, round, 'free', ids.admin, 1, { valid: 0 });
  await seedEntry(env.DB, round, 'stakes', ids.user, 1, { stake: 5_000_000 });
  await env.DB.prepare(
    "INSERT INTO payouts (round_id, mode, user_id, kind, amount) VALUES (?1, 'free', ?2, 'win', 187)",
  )
    .bind(round, ids.user)
    .run();
  // The next daily round, open at this one's close.
  await env.DB.prepare(
    `INSERT INTO rounds (id, kind, opens_at, closes_at, status)
     SELECT ?1, 'daily', closes_at, closes_at + 86400000, 'open' FROM rounds WHERE id = ?2`,
  )
    .bind(NEXT, round)
    .run();
});

beforeEach(() => {
  sent = [];
});

describe('modeOutcomeMessages', () => {
  it('a settled Free mode: win with its net points, loss and void, keyed per game day, with the next round', async () => {
    await seedResult(env.DB, round, 'free', { status: 'settled', winner: 0, tally: [1, 1] });
    const ms = await modeOutcomeMessages(env.DB, round, 'free');
    const byUser = Object.fromEntries(ms.map((m) => [m.userId, m]));
    expect(byUser[ids.user]).toEqual({
      event: 'outcome',
      userId: ids.user,
      dedupeKey: `outcome:2026-10-08:${ids.user}`,
      payload: {
        roundId: round,
        gameDay: '2026-10-08',
        mode: 'free',
        result: 'win',
        amount: '87',
        nextRoundId: NEXT,
        refundReason: null,
      },
    });
    expect(byUser[ids.otherUser]?.payload).toMatchObject({ result: 'loss', amount: null });
    expect(byUser[ids.admin]?.payload).toMatchObject({ result: 'void', amount: null });
  });

  it('a Stakes proposal: win without an amount (it is in the payout tree until final)', async () => {
    await seedResult(env.DB, round, 'stakes', {
      status: 'settle_proposed',
      winner: 1,
      tally: [1, 1],
    });
    const [m] = await modeOutcomeMessages(env.DB, round, 'stakes');
    expect(m?.payload).toMatchObject({ mode: 'stakes', result: 'win', amount: null });
  });

  it('a room round sends nothing', async () => {
    const roomRound = '01K70000000000000000000097';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rounds (id, kind, room_id, opens_at, closes_at, status)
         SELECT ?1, 'room', ?2, opens_at, closes_at, 'closed' FROM rounds WHERE id = ?3`,
      ).bind(roomRound, ids.room, round),
      env.DB.prepare(
        "INSERT INTO round_modes (round_id, mode, status, refund_reason, final_at) VALUES (?1, 'free', 'refunded', 1, 1)",
      ).bind(roomRound),
    ]);
    await seedEntry(env.DB, roomRound, 'free', ids.user, 0);
    expect(await modeOutcomeMessages(env.DB, roomRound, 'free')).toEqual([]);
  });
});

describe('notifyOnModeFinal (post-final hook)', () => {
  it("Free settled → each entrant's outcome", async () => {
    await notifyOnModeFinal(queueEnv(), {
      roundId: round,
      mode: 'free',
      kind: 'daily',
      outcome: 'settled',
    });
    expect(sent.map((m) => m.event)).toEqual(['outcome', 'outcome', 'outcome']);
  });

  it('room rounds send nothing', async () => {
    await notifyOnModeFinal(queueEnv(), {
      roundId: round,
      mode: 'free',
      kind: 'room',
      outcome: 'settled',
    });
    expect(sent).toEqual([]);
  });

  it('Stakes final settlement → payout_claimable to accounts with a payout', async () => {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE round_modes SET status = 'settled', final_at = 1 WHERE round_id = ?1 AND mode = 'stakes'",
      ).bind(round),
      env.DB.prepare(
        "INSERT INTO payouts (round_id, mode, user_id, wallet, kind, amount) VALUES (?1, 'stakes', ?2, '0xaa', 'win', 9000000)",
      ).bind(round, ids.user),
    ]);
    await notifyOnModeFinal(queueEnv(), {
      roundId: round,
      mode: 'stakes',
      kind: 'daily',
      outcome: 'settled',
    });
    expect(sent).toEqual([
      {
        event: 'payout_claimable',
        userId: ids.user,
        dedupeKey: `payout_claimable:${round}:stakes:${ids.user}`,
        payload: {
          roundId: round,
          mode: 'stakes',
          amount: '9000000',
          claimsOpenAt: expect.any(Number) as unknown,
        },
      },
    ]);
  });

  it('a Stakes refund proposal finalized (2) or a vetoed settlement (5) → refunded; refundTimeout (6) → outcome', async () => {
    const refund = async (reason: number) => {
      await env.DB.prepare(
        "UPDATE round_modes SET status = 'refunded', refund_reason = ?2, final_at = 1 WHERE round_id = ?1 AND mode = 'stakes'",
      )
        .bind(round, reason)
        .run();
      sent = [];
      await notifyOnModeFinal(queueEnv(), {
        roundId: round,
        mode: 'stakes',
        kind: 'daily',
        outcome: 'refunded',
      });
      return sent;
    };
    expect(await refund(2)).toEqual([
      {
        event: 'refunded',
        userId: ids.user,
        dedupeKey: `refunded:${round}:stakes:${ids.user}`,
        payload: { roundId: round, mode: 'stakes', refundReason: 2 },
      },
    ]);
    expect((await refund(5))[0]?.payload).toMatchObject({ refundReason: 5 });
    const [timeout] = await refund(6);
    expect(timeout).toMatchObject({
      event: 'outcome',
      dedupeKey: `outcome:2026-10-08:${ids.user}`,
      payload: { mode: 'stakes', result: 'refund', refundReason: 6 },
    });
  });
});

describe('enqueueVoidOutcomes (rule 4)', () => {
  it('tells everyone who entered each voided mode, with refund reason 4', async () => {
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'voided', refund_reason = 4, final_at = 1 WHERE round_id = ?1",
    )
      .bind(round)
      .run();
    expect(await enqueueVoidOutcomes(queueEnv(), round)).toBe(4);
    expect(new Set(sent.map((m) => m.event === 'outcome' && m.payload.refundReason))).toEqual(
      new Set([4]),
    );
    expect(sent.filter((m) => m.event === 'outcome' && m.payload.mode === 'stakes')).toHaveLength(
      1,
    );
  });
});
