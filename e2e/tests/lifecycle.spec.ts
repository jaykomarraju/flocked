// A daily-shaped round with both modes, end to end at the API level (W7-D): E2E-1 (sign in, verify
// personhood, enter Free, enter Stakes), E2E-2 (close, beacon, reveal) and AC-1 locally (the round
// opens, takes Free and Stakes entries, closes, settles and reveals with no manual step).
//
// The only seam call is the setup: the round is scheduled unlocked. From then on the cron driver
// (the scheduler's lock tick, the indexer kick) and the Durable Objects' alarms move it: lock, Free's
// lock leaf and Stakes' `createRound` onchain, open, close, the commitment anchored, the beacon from
// the local drand network, decryption, Free's settlement and Stakes' proposal. The spec only plays
// the players (API calls, and `enter` from their wallets) and reads the public API. It mines blocks
// as Base would, because anvil mines none on its own and Stakes waits for the safe head (32 blocks
// behind) to pass the close block. Stakes then sits in its 2 h challenge window: its finalize and
// claims are E2E-4 (stakes-claims.spec.ts), after the warp.
import { settle } from '@flocked/settle';
import { escrowRound, ESCROW_STATUS } from '../fixtures/wallet';
import { expect, poll, test, type User } from '../fixtures';
import {
  enterFree,
  enterStakes,
  myRound,
  publicRound,
  scheduleRound,
  waitRound,
  type Pick,
} from '../fixtures/rounds';

/** Option 0 is the minority in both modes, so it wins. */
const PICKS: Pick[] = [0, 1, 1, 0, 1];
const FREE_STAKE = 25n;
const STAKE = 1_000_000n;

test.describe.configure({ mode: 'serial' });

test.describe('lifecycle: a daily round with Free and Stakes, no manual step (AC-1)', () => {
  const players: User[] = [];
  let roundId: string;
  let seamCallsAfterSetup: number;

  test('E2E-1: players sign in and verify, and the round is scheduled (setup)', async ({
    stack,
    clock,
    user,
  }) => {
    await clock.release();
    for (let i = 0; i < PICKS.length; i++) players.push(await user({ stakes: true }));
    ({ roundId } = await scheduleRound(stack, {
      opensInMs: 20_000,
      openForMs: 60_000,
      beaconDelay: 60,
      stakes: { stake: String(STAKE), minEntrants: 3, capMultiple: 1 },
    }));
    seamCallsAfterSetup = stack.seamCalls;
  });

  test('E2E-1: the scheduler locks and opens it; every player enters Free and Stakes', async ({
    stack,
    clock,
  }) => {
    const open = await waitRound(
      stack,
      roundId,
      'the round to open',
      90_000,
      (r) => r.status === 'open',
    );
    expect(open.kind).toBe('daily');
    expect(open.modes.free?.status).toBe('pending');
    expect(open.modes.stakes?.status).toBe('pending');
    expect(open.modes.stakes?.chainRoundId).not.toBeNull();
    const onchain = await escrowRound(stack, BigInt(open.modes.stakes!.chainRoundId!));
    expect(onchain.status).toBe(ESCROW_STATUS.Open);

    for (const [i, p] of players.entries()) {
      await enterFree(stack, p, open, PICKS[i]!, FREE_STAKE);
      await enterStakes(stack, clock, p, open, PICKS[i]!);
    }
    expect(Date.now()).toBeLessThan(open.closesAt * 1000);
    // Each player's entries, through the API: a Free receipt, and the Stakes entry the indexer filed.
    for (const p of players) {
      const me = await myRound(stack, roundId, p);
      expect(me.modes.free?.receipt).not.toBeNull();
      expect(me.modes.free?.entry.stake).toBe(String(FREE_STAKE));
    }
    const indexed = await waitRound(
      stack,
      roundId,
      'the indexer to count the Stakes entries',
      60_000,
      (r) => r.modes.stakes?.entrantCount === PICKS.length,
    );
    expect(indexed.modes.free?.entrantCount).toBe(PICKS.length);
  });

  test('E2E-2: it closes, the beacon arrives, and both modes reveal on their own', async ({
    stack,
    clock,
  }) => {
    const closed = await waitRound(stack, roundId, 'close', 90_000, (r) => r.status === 'closed');
    // Nothing per option before the reveal.
    expect(closed.modes.free?.settlement).toBeNull();
    expect(closed.modes.stakes?.settlement).toBeNull();

    // anvil mines no empty blocks: mine as Base would, so the safe head passes the close block.
    const revealed = await poll('both modes to reveal', 240_000, async () => {
      await clock.mine(4);
      const r = await publicRound(stack, roundId);
      return r?.modes.free?.status === 'settled' && r.modes.stakes?.status === 'settle_proposed'
        ? r
        : null;
    });
    const beaconMs = revealed.beaconTime * 1000;
    const free = revealed.modes.free!;
    const stakes = revealed.modes.stakes!;
    expect(free.revealedAt).toBeGreaterThanOrEqual(beaconMs);
    expect(stakes.revealedAt).toBeGreaterThanOrEqual(beaconMs);
    expect(free.settlement).toMatchObject({ outcome: 'settled', winningOption: 0 });
    expect(stakes.settlement).toMatchObject({ outcome: 'settled', winningOption: 0 });
    const heads = (o: 0 | 1) => PICKS.filter((p) => p === o).length;
    expect(free.settlement!.tally.map((t) => t.headcount)).toEqual([heads(0), heads(1)]);
    expect(stakes.settlement!.tally.map((t) => t.headcount)).toEqual([heads(0), heads(1)]);
    expect(stakes.claimsOpenAt).toBeGreaterThan(beaconMs);
    expect(stakes.finalAt).toBeNull();

    // The proposal onchain carries the tally and the amounts @flocked/settle derives in Node.
    const onchain = await escrowRound(stack, BigInt(stakes.chainRoundId!));
    expect(onchain.status).toBe(ESCROW_STATUS.SettleProposed);
    expect([onchain.n0, onchain.n1, onchain.nVoid]).toEqual([heads(0), heads(1), 0]);
    const { record } = settle(
      players.map((p, i) => ({
        account: p.wallet.lower,
        stake: STAKE,
        option: PICKS[i]!,
        voidReason: null,
      })),
      { feeBps: 500, creatorBps: 100, capMultiple: 1, minEntrants: 3 },
    );
    expect(onchain.fee).toBe(record.fee);
  });

  test('E2E-2: each player sees the Free result and their outcome', async ({ stack }) => {
    for (const [i, p] of players.entries()) {
      const me = await myRound(stack, roundId, p);
      expect(me.modes.free?.result).toBe(PICKS[i] === 0 ? 'win' : 'loss');
      expect(me.modes.free?.entry.optionIndex).toBe(PICKS[i]);
      expect(me.modes.stakes?.entry.optionIndex).toBe(PICKS[i]);
    }
  });

  test('AC-1: no seam call after the setup', ({ stack }) => {
    expect(stack.seamCalls).toBe(seamCallsAfterSetup);
  });
});
