// A Stakes round in the browser on the stack (W10-D.2; spec "Testing and acceptance criteria" E2E-1
// Stakes UI and E2E-4 UI, AC-5's UI half; "Client app" › Entry flow (Stakes), Claims): three players
// sign in with a Coinbase Smart Wallet stand-in (`fixtures/browser.ts` `installSmartWallet`), verify
// personhood in the tab through the stack's Coinbase mock, and enter Stakes as one sponsored user
// operation — `approve(FlockedEscrow, stake)` then `enter`, sponsored by the app's real paymaster
// proxy and its provider mock, and included on anvil. The round closes, gets its beacon and is
// proposed on its own. Each browser shows the pending entry, Sealed, the unsealing countdown,
// "Counting the flock…" and the provisional result ("Provisional. Final at …"), and Claims lists the
// payout as claimable at the end of the challenge window (decision D3).
//
// In `ui-warp` the chain, the game clock and the players' browsers move to the end of the window: the
// coordinator finalizes, and each player claims from Claims in one sponsored batch of `claim` calls,
// exactly what `GET /claims` lists, the winner its payout and the losers only their rebate.
//
// The `ui` tests run in order and share the round and the three pages; every round the warp needs
// is made here, before any warp (e2e/ui/README.md "Two phases"). Each page records the Reveal phases
// it draws, and the warp phase reopens each player from the session and storage the `ui` phase saved.
import { randomInt } from 'node:crypto';
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import { ClaimsResponseSchema, VOICE, type ClaimItem, type RoundView } from '@flocked/shared';
import { fromBase64Url } from '@flocked/tlock';
import type { BrowserContextOptions, Page } from '@playwright/test';
import {
  bytesToHex,
  decodeFunctionData,
  encodeFunctionData,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { formatUsdc } from '../../apps/web/src/ui/amounts';
import { expect, poll, test } from '../fixtures';
import { produceBlocks } from '../fixtures/clock';
import {
  clockTime,
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
import { loadPhase, savePhase } from '../fixtures/phase';
import { scheduleRound, waitForToday, waitRound, type Scheduled } from '../fixtures/rounds';
import { giveUsdc, usdcBalance } from '../fixtures/wallet';
import { expectAccessible } from './world';

test.describe.configure({ mode: 'serial' });

const SPEC = 'ui-stakes-round';
const STAKE = 1_000_000n;
const SEAL = 'Seal my pick';
const COUNTING = 'Counting the flock…';

/**
 * W10-C's stable handles, copied (as `stakes-entry.spec.ts` does) because the copy modules' type
 * imports reach Vite-only code: apps/web/src/features/stakes/copy.ts `STAKE_FIXED`,
 * `CONFIG_NOTICE_TITLE`, `MISMATCH_TITLE`, `PENDING_CTA`, `PENDING_NOTE`, and
 * apps/web/src/features/claims/copy.ts `CLAIMS_TITLE`, `READY_LABEL`, `READY`, `CLAIM_ALL`,
 * `CLAIMING`, `EMPTY_LINE`, `claimTotal`.
 */
const STAKES_COPY = {
  stakeFixed: 'Same for everyone',
  configNotice: 'Special rules today',
  mismatch: "This round doesn't match its onchain record",
  pendingCta: 'Confirming',
  pendingNote: 'Waiting for Base to include your entry. Usually a few seconds.',
} as const;
const CLAIMS_COPY = {
  title: 'Claims',
  readyLabel: 'Ready to claim',
  ready: 'Ready',
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
  /** Option 0 is the smaller side: one pick against two. */
  pick: 0 | 1;
}

interface Saved {
  roundId: string;
  chainRoundId: string;
  prompt: string;
  claimsOpenAt: number;
  players: {
    name: string;
    userId: string;
    key: Hex;
    pick: 0 | 1;
    storageState: Exclude<BrowserContextOptions['storageState'], string | undefined>;
  }[];
}

const PICKS = [
  { name: 'P1', pick: 0 },
  { name: 'P2', pick: 1 },
  { name: 'P3', pick: 1 },
] as const;

/** The escrow calls a batch made, by function name. */
function callNames(batch: { calls: { to: Address; data: Hex }[] }, abi: 'escrow' | 'usdc') {
  return batch.calls.map(
    (c) =>
      decodeFunctionData({ abi: abi === 'escrow' ? flockedEscrowAbi : mockUsdcAbi, data: c.data })
        .functionName,
  );
}

async function claimsOf(page: Page): Promise<ClaimItem[]> {
  const res = await page.request.get('/api/v1/claims');
  expect(res.status()).toBe(200);
  return ClaimsResponseSchema.parse(await res.json()).claims;
}

const prompt = `Stakes round ${randomInt(1e9)}: tea or coffee?`;
let scheduled: Scheduled;
let round: RoundView;
let chainRoundId: bigint;
let claimsOpenAt: number;
const players: Player[] = [];

test.afterAll(async () => {
  await Promise.all(players.map((p) => p.page.context().close()));
});

test('E2E-1 Stakes UI: three players sign in in the browser with a smart wallet while a Stakes round is scheduled', async ({
  browser,
  stack,
  clock,
}, testInfo) => {
  test.setTimeout(3 * 60_000);
  await clock.release();
  // Opens in 60 s (the cron driver's tick locks it and `createRound` confirms first), open for
  // 4 minutes (verifying and entering in the browser), beacon 60 s after.
  scheduled = await scheduleRound(stack, {
    opensInMs: 60_000,
    openForMs: 240_000,
    beaconDelay: 60,
    prompt,
    // A payout cap of 1x leaves a rebate for the losers (spec "Settlement"), so E2E-4 shows both.
    stakes: { stake: String(STAKE), minEntrants: 3, capMultiple: 1 },
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
  expect(new Set(players.map((p) => p.userId)).size).toBe(3);
});

test('E2E-1 Stakes UI: each player verifies with Coinbase in the browser and enters as one sponsored user operation (axe)', async ({
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

      // Back on Today, verified: the round's fixed stake, its special rules (a 1 USDC stake and
      // three players are not the defaults), and the config the chain agrees with.
      await expect(page.getByRole('heading', { level: 1, name: prompt })).toBeVisible();
      await page.getByRole('radio', { name: 'Stakes' }).click();
      await expect(page.getByText(STAKES_COPY.stakeFixed)).toBeVisible();
      await expect(page.getByText(STAKES_COPY.configNotice)).toBeVisible();
      await expect(page.getByText(STAKES_COPY.mismatch)).toHaveCount(0);
      await page.getByRole('radiogroup', { name: prompt }).getByRole('radio').nth(p.pick).click();
      await expectAccessible(page);

      // Pending until Base includes the operation.
      const release = p.smart.hold();
      await page.getByRole('button', { name: SEAL }).click();
      await expect(page.getByRole('button', { name: STAKES_COPY.pendingCta })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(STAKES_COPY.pendingNote)).toBeVisible();
      // No axe while the operation is out: injecting it then outlasts the app's 90 s inclusion
      // wait (as W10-C found in `stakes-entry.spec.ts`); the pending screen's accessibility is the
      // `core/stakes-entry/pending` artboard's.
      release();
      await expect(page.getByText(VOICE.sealed)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('timer', { name: 'Reveal in' })).toBeVisible();
      await expectAccessible(page);
    }),
  );

  const forwarded = (
    (await (await fetch(`${stack.bundlerUrl}/calls`)).json()) as {
      calls: { method: string; params: [{ sender: string }] }[];
    }
  ).calls;
  for (const p of players) {
    // One batch: the USDC approve of exactly the stake, immediately before `enter`, sponsored
    // through the app's own proxy (stub, then final), which forwarded it to the provider.
    expect(p.smart.batches, `${p.name}'s batches`).toHaveLength(1);
    const batch = p.smart.batches[0]!;
    expect(batch.paymasterUrl).toBe(`${stack.appOrigin}/api/v1/paymaster`);
    expect(batch.calls.map((c) => c.to)).toEqual([stack.contracts.usdc, stack.contracts.escrow]);
    expect(batch.calls[0]!.data).toBe(
      encodeFunctionData({
        abi: mockUsdcAbi,
        functionName: 'approve',
        args: [stack.contracts.escrow, STAKE],
      }),
    );
    expect(callNames({ calls: batch.calls.slice(1) }, 'escrow')).toEqual(['enter']);
    expect(batch.sponsorship.map((s) => ('result' in s ? s.result.isFinal : s.error))).toEqual([
      false,
      true,
    ]);
    const sender = p.smart.wallet.lower;
    expect(
      forwarded.filter((c) => c.params[0].sender.toLowerCase() === sender).map((c) => c.method),
    ).toEqual(['pm_getPaymasterStubData', 'pm_getPaymasterData']);
    expect(batch.receipts.map((r) => r.status)).toEqual(['success', 'success']);

    // `Entered` carries the very ciphertext the browser sealed and stored, from the smart wallet.
    const raw = await p.page.evaluate(
      (key) =>
        (
          globalThis as unknown as { localStorage: { getItem(k: string): string | null } }
        ).localStorage.getItem(key),
      `flocked.pick.${p.userId}.${round.id}.stakes`,
    );
    expect(raw, `${p.name}'s stored Stakes pick`).not.toBeNull();
    const stored = JSON.parse(raw!) as {
      optionIndex: number;
      stake: string;
      ciphertext: string;
      wallet: string;
      txHashes: string[];
    };
    expect(stored).toMatchObject({ optionIndex: p.pick, stake: String(STAKE), wallet: sender });
    const enter = batch.receipts[1]!;
    expect(stored.txHashes).toContain(enter.transactionHash);
    const [entered] = parseEventLogs({
      abi: flockedEscrowAbi,
      eventName: 'Entered',
      logs: enter.logs,
    });
    expect(entered?.args.roundId).toBe(chainRoundId);
    expect(entered?.args.player.toLowerCase()).toBe(sender);
    expect(entered?.args.ciphertext).toBe(bytesToHex(fromBase64Url(stored.ciphertext)!));
  }

  // The indexer mirrors each `Entered` into the player's own round.
  const stop = produceBlocks(stack);
  try {
    for (const p of players) {
      const mine = await poll(`${p.name}'s indexed entry`, 90_000, async () => {
        const me = await pageRoundMe(p.page, round.id);
        return me.modes.stakes ? me : null;
      });
      expect(mine.modes.stakes!.entry).toMatchObject({
        stake: String(STAKE),
        wallet: p.smart.wallet.lower,
        txHash: p.smart.batches[0]!.receipts[1]!.transactionHash,
        optionIndex: null,
      });
    }
  } finally {
    await stop();
  }
});

test('E2E-1 Stakes UI: the round closes and is proposed on its own; each browser counts the flock, then shows its provisional result (axe)', async ({
  stack,
}, testInfo) => {
  test.setTimeout(8 * 60_000);
  const timeZone = testInfo.project.use.timezoneId!;
  await Promise.all(
    players.map(async ({ page }) => {
      const timer = page.getByRole('timer', { name: 'Unsealing in' });
      await expect(timer).toBeVisible({ timeout: 300_000 });
      await expect(page.getByText('Your pick')).toBeVisible();
      await expectAccessible(page);
    }),
  );

  const stop = produceBlocks(stack);
  try {
    const proposed = await waitRound(
      stack,
      round.id,
      'the settlement proposal',
      300_000,
      (r) => r.modes.stakes?.status === 'settle_proposed' && r.modes.stakes.claimsOpenAt !== null,
    );
    claimsOpenAt = proposed.modes.stakes!.claimsOpenAt!;
    const finalAt = clockTime(claimsOpenAt, timeZone);
    await Promise.all(
      players.map(async (p) => {
        const reveal = p.page.locator('[data-phase="revealed"]');
        await expect(reveal).toBeVisible({ timeout: 120_000 });
        await expect(reveal).toHaveAttribute('data-reveal-stage', 'done', { timeout: 10_000 });
        const bars = reveal
          .getByRole('list', { name: 'How the crowd split' })
          .getByRole('listitem');
        await expect(bars.nth(0)).toContainText('33%');
        await expect(bars.nth(1)).toContainText('67%');
        await expect(bars.nth(0).locator('[data-winner="true"]')).toHaveCount(1);

        // Provisional until the challenge window closes: the chip says when it is final, and the
        // figures are what `GET /rounds/:id/me` has for this player.
        const mine = await poll(`${p.name}'s provisional result`, 60_000, async () => {
          const me = await pageRoundMe(p.page, round.id);
          return me.modes.stakes?.result ? me : null;
        });
        const stakes = mine.modes.stakes!;
        const won = p.pick === 0;
        expect(stakes.result).toBe(won ? 'win' : 'loss');
        const paid = stakes.payouts.reduce((a, x) => a + BigInt(x.amount), 0n);
        const card = p.page.locator('section[data-result]');
        await expect(card).toHaveAttribute('data-result', won ? 'unflocked' : 'got-flocked');
        await expect(card).toContainText(`Provisional. Final at ${finalAt}`);
        await expect(card.getByRole('term').nth(0)).toHaveText('Stake');
        await expect(card.getByRole('definition').nth(0)).toHaveText(`${formatUsdc(STAKE)} USDC`);
        await expect(card.getByRole('term').nth(1)).toHaveText(won ? 'Payout, once final' : 'Lost');
        await expect(card.getByRole('definition').nth(1)).toHaveText(
          won ? `${formatUsdc(paid)} USDC` : `−${formatUsdc(STAKE - paid)} USDC`,
          { timeout: 15_000 },
        );
        await expectAccessible(p.page);
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
    ).toEqual(['unsealing', 'counting', 'revealed']);
    expect(seen[0]!.text).toContain('Unsealing in');
    expect(seen.find((s) => s.phase === 'counting')!.text).toContain(COUNTING);
  }
});

test('E2E-4 UI: during the challenge window Claims lists each payout as claimable at its end, and nothing can be claimed yet (axe)', async ({
  stack,
}, testInfo) => {
  test.setTimeout(4 * 60_000);
  const opens = `Opens ${clockTime(claimsOpenAt, testInfo.project.use.timezoneId!)}`;
  // `/claims` lists a payout once the indexer holds the proposal the chain does (its bundle hash,
  // behind anvil's safe head), which can trail the reveal by a minute of blocks.
  const stop = produceBlocks(stack);
  try {
    for (const p of players) {
      await poll(`${p.name}'s payout on /claims`, 150_000, async () =>
        (await claimsOf(p.page)).length > 0 ? true : null,
      );
    }
  } finally {
    await stop();
  }
  for (const p of players) {
    const listed = await claimsOf(p.page);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      roundId: round.id,
      kind: p.pick === 0 ? 'win' : 'rebate',
      claimsOpenAt,
    });
    await p.page.goto('/claims');
    await expect(p.page.getByRole('heading', { name: CLAIMS_COPY.title })).toBeVisible();
    const row = p.page.getByRole('listitem').filter({ hasText: prompt });
    await expect(row).toContainText(opens);
    await expect(row).toContainText(`${formatUsdc(BigInt(listed[0]!.amount))} USDC`);
    await expect(p.page.getByRole('button', { name: CLAIMS_COPY.claimAll })).toBeDisabled();
    await expectAccessible(p.page);
  }

  const onchain = await stack.client.readContract({
    address: stack.contracts.escrow,
    abi: flockedEscrowAbi,
    functionName: 'getRound',
    args: [chainRoundId],
  });
  expect(Number(onchain.claimsOpenAt) * 1000).toBe(claimsOpenAt);
  savePhase(SPEC, {
    roundId: round.id,
    chainRoundId: String(chainRoundId),
    prompt,
    claimsOpenAt,
    players: await Promise.all(
      players.map(async (p) => ({
        name: p.name,
        userId: p.userId,
        key: p.smart.wallet.key!,
        pick: p.pick,
        storageState: await p.page.context().storageState(),
      })),
    ),
  } satisfies Saved);
});

test(
  'E2E-4 UI: after the window the round is final, and each player claims exactly what /claims lists from the browser (axe)',
  { tag: '@warp' },
  async ({ browser, stack, clock }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const saved = loadPhase<Saved>(SPEC);
    const at = await clock.warpTo(Math.ceil(saved.claimsOpenAt / 1000));
    const stop = produceBlocks(stack);
    try {
      await waitRound(
        stack,
        saved.roundId,
        'finalize, mirrored by the indexer',
        180_000,
        (r) => r.modes.stakes?.status === 'settled',
      );
      for (const s of saved.players) {
        const page = await newPlayerPage(browser, testInfo, s.storageState);
        try {
          await preparePage(page, stack);
          const smart = await installSmartWallet(page, stack, s.key);
          // The player's clock has moved with the chain's and the game's.
          await page.clock.install({ time: at * 1000 });
          const listed = await claimsOf(page);
          expect(listed).toHaveLength(1);
          const claim = listed[0]!;
          expect(claim).toMatchObject({
            roundId: saved.roundId,
            kind: s.pick === 0 ? 'win' : 'rebate',
          });
          const amount = BigInt(claim.amount);
          if (s.pick === 1) expect(amount).toBeLessThan(STAKE);

          await page.goto('/claims');
          await expect(page.getByRole('heading', { name: CLAIMS_COPY.title })).toBeVisible();
          await expect(page.getByText(CLAIMS_COPY.readyLabel)).toBeVisible();
          const row = page.getByRole('listitem').filter({ hasText: saved.prompt });
          await expect(row).toContainText(CLAIMS_COPY.ready);
          await expect(row).toContainText(`${formatUsdc(amount)} USDC`);
          await expectAccessible(page);

          const before = await usdcBalance(stack, smart.wallet.address);
          await page.getByRole('button', { name: CLAIMS_COPY.claimAll }).click();
          const dialog = page.getByRole('dialog');
          await expect(dialog).toContainText(CLAIMS_COPY.total(amount));
          await expectAccessible(page);
          const release = smart.hold();
          await dialog.getByRole('button', { name: CLAIMS_COPY.total(amount) }).click();
          await expect(page.getByRole('button', { name: CLAIMS_COPY.claiming })).toBeVisible({
            timeout: 30_000,
          });
          release();
          // Off the list as soon as the batch lands, though the indexer has not seen the claim yet.
          await expect(page.getByText(CLAIMS_COPY.empty)).toBeVisible({ timeout: 30_000 });
          await expectAccessible(page);

          // One sponsored batch of exactly the listed claim, and the wallet got exactly its amount.
          expect(smart.batches).toHaveLength(1);
          const batch = smart.batches[0]!;
          expect(batch.paymasterUrl).toBe(`${stack.appOrigin}/api/v1/paymaster`);
          expect(batch.calls.map((c) => c.to)).toEqual([stack.contracts.escrow]);
          expect(decodeFunctionData({ abi: flockedEscrowAbi, data: batch.calls[0]!.data })).toEqual(
            {
              functionName: 'claim',
              args: [BigInt(saved.chainRoundId), s.pick === 0 ? 0 : 1, claim.proof],
            },
          );
          expect(batch.receipts.map((r) => r.status)).toEqual(['success']);
          expect(await usdcBalance(stack, smart.wallet.address)).toBe(before + amount);
          await poll(
            `${s.name}'s claims, empty once the indexer sees the claim`,
            240_000,
            async () => ((await claimsOf(page)).length === 0 ? true : null),
          );
          // And it stays claimed: a fresh load of Claims has nothing for this player.
          await page.reload();
          await expect(page.getByText(CLAIMS_COPY.empty)).toBeVisible();
        } finally {
          await page.context().close();
        }
      }
    } finally {
      await stop();
      await clock.release();
    }
  },
);
