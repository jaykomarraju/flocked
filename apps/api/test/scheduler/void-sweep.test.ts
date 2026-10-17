// The scheduler tick's guardian-void sweep (step 7, W9-F1; spec "Round lifecycle": a `RoundRefunded`
// with reason 4 before close that the backend didn't start voids Stakes and notifies its players).
// A handler on that event puts a whole indexer poll over its D1 budget (W9-D open issue 1: 619 > 500),
// so the tick sweeps the Stakes modes that became `voided` recently instead (owner decision, Oct 16,
// 2026). The void itself runs through the real `stakesVoidHandler`.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { stakesVoidHandler } from '../../src/lifecycle/handlers.js';
import { notifyHandler } from '../../src/notify/consumer.js';
import { schedulerTick, VOID_SWEEP_WINDOW_MS } from '../../src/scheduler/tick.js';
import type { NotifyMessage } from '@flocked/shared';
import { chainEvent, commitStatements } from '../lifecycle/helpers.js';
import { seedFixture, FIXED_NOW, type Fixture } from '../helpers/index.js';
import { fakeDeps, seedEntry } from '../notify/helpers.js';
import { setClock } from './helpers.js';

let ids: Fixture['ids'];
let round: string;
let enqueued: NotifyMessage[] = [];

/**
 * `env` as a proxy (so `setClock` still reaches it) with a recording notify queue and a stand-in
 * RoundDO namespace: the void's broadcast and the tick's `init` are other sessions' tests, and a real
 * DO call for a round this file never initialises only leaves unhandled rejections behind.
 */
const fakeEnv = (): Env =>
  new Proxy(env, {
    get: (o, k): unknown => {
      if (k === 'QUEUE_NOTIFY') {
        return {
          send: (body: NotifyMessage) => Promise.resolve(void enqueued.push(body)),
          sendBatch: (ms: { body: NotifyMessage }[]) =>
            Promise.resolve(void enqueued.push(...ms.map((m) => m.body))),
        };
      }
      if (k === 'ROUND') {
        return {
          idFromName: (name: string) => name,
          get: () => ({
            init: () => Promise.resolve(),
            onModeResult: () => Promise.resolve(),
          }),
        };
      }
      return Reflect.get(o, k);
    },
  });

/** One tick at `t`, with what it enqueued. */
async function tick(t: number) {
  setClock(t);
  enqueued = [];
  const report = await schedulerTick(fakeEnv());
  return { report, messages: [...enqueued] };
}

beforeAll(async () => {
  const fx = await seedFixture(env.DB);
  ids = fx.ids;
  round = fx.round.id;
  await seedEntry(env.DB, round, 'stakes', ids.user, 0, { stake: 5_000_000 });
  await seedEntry(env.DB, round, 'stakes', ids.otherUser, 1, { stake: 5_000_000 });
  await seedEntry(env.DB, round, 'free', ids.admin, 0);
});

describe('the guardian-void sweep', () => {
  it('a guardian RoundRefunded(4) tells each Stakes entrant once', async () => {
    // The guardian's void, a minute ago, through the indexer handler that records it.
    const evt = chainEvent(
      'escrow',
      'RoundRefunded',
      { roundId: '1', reason: '4' },
      { blockTimestampSec: Math.floor((FIXED_NOW - 60_000) / 1000) },
    );
    await commitStatements(await stakesVoidHandler(evt, fakeEnv(), { rpc: null as never }));
    expect(
      await env.DB.prepare(
        "SELECT status, refund_reason FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'",
      )
        .bind(round)
        .first(),
    ).toEqual({ status: 'voided', refund_reason: 4 });
    expect(enqueued).toEqual([]);

    // Two ticks sweep it: the window overlaps the last pass, so the second enqueues it again.
    const first = await tick(FIXED_NOW);
    expect(first.report.voidsNotified).toEqual({ [round]: 2 });
    const second = await tick(FIXED_NOW + 60_000);
    expect(second.report.voidsNotified).toEqual({ [round]: 2 });
    const messages = [...first.messages, ...second.messages];
    expect(
      messages.map((m) => [m.userId, m.event === 'outcome' && m.payload.refundReason]).sort(),
    ).toEqual([
      [ids.user, 4],
      [ids.user, 4],
      [ids.otherUser, 4],
      [ids.otherUser, 4],
    ]);
    // Only the voided Stakes mode: the Free mode plays on.
    expect(messages.every((m) => m.event === 'outcome' && m.payload.mode === 'stakes')).toBe(true);
    expect(
      (
        await env.DB.prepare("SELECT status FROM round_modes WHERE round_id = ?1 AND mode = 'free'")
          .bind(round)
          .first<{ status: string }>()
      )?.status,
    ).toBe('pending');

    // The dedupe key sends one notification per entrant, however often the sweep enqueues it.
    const { deps, webpush, farcaster } = fakeDeps();
    for (const m of messages) await notifyHandler(m, env, deps);
    expect(webpush.sent.map((d) => [d.recipient.userId, d.copy.title]).sort()).toEqual([
      [ids.user, 'Stakes round refunded'],
      [ids.otherUser, 'Stakes round refunded'],
    ]);
    expect(farcaster.sent).toHaveLength(2);

    // Once the notices are in notification_log the sweep leaves the round alone.
    const third = await tick(FIXED_NOW + 120_000);
    expect(third.report.voidsNotified).toEqual({});
    expect(third.messages).toEqual([]);
  });

  it('leaves a void older than the window alone', async () => {
    // With the log cleared, only the window keeps the sweep away from the same voided mode.
    await env.DB.prepare('DELETE FROM notification_log').run();
    const old = await tick(FIXED_NOW + VOID_SWEEP_WINDOW_MS + 60_000);
    expect(old.report.voidsNotified).toEqual({});
    expect(old.messages).toEqual([]);
  });
});
