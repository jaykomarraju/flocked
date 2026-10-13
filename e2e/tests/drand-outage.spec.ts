// E2E-14 (W7-D): a Free round refunds when the local drand network is held down past 24 hours.
//
// drand's containers are stopped before the round, so its beacon is never published. Once the round
// has closed and its commitment is anchored (so rule 7 doesn't apply), the game clock moves to the
// beacon time + 24 h. drand itself is never warped: it stays down. The RoundDO's next alarm (set at
// close for the beacon time, on wall time) then finds both its settle event and its rule-8 event due,
// and rule 8 refunds Free through the settle queue: the mode goes from `pending` to `refunded` with
// reason 8, nothing is revealed, and every stake comes back. drand is started again afterwards, and
// the late beacon changes nothing.
import { RoundMeResponseSchema } from '@flocked/shared';
import { expect, poll, test, type User } from '../fixtures';
import { getMe, auth } from '../fixtures/user';
import { enterFree, publicRound, scheduleRound, waitRound, type Pick } from '../fixtures/rounds';

const DAY_MS = 24 * 3_600_000;
const PICKS: Pick[] = [0, 1, 1];
const STAKES = [10n, 25n, 50n];

test.describe.configure({ mode: 'serial' });

test.describe('drand outage: rule 8 refunds Free after 24 hours (E2E-14)', () => {
  const players: User[] = [];
  const before = new Map<string, bigint>();
  let roundId: string;
  let beaconTime: number;
  let lastBeacon = 0;

  test.beforeAll(async ({ stack, clock }) => {
    await clock.release();
    lastBeacon = (await stack.latestBeacon()) ?? 0;
    await stack.stopDrand();
  });

  test.afterAll(async ({ stack, clock }) => {
    await clock.release();
    // The stack's drand again, serving beacons, for whatever runs next.
    await stack.startDrand(lastBeacon);
  });

  test('drand is down; a Free round opens and takes entries', async ({ stack, user }) => {
    expect(await stack.latestBeacon()).toBeNull();
    for (let i = 0; i < PICKS.length; i++) players.push(await user());
    ({ roundId } = await scheduleRound(stack, {
      opensInMs: 15_000,
      openForMs: 30_000,
      beaconDelay: 60,
    }));
    const open = await waitRound(
      stack,
      roundId,
      'the round to open',
      60_000,
      (r) => r.status === 'open',
    );
    expect(open.modes.stakes).toBeUndefined();
    beaconTime = open.beaconTime;
    for (const [i, p] of players.entries()) {
      before.set(p.userId, BigInt((await getMe(stack, p)).balances.global));
      await enterFree(stack, p, open, PICKS[i]!, STAKES[i]);
      expect(BigInt((await getMe(stack, p)).balances.global)).toBeLessThan(before.get(p.userId)!);
    }
  });

  test('it closes and its commitment is anchored before the beacon time', async ({ stack }) => {
    await waitRound(stack, roundId, 'close', 60_000, (r) => r.status === 'closed');
    const anchored = await poll('the commitment anchored and mirrored', 90_000, async () => {
      const r = await stack.seamRound(roundId);
      return r?.free?.commitTx && r.anchorEvents.some((e) => e.event === 'Committed') ? r : null;
    });
    expect(Date.now()).toBeLessThan(beaconTime * 1000);
    expect(anchored.free?.status).toBe('pending');
  });

  test('past beacon time + 24 h with drand still down, rule 8 refunds every entry', async ({
    stack,
    clock,
  }) => {
    await clock.pin(beaconTime * 1000 + DAY_MS + 5_000);
    // The RoundDO's alarm for the beacon time fires on wall time, a minute after close at most.
    const refunded = await poll('the rule-8 refund', 180_000, async () => {
      const r = await stack.seamRound(roundId);
      return r?.free?.status === 'refunded' ? r : null;
    });
    expect(await stack.latestBeacon()).toBeNull();
    expect(refunded.free).toMatchObject({ refundReason: 8, revealedAt: null });
    expect(refunded.settlement).toBeNull();
    expect(
      refunded.payouts.map((p) => ({ userId: p.userId, kind: p.kind, amount: BigInt(p.amount) })),
    ).toEqual(
      expect.arrayContaining(
        players.map((p, i) => ({ userId: p.userId, kind: 'refund', amount: STAKES[i] })),
      ),
    );
    expect(refunded.payouts).toHaveLength(players.length);
  });

  test('back on wall time: balances restored, no reveal, and drand returning changes nothing', async ({
    stack,
    clock,
  }) => {
    await clock.release();
    for (const p of players) {
      expect(BigInt((await getMe(stack, p)).balances.global)).toBe(before.get(p.userId));
      const me = RoundMeResponseSchema.parse(
        (await stack.api(`/rounds/${roundId}/me`, auth(p))).body,
      );
      expect(me.modes.free?.result).toBe('refund');
      expect(me.modes.free?.entry.optionIndex).toBeNull();
    }
    const round = await publicRound(stack, roundId);
    expect(round?.modes.free).toMatchObject({
      status: 'refunded',
      refundReason: 8,
      settlement: null,
    });

    // drand comes back and publishes the round's beacon late: the refund stands.
    await stack.startDrand(lastBeacon);
    await poll('drand to pass the round’s beacon', 120_000, async () => {
      const latest = await stack.latestBeacon();
      return latest !== null && latest >= round!.beaconRound ? true : null;
    });
    await new Promise((r) => setTimeout(r, 15_000));
    const after = await stack.seamRound(roundId);
    expect(after?.free).toMatchObject({ status: 'refunded', refundReason: 8, revealedAt: null });
    expect(after?.payouts).toHaveLength(players.length);
  });
});
