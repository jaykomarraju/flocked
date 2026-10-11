// AC-6 (first half), on the fake chain: two consecutive daily rounds. The scheduler locks each at
// opensAt − 6 h and its Free lock leaf lands through the AnchorDO; the RoundDO opens it at opensAt,
// closes it at closesAt and hands the commitment root to the AnchorDO, which writes it before the
// beacon. Exactly one lock leaf and one commitment for a Free round with entries; an empty Free mode
// anchors no commitment (Decision log, Oct 9, 2026). The anvil-backed version is
// e2e/tests/lifecycle-open-close.test.ts.
import { env } from 'cloudflare:test';
import { flockedAnchorAbi } from '@flocked/abi';
import { roundKey, type LockedConfig } from '@flocked/shared';
import { decodeFunctionData, type Hex } from 'viem';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dailySlot, insertDailyRound, type DailySlot } from '../../src/scheduler/create.js';
import { schedulerTick } from '../../src/scheduler/tick.js';
import { FAKE_ANCHOR, type FakeChain } from '../anchor-do/fake-chain.js';
import {
  alarmAt,
  createUser,
  okValue,
  readMeta,
  sealedPick,
  useTestSigner,
} from '../round-do/helpers.js';
import { HOUR, chainHarness, insertQuestion, setClock } from '../scheduler/helpers.js';
import { modeRow, recordQueues } from './helpers.js';

beforeAll(() => {
  useTestSigner();
});

let queues: ReturnType<typeof recordQueues> | null = null;
afterEach(() => {
  queues?.restore();
  queues = null;
});

/** A daily round with a scheduled question (the scheduler picks it at lock). */
async function dailyRound(gameDay: string): Promise<{ id: string; slot: DailySlot; key: Hex }> {
  const slot = dailySlot(gameDay);
  const id = (await insertDailyRound(env.DB, slot)) as string;
  const qId = await insertQuestion({ status: 'scheduled' });
  await env.DB.prepare('UPDATE rounds SET question_id = ?2 WHERE id = ?1').bind(id, qId).run();
  return { id, slot, key: roundKey(id, 'free') };
}

/** The anchor functions the fake chain has mined for `key`, in order. */
function anchorCalls(fake: FakeChain, key: Hex): string[] {
  return (
    fake.sent
      .filter((tx) => tx.to.toLowerCase() === FAKE_ANCHOR && fake.mined.includes(tx.hash))
      .map((tx) => decodeFunctionData({ abi: flockedAnchorAbi, data: tx.data }))
      // Every anchor write takes the round keys as its first argument.
      .filter((call) => (call.args as unknown as [readonly Hex[]])[0].includes(key))
      .map((call) => call.functionName)
  );
}

describe('AC-6 (first half): one lock leaf and one commitment before the beacon', () => {
  it('runs two daily rounds lock → open → close → commit with no manual step', async () => {
    queues = recordQueues();
    const day1 = await dailyRound('2027-05-04');
    const day2 = await dailyRound('2027-05-05');
    const lockAt = day1.slot.opensAt - 6 * HOUR;
    const h = await chainHarness(lockAt);
    const step = (ms: number) => {
      setClock(ms);
      h.fake.time = Math.floor(ms / 1000);
    };
    /** AnchorDO passes, a block apart, until `done` (each pass sends or reads a receipt). */
    const anchorUntil = async (at: number, done: () => boolean) => {
      for (let k = 0; k < 6 && !done(); k++) {
        step(at + k * 2_000);
        await h.runAnchor();
      }
      step(at + 12_000);
      await h.runAnchor();
    };

    // Day 1 lock: the scheduler's tick locks it, queues its lock leaf and inits its RoundDO.
    step(lockAt);
    const report = await schedulerTick(env, h.deps);
    expect(report.locks[day1.id]).toBe('locked');
    expect(report.initialized).toContain(day1.id);
    await anchorUntil(lockAt, () => h.fake.anchorOf(day1.key).lockedAt > 0n);
    expect((await modeRow(day1.id, 'free'))?.lock_tx).toMatch(/^0x[0-9a-f]{64}$/);

    // Day 1 open: the RoundDO's own alarm at opensAt.
    const stub1 = env.ROUND.get(env.ROUND.idFromName(day1.id));
    step(day1.slot.opensAt);
    await alarmAt(stub1, day1.slot.opensAt);
    expect((await stub1.getState()).status).toBe('open');
    const row = await env.DB.prepare(
      'SELECT status, beacon_round, config_json FROM rounds WHERE id = ?1',
    )
      .bind(day1.id)
      .first<{ status: string; beacon_round: number; config_json: string }>();
    expect(row?.status).toBe('open');
    const pickFor = {
      roundId: day1.id,
      beaconRound: row?.beacon_round as number,
      config: JSON.parse(row?.config_json as string) as LockedConfig,
    };
    for (const option of [0, 1, 1] as const) {
      okValue(
        await stub1.enterFree({
          roundId: day1.id,
          userId: await createUser(500),
          body: { stake: '50', ciphertext: await sealedPick(pickFor, option) },
        }),
      );
    }

    // Day 2 lock, while day 1 is open.
    const lock2 = day2.slot.opensAt - 6 * HOUR;
    step(lock2);
    expect((await schedulerTick(env, h.deps)).locks[day2.id]).toBe('locked');
    await anchorUntil(lock2, () => h.fake.anchorOf(day2.key).lockedAt > 0n);

    // Day 1 close (= day 2 open): the root goes to the AnchorDO and onchain before the beacon.
    const closesAt = day1.slot.closesAt;
    step(closesAt);
    await alarmAt(stub1, closesAt);
    const close = (await readMeta(stub1))?.freeClose;
    expect(close).toMatchObject({ entryCount: 3, totalStake: '150', anchor: 'queued' });
    await anchorUntil(closesAt, () => h.fake.anchorOf(day1.key).committedAt > 0n);

    const onchain = h.fake.anchorOf(day1.key);
    const beaconTimeSec = (await stub1.getState()).beaconTimeSec;
    expect(onchain).toMatchObject({
      commitmentRoot: close?.root,
      entryCount: 3,
      totalStake: 150n,
    });
    expect(onchain.committedAt).toBeGreaterThan(0n);
    expect(onchain.committedAt).toBeLessThan(BigInt(beaconTimeSec));
    const mode1 = await modeRow(day1.id, 'free');
    expect(mode1).toMatchObject({ status: 'pending', commitment_root: close?.root });
    expect(mode1?.commit_tx).toMatch(/^0x[0-9a-f]{64}$/);

    // Day 2: open at opensAt, no entries, closed at closesAt: a lock leaf and no commitment.
    const stub2 = env.ROUND.get(env.ROUND.idFromName(day2.id));
    await alarmAt(stub2, day2.slot.opensAt);
    expect((await stub2.getState()).status).toBe('open');
    step(day2.slot.closesAt);
    await alarmAt(stub2, day2.slot.closesAt);
    await anchorUntil(day2.slot.closesAt, () => false);
    expect((await readMeta(stub2))?.freeClose).toMatchObject({ root: null, anchor: 'none' });
    expect(h.fake.anchorOf(day2.key).committedAt).toBe(0n);

    // Later ticks and alarms add nothing.
    step(day2.slot.closesAt + HOUR);
    await schedulerTick(env, h.deps);
    await h.runAnchor();
    await alarmAt(stub1, beaconTimeSec * 1000 + HOUR);
    expect(anchorCalls(h.fake, day1.key)).toEqual(['lock', 'commit']);
    expect(anchorCalls(h.fake, day2.key)).toEqual(['lock']);
    expect(queues.settled.filter((m) => m.roundId === day1.id).map((m) => m.mode)).toEqual([
      'free',
    ]);
  });
});
