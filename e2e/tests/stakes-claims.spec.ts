// E2E-4 (API) (W7-D): claims after the challenge window. Four verified players enter a Stakes round
// through `/prepare` and `enter`: one wins, two lose (each gets the rebate) and one seals a bad pick
// (VOID, its stake back). The backend proposes after the beacon. In `api-warp` (playwright.config.ts)
// the chain and game clocks move to claimsOpenAt: the coordinator calls `finalize`, the indexer
// writes the payouts, and each player claims exactly what `GET /claims` lists, with its proof, on the
// escrow. A claim shows up as claimed, and nobody can claim twice (AC-5: exact claims after the
// window, losers only their rebate, claims within the derived totals).
import { flockedEscrowAbi } from '@flocked/abi';
import { settle } from '@flocked/settle';
import { ClaimsResponseSchema, type ClaimItem } from '@flocked/shared';
import { BaseError, ContractFunctionRevertedError, type Hex } from 'viem';
import { expect, poll, test, type Stack, type User } from '../fixtures';
import { loadPhase, loadUser, savePhase, saveUser, type SavedUser } from '../fixtures/phase';
import { enterStakes, scheduleRound, waitRound, type Pick } from '../fixtures/rounds';
import { auth } from '../fixtures/user';
import { ESCROW_KIND, ESCROW_STATUS, escrowRound, mined, usdcBalance } from '../fixtures/wallet';

const SPEC = 'stakes-claims';
const STAKE = 1_000_000n;
/** Option 0 wins (one against two); the last player's pick is VOID. */
const PICKS: Pick[] = [0, 1, 1, null];

interface Saved {
  roundId: string;
  chainRoundId: string;
  claimsOpenAt: number;
  players: SavedUser[];
}

async function claimsOf(stack: Stack, user: User): Promise<ClaimItem[]> {
  const res = await stack.api('/claims', auth(user));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ClaimsResponseSchema.parse(res.body).claims;
}

function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError
    ? (reverted.data?.errorName ?? null)
    : null;
}

test.describe.configure({ mode: 'serial' });

test.describe('Stakes claims after the challenge window (E2E-4)', () => {
  test('four players enter, and the backend proposes after the beacon', async ({
    stack,
    clock,
    user,
  }) => {
    await clock.release();
    const players: User[] = [];
    for (let i = 0; i < PICKS.length; i++) players.push(await user({ stakes: true }));
    const { roundId } = await scheduleRound(stack, {
      free: false,
      stakes: { stake: String(STAKE), minEntrants: 3, capMultiple: 1 },
    });
    const open = await waitRound(
      stack,
      roundId,
      'the round to open',
      90_000,
      (r) => r.status === 'open',
    );
    for (const [i, p] of players.entries()) await enterStakes(stack, clock, p, open, PICKS[i]!);

    const proposed = await poll('the proposal', 300_000, async () => {
      await clock.mine(4);
      const r = await stack.seamRound(roundId);
      return r?.stakes?.status === 'settle_proposed' ? r.stakes : null;
    });
    expect(proposed.claimsOpenAt).not.toBeNull();
    // In the window /claims already lists each payout of the live proposal, with its proof and
    // claimsOpenAt, but the escrow refuses a claim until the round is final.
    for (const p of players) {
      const [item, ...rest] = await claimsOf(stack, p);
      expect(rest).toEqual([]);
      expect(item).toMatchObject({ roundId, claimsOpenAt: proposed.claimsOpenAt });
      const early = await stack.client
        .simulateContract({
          account: p.wallet.account,
          address: stack.contracts.escrow,
          abi: flockedEscrowAbi,
          functionName: 'claim',
          args: [
            BigInt(proposed.chainRoundId!),
            ESCROW_KIND[item!.kind as keyof typeof ESCROW_KIND],
            item!.proof as Hex[],
          ],
        })
        .then(() => null, revertName);
      expect(early).toBe('WrongStatus');
    }
    savePhase(SPEC, {
      roundId,
      chainRoundId: proposed.chainRoundId!,
      claimsOpenAt: proposed.claimsOpenAt!,
      players: players.map(saveUser),
    } satisfies Saved);
  });

  test(
    'after the window: finalize, then each player claims exactly what /claims lists',
    { tag: '@warp' },
    async ({ stack, clock }) => {
      const saved = loadPhase<Saved>(SPEC);
      const players = saved.players.map((s) => loadUser(stack, s));
      const chainRoundId = BigInt(saved.chainRoundId);

      await clock.warpTo(Math.ceil(saved.claimsOpenAt / 1000));
      const settled = await poll('finalize, mirrored by the indexer', 180_000, async () => {
        const r = await stack.seamRound(saved.roundId);
        return r?.stakes?.status === 'settled' ? r.stakes : null;
      });
      const onchain = await escrowRound(stack, chainRoundId);
      expect(onchain.status).toBe(ESCROW_STATUS.Settled);
      expect(settled.finalAt).not.toBeNull();

      // The amounts @flocked/settle derives: the winner, two rebates, one VOID refund.
      const { payouts } = settle(
        players.map((p, i) => ({
          account: p.wallet.lower,
          stake: STAKE,
          option: PICKS[i]!,
          voidReason: PICKS[i] === null ? 'bad_option' : null,
        })),
        { feeBps: 500, creatorBps: 100, capMultiple: 1, minEntrants: 3 },
      );
      expect(payouts.map((p) => p.kind).sort()).toEqual(['rebate', 'rebate', 'void_refund', 'win']);

      let paid = 0n;
      for (const p of players) {
        const want = payouts.find((x) => x.account === p.wallet.lower)!;
        const [item, ...rest] = await claimsOf(stack, p);
        expect(rest).toEqual([]);
        expect(item).toMatchObject({
          roundId: saved.roundId,
          chainRoundId: saved.chainRoundId,
          kind: want.kind,
          account: p.wallet.lower,
          amount: String(want.amount),
          userId: p.userId,
        });
        const kind = ESCROW_KIND[want.kind as keyof typeof ESCROW_KIND];
        const balance = await usdcBalance(stack, p.wallet.address);
        await mined(
          stack,
          p.wallet.client.writeContract({
            address: stack.contracts.escrow,
            abi: flockedEscrowAbi,
            functionName: 'claim',
            args: [chainRoundId, kind, item!.proof as Hex[]],
          }),
        );
        expect(await usdcBalance(stack, p.wallet.address)).toBe(balance + want.amount);
        paid += want.amount;

        // Once is all: a second claim reverts.
        const again = await stack.client
          .simulateContract({
            account: p.wallet.account,
            address: stack.contracts.escrow,
            abi: flockedEscrowAbi,
            functionName: 'claim',
            args: [chainRoundId, kind, item!.proof as Hex[]],
          })
          .then(() => null, revertName);
        expect(again).toBe('AlreadyClaimed');
      }
      // Claims never exceed the derived totals: the four stakes less the fee, creator fee and dust.
      const after = await escrowRound(stack, chainRoundId);
      expect(paid + after.fee + after.creatorFee + after.dust).toBe(STAKE * BigInt(PICKS.length));

      // The indexer marks each claim; /claims no longer lists the round.
      for (const p of players) {
        await poll('the claim to be indexed', 60_000, async () =>
          (await claimsOf(stack, p)).length === 0 ? true : null,
        );
      }
      await clock.release();
    },
  );
});
