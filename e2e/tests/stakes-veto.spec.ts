// E2E-6 (W7-D): a vetoed refund proposal is followed by a settlement.
//
// Three verified players all pick option 0, so the backend proposes a refund (rule 2, one-sided).
// The guardian vetoes it inside the challenge window (anvil sends as the guardian's address): the
// escrow round is Open again, the indexer supersedes the proposal, moves the mode back to
// `revealing` and opens a `refund_vetoed` settlement hold (W6-F1 O1), and the coordinator proposes
// nothing while it is held. The spec then releases the hold as the guardian's admin action would,
// through the seam (W6-F1's `POST /__test/holds/release`; the admin API is W11-A's), and the
// coordinator proposes again. The re-proposal is deterministic, so it is the same refund (spec
// "Round lifecycle"; no fix is deployed here). In `api-warp` the clocks pass its window and the round
// settles: `finalize`, the mode `refunded` with every stake as a refund payout, claimed on the escrow.
import { flockedEscrowAbi } from '@flocked/abi';
import { ClaimsResponseSchema } from '@flocked/shared';
import { keccak256, stringToHex } from 'viem';
import { expect, poll, test, type User } from '../fixtures';
import { loadPhase, loadUser, savePhase, saveUser, type SavedUser } from '../fixtures/phase';
import { enterStakes, scheduleRound, waitRound } from '../fixtures/rounds';
import { auth } from '../fixtures/user';
import { ESCROW_STATUS, asRole, escrowRound, mined, usdcBalance } from '../fixtures/wallet';

const SPEC = 'stakes-veto';
const STAKE = 1_000_000n;
const PLAYERS = 3;
/** settlement-do.ts HOLD_POLL_MS: a held coordinator looks again once a minute. */
const HOLD_POLL_MS = 60_000;

interface Saved {
  roundId: string;
  chainRoundId: string;
  claimsOpenAt: number;
  players: SavedUser[];
}

test.describe.configure({ mode: 'serial' });

test.describe('a vetoed refund proposal is followed by a settlement (E2E-6)', () => {
  let roundId: string;
  let chainRoundId: bigint;
  const players: User[] = [];

  test('a one-sided round: the backend proposes a refund', async ({ stack, clock, user }) => {
    await clock.release();
    for (let i = 0; i < PLAYERS; i++) players.push(await user({ stakes: true }));
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
    for (const p of players) await enterStakes(stack, clock, p, open, 0);

    const proposed = await poll('the refund proposal', 300_000, async () => {
      await clock.mine(4);
      const r = await stack.seamRound(roundId);
      return r?.stakes?.status === 'refund_proposed' ? r.stakes : null;
    });
    expect(proposed.refundReason).toBe(2);
    expect(proposed.settlements.filter((s) => s.supersededAt === null)).toHaveLength(1);
    const onchain = await escrowRound(stack, chainRoundId);
    expect(onchain.status).toBe(ESCROW_STATUS.RefundProposed);
  });

  test('the guardian vetoes it: Open again, the proposal superseded, a refund_vetoed hold', async ({
    stack,
  }) => {
    await asRole(stack, stack.addresses.guardian, (guardian) =>
      guardian.writeContract({
        address: stack.contracts.escrow,
        abi: flockedEscrowAbi,
        functionName: 'veto',
        args: [chainRoundId, keccak256(stringToHex('e2e: refund proposal vetoed'))],
      }),
    );
    expect((await escrowRound(stack, chainRoundId)).status).toBe(ESCROW_STATUS.Open);
    const held = await poll('the veto, mirrored by the indexer', 90_000, async () => {
      const r = await stack.seamRound(roundId);
      return r?.stakes?.status === 'revealing' &&
        r.holds.some((h) => h.reason === 'refund_vetoed' && h.releasedAt === null)
        ? r
        : null;
    });
    expect(held.stakes!.settlements.every((s) => s.supersededAt !== null)).toBe(true);
    expect(held.holds).toEqual([
      expect.objectContaining({ mode: 'stakes', reason: 'refund_vetoed', txHash: null }),
    ]);
  });

  test('nothing is proposed while held; once released, the coordinator proposes again', async ({
    stack,
    clock,
  }) => {
    // At least one of the coordinator's hold polls passes with the hold open.
    await new Promise((r) => setTimeout(r, HOLD_POLL_MS + 15_000));
    await clock.mine(1);
    expect((await escrowRound(stack, chainRoundId)).status).toBe(ESCROW_STATUS.Open);
    expect((await stack.seamRound(roundId))?.stakes?.status).toBe('revealing');

    const released = await stack.seam<{ releasedAt: number; releasedBy: string }>(
      '/holds/release',
      { roundId, mode: 'stakes', reason: 'refund_vetoed' },
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);

    const again = await poll('the new proposal', HOLD_POLL_MS + 120_000, async () => {
      await clock.mine(1);
      const r = await stack.seamRound(roundId);
      return r?.stakes?.status === 'refund_proposed' ? r : null;
    });
    const live = again.stakes!.settlements.filter((s) => s.supersededAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.seq).toBeGreaterThan(Math.min(...again.stakes!.settlements.map((s) => s.seq)));
    expect(again.holds[0]?.releasedAt).not.toBeNull();
    const onchain = await escrowRound(stack, chainRoundId);
    expect(onchain.status).toBe(ESCROW_STATUS.RefundProposed);
    savePhase(SPEC, {
      roundId,
      chainRoundId: String(chainRoundId),
      claimsOpenAt: Number(onchain.claimsOpenAt) * 1000,
      players: players.map(saveUser),
    } satisfies Saved);
  });

  test(
    'after its window the round settles: refunded, every stake claimable',
    { tag: '@warp' },
    async ({ stack, clock }) => {
      const saved = loadPhase<Saved>(SPEC);
      const ps = saved.players.map((s) => loadUser(stack, s));
      const id = BigInt(saved.chainRoundId);
      await clock.warpTo(Math.ceil(saved.claimsOpenAt / 1000));
      const final = await poll('finalize, mirrored by the indexer', 180_000, async () => {
        const r = await stack.seamRound(saved.roundId);
        return r?.stakes?.status === 'refunded' ? r.stakes : null;
      });
      expect(final.finalAt).not.toBeNull();
      expect(final.refundReason).toBe(2);
      expect((await escrowRound(stack, id)).status).toBe(ESCROW_STATUS.Refunded);
      expect(final.payouts.map((p) => [p.wallet, p.kind, p.amount]).sort()).toEqual(
        ps.map((p) => [p.wallet.lower, 'refund', Number(STAKE)]).sort(),
      );
      for (const p of ps) {
        const listed = ClaimsResponseSchema.parse(
          (await stack.api('/claims', auth(p))).body,
        ).claims;
        expect(listed).toEqual([
          expect.objectContaining({
            roundId: saved.roundId,
            kind: 'refund',
            amount: String(STAKE),
          }),
        ]);
        const before = await usdcBalance(stack, p.wallet.address);
        await mined(
          stack,
          p.wallet.client.writeContract({
            address: stack.contracts.escrow,
            abi: flockedEscrowAbi,
            functionName: 'claimRefund',
            args: [id],
          }),
        );
        expect(await usdcBalance(stack, p.wallet.address)).toBe(before + STAKE);
      }
      await clock.release();
    },
  );
});
