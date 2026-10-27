// A vetoed Stakes settlement in the browser on the stack (W10-D.2; spec "Testing and acceptance
// criteria" E2E-5, AC-5 "a guardian veto of a settlement results in a full refund"; "Round lifecycle":
// settle_proposed → refunded on `ProposalVetoed`, reason 5; "Real-time and the reveal": "If the
// guardian vetoes, clients get `refunded`"). Three players sign in with the smart-wallet stand-in,
// verify personhood in the tab and enter Stakes as sponsored user operations; the round closes, gets
// its beacon and the backend proposes a settlement, which each browser shows as provisional. The
// guardian then vetoes it on the escrow inside the challenge window (anvil sends as the stack's
// guardian, whose key `stack:up` drops; the stack has no other guardian path): the round is
// Refunded onchain at once, the indexer marks the mode refunded and the round socket says so, and
// each browser redraws its result as a refund without a reload. Claims then offers each player its
// whole stake back, claimed from the browser in one sponsored `claimRefund`.
//
// No test here warps: a veto is final the moment it lands, so the whole spec runs in `ui`. The tests
// run in order and share the round and the three pages, which record the Reveal phases and result
// cards they draw.
import { randomInt } from 'node:crypto';
import { flockedEscrowAbi } from '@flocked/abi';
import { ClaimsResponseSchema, VOICE, type RoundView } from '@flocked/shared';
import type { Page } from '@playwright/test';
import { decodeFunctionData, keccak256, stringToHex } from 'viem';
import { refundLine } from '../../apps/web/src/features/reveal/copy';
import { formatUsdc } from '../../apps/web/src/ui/amounts';
import { expect, poll, test } from '../fixtures';
import { produceBlocks } from '../fixtures/clock';
import {
  installSmartWallet,
  newPlayerPage,
  pageRoundMe,
  preparePage,
  recordReveal,
  revealSeen,
  signInWithWallet,
  verifyInBrowser,
  type BrowserSmartWallet,
} from '../fixtures/browser';
import { scheduleRound, waitForToday, waitRound, type Scheduled } from '../fixtures/rounds';
import { ESCROW_STATUS, asRole, escrowRound, giveUsdc, usdcBalance } from '../fixtures/wallet';
import { expectAccessible } from './world';

test.describe.configure({ mode: 'serial' });

const STAKE = 1_000_000n;
const SEAL = 'Seal my pick';
/** Refund reason 5: a guardian veto of a settlement proposal (spec "Settlement" › refund rules). */
const VETOED = 5;

/**
 * W10-C's stable handles, copied (as `stakes-entry.spec.ts` does) because the copy modules' type
 * imports reach Vite-only code: apps/web/src/features/claims/copy.ts `CLAIMS_TITLE`, `READY`,
 * `CLAIM_ALL`, `CLAIMING`, `EMPTY_LINE`, `claimTotal`, `resultWord('refund')`.
 */
const CLAIMS_COPY = {
  title: 'Claims',
  ready: 'Ready',
  refunded: 'Refunded',
  claimAll: 'Claim all',
  claiming: 'Claiming',
  empty: 'Nothing to claim. The flock owes you nothing.',
  total: (total: bigint) => `Claim ${formatUsdc(total)} USDC`,
} as const;

interface Player {
  name: string;
  page: Page;
  smart: BrowserSmartWallet;
  userId: string;
  /** Option 0 is the smaller side: one pick against two, so the proposal is a settlement. */
  pick: 0 | 1;
}

const PICKS = [
  { name: 'V1', pick: 0 },
  { name: 'V2', pick: 1 },
  { name: 'V3', pick: 1 },
] as const;

const prompt = `Vetoed round ${randomInt(1e9)}: mountains or sea?`;
let scheduled: Scheduled;
let round: RoundView;
let chainRoundId: bigint;
const players: Player[] = [];

test.afterAll(async () => {
  await Promise.all(players.map((p) => p.page.context().close()));
});

test('E2E-5: three players sign in in the browser with a smart wallet while a Stakes round is scheduled', async ({
  browser,
  stack,
  clock,
}, testInfo) => {
  test.setTimeout(3 * 60_000);
  await clock.release();
  scheduled = await scheduleRound(stack, {
    opensInMs: 60_000,
    openForMs: 210_000,
    beaconDelay: 60,
    prompt,
    stakes: { stake: String(STAKE), minEntrants: 3 },
  });
  for (const p of PICKS) {
    const page = await newPlayerPage(browser, testInfo);
    await preparePage(page, stack);
    const smart = await installSmartWallet(page, stack);
    await giveUsdc(stack, smart.wallet.address, STAKE);
    await recordReveal(page);
    players.push({ ...p, page, smart, userId: '' });
  }
  await Promise.all(
    players.map(async (p) => {
      p.userId = await signInWithWallet(p.page);
    }),
  );
});

test('E2E-5: each player verifies with Coinbase and enters Stakes from the browser', async ({
  stack,
}) => {
  test.setTimeout(5 * 60_000);
  round = await waitRound(
    stack,
    scheduled.roundId,
    'the round to lock and open',
    150_000,
    (r) => r.status === 'open' && r.lockedAt !== null && r.modes.stakes?.chainRoundId !== null,
  );
  chainRoundId = BigInt(round.modes.stakes!.chainRoundId!);
  await waitForToday(stack, round.id);
  await Promise.all(
    players.map(async (p) => {
      const { page } = p;
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: prompt })).toBeVisible();
      await verifyInBrowser(page, stack, p.smart.wallet.address);
      await page.getByRole('radio', { name: 'Stakes' }).click();
      await page.getByRole('radiogroup', { name: prompt }).getByRole('radio').nth(p.pick).click();
      await page.getByRole('button', { name: SEAL }).click();
      await expect(page.getByText(VOICE.sealed)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('alert')).toHaveCount(0);
    }),
  );
  for (const p of players) {
    expect(p.smart.batches, `${p.name}'s entry`).toHaveLength(1);
    expect(p.smart.batches[0]!.receipts.map((r) => r.status)).toEqual(['success', 'success']);
  }
});

test('E2E-5: the backend proposes a settlement, and each browser shows it as provisional (axe)', async ({
  stack,
}) => {
  test.setTimeout(8 * 60_000);
  const stop = produceBlocks(stack);
  try {
    await waitRound(
      stack,
      round.id,
      'the settlement proposal',
      420_000,
      (r) => r.modes.stakes?.status === 'settle_proposed',
    );
    await Promise.all(
      players.map(async (p) => {
        const card = p.page.locator('section[data-result]');
        await expect(card).toHaveAttribute(
          'data-result',
          p.pick === 0 ? 'unflocked' : 'got-flocked',
          {
            timeout: 120_000,
          },
        );
        await expect(card).toContainText('Provisional. Final at');
        await expectAccessible(p.page);
      }),
    );
  } finally {
    await stop();
  }
  expect((await escrowRound(stack, chainRoundId)).status).toBe(ESCROW_STATUS.SettleProposed);
});

test('E2E-5: the guardian vetoes the settlement; each browser turns its result into a full refund (axe)', async ({
  stack,
}) => {
  test.setTimeout(5 * 60_000);
  await asRole(stack, stack.addresses.guardian, (guardian) =>
    guardian.writeContract({
      address: stack.contracts.escrow,
      abi: flockedEscrowAbi,
      functionName: 'veto',
      args: [chainRoundId, keccak256(stringToHex('e2e ui: settlement vetoed'))],
    }),
  );
  const onchain = await escrowRound(stack, chainRoundId);
  expect(onchain.status).toBe(ESCROW_STATUS.Refunded);

  const stop = produceBlocks(stack);
  try {
    await waitRound(
      stack,
      round.id,
      'the veto, mirrored by the indexer',
      180_000,
      (r) => r.modes.stakes?.status === 'refunded' && r.modes.stakes.refundReason === VETOED,
    );
    await Promise.all(
      players.map(async (p) => {
        // The same page, never reloaded: the round socket's `refunded` redraws it.
        const card = p.page.locator('section[data-result]');
        await expect(card).toHaveAttribute('data-result', 'refunded', { timeout: 60_000 });
        await expect(card).toContainText(refundLine(VETOED));
        await expect(card).not.toContainText('Provisional');
        await expect(card.getByRole('term').nth(1)).toHaveText('Returned');
        await expect(card.getByRole('definition').nth(1)).toHaveText(`${formatUsdc(STAKE)} USDC`);
        await expect(p.page.locator('[data-phase="refunded"]')).toBeVisible();
        await expectAccessible(p.page);

        const mine = await pageRoundMe(p.page, round.id);
        expect(mine.modes.stakes!.payouts).toEqual([
          expect.objectContaining({ kind: 'refund', amount: String(STAKE) }),
        ]);
      }),
    );
  } finally {
    await stop();
  }

  for (const p of players) {
    const seen = await revealSeen(p.page);
    expect(
      seen.map((s) => s.phase).filter((s, i, all) => s !== all[i - 1]),
      `${p.name}'s Reveal phases`,
    ).toEqual(['unsealing', 'counting', 'revealed', 'refunded']);
    // The result card went from the provisional outcome straight to the refund.
    const results = seen.map((s) => s.result).filter((r, i, all) => r !== null && r !== all[i - 1]);
    expect(results, `${p.name}'s result cards`).toEqual([
      p.pick === 0 ? 'unflocked' : 'got-flocked',
      'refunded',
    ]);
  }
});

test('E2E-5: each player claims its whole stake back from Claims in one sponsored claimRefund (axe)', async ({
  stack,
}) => {
  test.setTimeout(15 * 60_000);
  const stop = produceBlocks(stack);
  try {
    for (const p of players) {
      const { page, smart } = p;
      const listed = ClaimsResponseSchema.parse(
        await (await page.request.get('/api/v1/claims')).json(),
      ).claims;
      expect(listed).toEqual([
        expect.objectContaining({ roundId: round.id, kind: 'refund', amount: String(STAKE) }),
      ]);
      await page.goto('/claims');
      await expect(page.getByRole('heading', { name: CLAIMS_COPY.title })).toBeVisible();
      const row = page.getByRole('listitem').filter({ hasText: prompt });
      await expect(row).toContainText(CLAIMS_COPY.refunded);
      await expect(row).toContainText(CLAIMS_COPY.ready);
      await expect(row).toContainText(`${formatUsdc(STAKE)} USDC`);
      await expectAccessible(page);

      const before = await usdcBalance(stack, smart.wallet.address);
      await page.getByRole('button', { name: CLAIMS_COPY.claimAll }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(CLAIMS_COPY.total(STAKE));
      const release = smart.hold();
      await dialog.getByRole('button', { name: CLAIMS_COPY.total(STAKE) }).click();
      await expect(page.getByRole('button', { name: CLAIMS_COPY.claiming })).toBeVisible({
        timeout: 30_000,
      });
      release();
      // Off the list as soon as the batch lands, though the indexer has not seen the claim yet.
      await expect(page.getByText(CLAIMS_COPY.empty)).toBeVisible({ timeout: 30_000 });
      await expectAccessible(page);

      expect(smart.batches).toHaveLength(2);
      const batch = smart.batches[1]!;
      expect(batch.calls.map((c) => c.to)).toEqual([stack.contracts.escrow]);
      expect(decodeFunctionData({ abi: flockedEscrowAbi, data: batch.calls[0]!.data })).toEqual({
        functionName: 'claimRefund',
        args: [chainRoundId],
      });
      expect(batch.receipts.map((r) => r.status)).toEqual(['success']);
      expect(await usdcBalance(stack, smart.wallet.address)).toBe(before + STAKE);
      await poll(`${p.name}'s claims, empty once the indexer sees the claim`, 240_000, async () => {
        const res = await page.request.get('/api/v1/claims');
        return ClaimsResponseSchema.parse(await res.json()).claims.length === 0 ? true : null;
      });
      // And it stays claimed: a fresh load of Claims has nothing for this player.
      await page.reload();
      await expect(page.getByText(CLAIMS_COPY.empty)).toBeVisible();
    }
  } finally {
    await stop();
  }
});
