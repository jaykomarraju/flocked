// E2E-10 (W7-D): two Stakes entries with identical ciphertexts both count. A player who copies
// another's sealed pick byte for byte from the chain enters the same pick blind (the plaintext binds
// the round, not the player), and both entries are decrypted, tallied and paid as that pick.
//
// Five verified players enter one Stakes round through `/prepare` and `enter`. The second player's
// ciphertext is the first one's, read back from its `Entered` log. Option 0 (the two copies) is the
// minority, so both win, and the proposal's tally, amounts and payout root are what @flocked/settle
// computes with both of them in it.
import { flockedEscrowAbi } from '@flocked/abi';
import { settle, stakesPayoutTree } from '@flocked/settle';
import { parseEventLogs, type Hex } from 'viem';
import { expect, poll, test, type User } from '../fixtures';
import { enterStakes, scheduleRound, waitRound, type Pick } from '../fixtures/rounds';
import { ESCROW_KIND, ESCROW_STATUS, escrowRound } from '../fixtures/wallet';

const STAKE = 1_000_000n;
/** Player 1 copies player 0; players 2–4 pick option 1. */
const PICKS: Pick[] = [0, 0, 1, 1, 1];

test.describe.configure({ mode: 'serial' });

test.describe('identical Stakes ciphertexts both count (E2E-10)', () => {
  const players: User[] = [];
  let roundId: string;
  let chainRoundId: bigint;
  let copied: Hex;

  test.beforeAll(async ({ clock }) => {
    await clock.release();
  });

  test('the second player enters the first one’s ciphertext, byte for byte', async ({
    stack,
    clock,
    user,
  }) => {
    for (let i = 0; i < PICKS.length; i++) players.push(await user({ stakes: true }));
    ({ roundId } = await scheduleRound(stack, {
      free: false,
      stakes: { stake: String(STAKE), minEntrants: 3, capMultiple: 1 },
    }));
    const open = await waitRound(
      stack,
      roundId,
      'the round to open',
      90_000,
      (r) => r.status === 'open',
    );
    chainRoundId = BigInt(open.modes.stakes!.chainRoundId!);

    const first = await enterStakes(stack, clock, players[0]!, open, PICKS[0]!);
    // What anyone can read from the chain: the first entry's ciphertext in its Entered log.
    const [entered] = parseEventLogs({
      abi: flockedEscrowAbi,
      eventName: 'Entered',
      logs: first.receipt.logs,
    });
    copied = entered!.args.ciphertext;
    expect(copied).toBe(first.ciphertext);
    const second = await enterStakes(stack, clock, players[1]!, open, { ciphertext: copied });
    expect(second.ciphertext).toBe(copied);
    for (let i = 2; i < PICKS.length; i++) {
      await enterStakes(stack, clock, players[i]!, open, PICKS[i]!);
    }

    const filed = await poll('the indexer to file all five entries', 60_000, async () => {
      const r = await stack.seamRound(roundId);
      return r?.stakes?.entries.length === PICKS.length ? r.stakes : null;
    });
    expect(filed.entries.map((e) => e.userId)).toEqual(players.map((p) => p.userId));
    expect(filed.entries.every((e) => !e.foreign)).toBe(true);
  });

  test('both copies decrypt to the same pick, are tallied, and both win', async ({
    stack,
    clock,
  }) => {
    const proposed = await poll('the proposal', 300_000, async () => {
      await clock.mine(4);
      const r = await stack.seamRound(roundId);
      return r?.stakes?.status === 'settle_proposed' ? r.stakes : null;
    });
    expect(proposed.entries.map((e) => [e.optionIndex, e.valid])).toEqual(
      PICKS.map((p) => [p, true]),
    );

    const onchain = await escrowRound(stack, chainRoundId);
    expect(onchain.status).toBe(ESCROW_STATUS.SettleProposed);
    expect([onchain.n0, onchain.n1, onchain.nVoid]).toEqual([2, 3, 0]);
    expect(onchain.winner).toBe(0);
    const { record, payouts } = settle(
      players.map((p, i) => ({
        account: p.wallet.lower,
        stake: STAKE,
        option: PICKS[i]!,
        voidReason: null,
      })),
      { feeBps: 500, creatorBps: 100, capMultiple: 1, minEntrants: 3 },
    );
    expect(record).toMatchObject({ outcome: 'settled', winner: 0 });
    const winners = payouts.filter((p) => p.kind === 'win').map((p) => p.account);
    expect(winners.sort()).toEqual([players[0]!.wallet.lower, players[1]!.wallet.lower].sort());
    expect(onchain.winPayout).toBe(payouts.find((p) => p.kind === 'win')!.amount);
    const tree = stakesPayoutTree(
      chainRoundId,
      payouts.map((p) => ({
        account: p.account as Hex,
        kind: ESCROW_KIND[p.kind as keyof typeof ESCROW_KIND],
      })),
    );
    expect(onchain.payoutRoot).toBe(tree.root);
  });
});
