// AC-5, the timeout part (W7-D): a Stakes round is refundable when the operator never proposes.
//
// What keeps the operator from proposing is real: besides three verified players, one wallet enters
// with a ticket signed by the escrow's ticket-signer key that the API never issued (as if the key had
// leaked). The indexer stores it as a foreign entry and opens a `foreign_entry` settlement hold, and
// the coordinator posts nothing while it is open. Nobody releases it. In `api-warp`
// (playwright.config.ts) the chain and game clocks move past closesAt + 72 h: the coordinator's
// backstop calls `refundTimeout`, the indexer moves the mode to `refunded` (reason 6) with a refund
// payout per player, and every entrant takes its stake back from the escrow.
import { flockedEscrowAbi } from '@flocked/abi';
import { ClaimsResponseSchema, ticketTypedData } from '@flocked/shared';
import { bytesToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { expect, poll, test, type User } from '../fixtures';
import { loadPhase, loadUser, savePhase, saveUser, type SavedUser } from '../fixtures/phase';
import { enterStakes, scheduleRound, seal, waitRound, type Pick } from '../fixtures/rounds';
import { auth } from '../fixtures/user';
import {
  ESCROW_STATUS,
  escrowRound,
  fundStake,
  mined,
  usdcBalance,
  walletFromKey,
} from '../fixtures/wallet';
import { roundRefFromChainId } from '@flocked/tlock';

const SPEC = 'stakes-timeout';
const STAKE = 1_000_000n;
const PICKS: Pick[] = [0, 1, 1];
const REFUND_TIMEOUT_SEC = 72 * 3600;

interface Saved {
  roundId: string;
  chainRoundId: string;
  closesAt: number;
  players: SavedUser[];
  foreignKey: Hex;
}

test.describe.configure({ mode: 'serial' });

test.describe('the operator never proposes: refundTimeout after 72 hours (AC-5)', () => {
  test('three players and a foreign entry; the hold keeps every proposal back', async ({
    stack,
    clock,
    user,
    wallet,
  }) => {
    await clock.release();
    const players: User[] = [];
    for (let i = 0; i < PICKS.length; i++) players.push(await user({ stakes: true }));
    const { roundId, closesAt } = await scheduleRound(stack, {
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
    const chainRoundId = BigInt(open.modes.stakes!.chainRoundId!);
    for (const [i, p] of players.entries()) await enterStakes(stack, clock, p, open, PICKS[i]!);

    // A ticket the API never issued, signed with the escrow's ticket-signer key.
    const foreign = await wallet();
    const ticket = {
      roundId: chainRoundId,
      wallet: foreign.address,
      personTag: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      expiry: BigInt(open.closesAt + 3600),
    };
    const signature = await privateKeyToAccount(stack.ticketSignerKey()).signTypedData(
      ticketTypedData({ chainId: foundry.id, verifyingContract: stack.contracts.escrow }, ticket),
    );
    await fundStake(stack, foreign, STAKE);
    const ct = await seal(stack, roundRefFromChainId(chainRoundId), open.beaconRound, 1);
    await mined(
      stack,
      foreign.client.writeContract({
        address: stack.contracts.escrow,
        abi: flockedEscrowAbi,
        functionName: 'enter',
        args: [chainRoundId, bytesToHex(ct), ticket, signature],
      }),
    );
    const held = await poll('the foreign entry and its hold', 60_000, async () => {
      const r = await stack.seamRound(roundId);
      return r?.holds.some((h) => h.reason === 'foreign_entry' && h.releasedAt === null) &&
        r.stakes?.entries.length === PICKS.length + 1
        ? r
        : null;
    });
    expect(held.stakes!.entries.filter((e) => e.foreign).map((e) => e.wallet)).toEqual([
      foreign.lower,
    ]);

    // Past close, the beacon and the safe head, the coordinator still proposes nothing.
    await poll('the beacon time to pass', 240_000, async () => {
      await clock.mine(4);
      return Date.now() > (open.beaconTime + 45) * 1000 ? true : null;
    });
    const after = await stack.seamRound(roundId);
    expect(after?.stakes?.settlements).toEqual([]);
    expect(['pending', 'revealing']).toContain(after?.stakes?.status);
    expect((await escrowRound(stack, chainRoundId)).status).toBe(ESCROW_STATUS.Open);
    savePhase(SPEC, {
      roundId,
      chainRoundId: String(chainRoundId),
      closesAt,
      players: players.map(saveUser),
      foreignKey: foreign.key!,
    } satisfies Saved);
  });

  test(
    'past closesAt + 72 h the backend calls refundTimeout; every entrant is refunded',
    { tag: '@warp' },
    async ({ stack, clock }) => {
      const saved = loadPhase<Saved>(SPEC);
      const players = saved.players.map((s) => loadUser(stack, s));
      const foreign = walletFromKey(stack, saved.foreignKey);
      const id = BigInt(saved.chainRoundId);

      await clock.warpTo(saved.closesAt / 1000 + REFUND_TIMEOUT_SEC + 1);
      const refunded = await poll('refundTimeout, mirrored by the indexer', 240_000, async () => {
        const r = await stack.seamRound(saved.roundId);
        return r?.stakes?.status === 'refunded' ? r.stakes : null;
      });
      expect(refunded.refundReason).toBe(6);
      expect(refunded.settlements).toEqual([]);
      const onchain = await escrowRound(stack, id);
      expect(onchain.status).toBe(ESCROW_STATUS.Refunded);
      // A refund payout per player; a foreign entry never gets one, but it is an entrant onchain.
      expect(refunded.payouts.map((p) => [p.wallet, p.kind, p.amount]).sort()).toEqual(
        players.map((p) => [p.wallet.lower, 'refund', Number(STAKE)]).sort(),
      );
      for (const p of players) {
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
      }
      for (const w of [...players.map((p) => p.wallet), foreign]) {
        const before = await usdcBalance(stack, w.address);
        await mined(
          stack,
          w.client.writeContract({
            address: stack.contracts.escrow,
            abi: flockedEscrowAbi,
            functionName: 'claimRefund',
            args: [id],
          }),
        );
        expect(await usdcBalance(stack, w.address)).toBe(before + STAKE);
      }
      await clock.release();
    },
  );
});
