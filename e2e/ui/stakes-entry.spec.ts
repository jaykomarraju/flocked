// Stakes entry and the two global states that hide Stakes (W10-C; spec "Client app" › Entry flow
// (Stakes), "Compliance and responsible play" › Geo-fencing and Responsible play): the artboards
// against their Paper exports. The verification sheet, the pending user operation, a failed entry
// and a config that doesn't match the chain are `core/stakes-entry/*`; the blocked region and the
// self-exclusion break are `core/global/*` (the rest of that row — loading, error, offline, empty —
// has no sheet yet). Then the entry itself in the browser against the mocked world (world.ts): the
// config check's refusal, the round's special rules, and one sponsored user operation of `approve`
// then `enter` through the app's own paymaster URL — the wallet is a smart-wallet stand-in and an
// ERC-7677 mock stands in for W10-D's proxy, so no stack, no chain and no keys are involved.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { expectArtboard } from '../fixtures/screenshot';
import { expectAccessible, mockWorld, QUESTION, type World } from './world';

const STAKES_ENTRY_STATES = ['verify-sheet', 'pending', 'error', 'mismatch'] as const;
const GLOBAL_STATES = ['blocked-region', 'self-excluded'] as const;
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

test.describe('Stakes entry sheets match Paper', () => {
  for (const state of STAKES_ENTRY_STATES) {
    for (const breakpoint of BREAKPOINTS) {
      const artboard = `core/stakes-entry/${state}/${breakpoint}`;
      test(artboard, { tag: '@screenshot' }, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

test.describe('the global states without Stakes match Paper', () => {
  for (const state of GLOBAL_STATES) {
    for (const breakpoint of BREAKPOINTS) {
      const artboard = `core/global/${state}/${breakpoint}`;
      test(artboard, { tag: '@screenshot' }, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

const SEAL = 'Seal my pick';
const CONFIRMING = 'Confirming';
const MISMATCH_TITLE = "This round doesn't match its onchain record";
const RULES_TITLE = 'Special rules today';
const ESCROW = '0x00000000000000000000000000000000000e5c20';

/** Today with Stakes selected and a pick made, ready for "Seal my pick". */
async function pickStakes(page: Page, world: World): Promise<void> {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Stakes' }).click();
  await page.getByRole('radio', { name: QUESTION.options[1] }).click();
  expect(world.stakes).toBeDefined();
}

test.describe('the round config check', () => {
  test('refuses an entry the chain disagrees with, and sends nothing', async ({ page }) => {
    const world = await mockWorld(page, {
      stakes: { eligible: true, onchain: { stake: '50000000' } },
    });
    await pickStakes(page, world);
    await expect(page.getByText(MISMATCH_TITLE)).toBeVisible();
    await expect(page.getByRole('button', { name: SEAL })).toBeDisabled();
    await expectAccessible(page);

    // "See what doesn't match" names the field.
    await page.getByRole('button', { name: "See what doesn't match" }).click();
    await expect(page.getByText(/^stake: published/)).toBeVisible();
    expect(world.stakes?.sent).toHaveLength(0);
  });

  test('refuses on a question the chain does not have', async ({ page }) => {
    const world = await mockWorld(page, {
      stakes: { eligible: true, onchain: { questionHash: `0x${'11'.repeat(32)}` } },
    });
    await pickStakes(page, world);
    await expect(page.getByText(MISMATCH_TITLE)).toBeVisible();
    await expect(page.getByRole('button', { name: SEAL })).toBeDisabled();
    expect(world.stakes?.sent).toHaveLength(0);
  });

  test('shows the round’s special rules, with their change-log IDs', async ({ page }) => {
    const world = await mockWorld(page, {
      stakes: { eligible: true, published: { stake: '10000000', minEntrants: 30 } },
    });
    await pickStakes(page, world);
    await expect(page.getByText(RULES_TITLE)).toBeVisible();
    await expect(page.getByText(/Stake 10 USDC \(usually 5\)/)).toBeVisible();
    await expect(page.getByText(/At least 30 players \(usually 20\)/)).toBeVisible();
    await expect(page.getByRole('button', { name: /See the change log \(#A1F3/ })).toBeVisible();
    // Non-default is not a refusal: the entry can still be sealed.
    await expect(page.getByRole('button', { name: SEAL })).toBeEnabled();
    await expectAccessible(page);
  });
});

test.describe('the Stakes entry', () => {
  test('sends approve then enter as one sponsored user operation', async ({ page }) => {
    const world = await mockWorld(page, { stakes: { eligible: true } });
    await pickStakes(page, world);
    await expect(page.getByText(MISMATCH_TITLE)).toHaveCount(0);
    await page.getByRole('button', { name: SEAL }).click();

    await expect.poll(() => world.stakes?.sent.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    const batch = world.stakes!.sent[0]!;
    // One user operation, two calls: the USDC approve immediately before `enter`.
    expect(batch.calls).toHaveLength(2);
    expect(batch.calls[0]!.data.startsWith('0x095ea7b3')).toBe(true);
    expect(batch.calls[1]!.to.toLowerCase()).toBe(ESCROW);
    // It was sponsored through the app's own paymaster proxy, not paid for in ETH.
    expect(
      (batch.capabilities as { paymasterService?: { url?: string } }).paymasterService?.url,
    ).toMatch(/\/api\/v1\/paymaster$/);
    await expect
      .poll(() => world.stakes?.paymasterCalls.map((c) => c.method) ?? [])
      .toContain('pm_getPaymasterData');

    // The pick is stored for Sealed and the reveal.
    await expect(page.getByText('Your pick is sealed')).toBeVisible({ timeout: 15_000 });
  });

  test('shows pending until Base includes the entry', async ({ page }) => {
    const world = await mockWorld(page, { stakes: { eligible: true } });
    // Hold the paymaster call: the screen must stay on "Confirming" until the batch lands.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route(/\/api\/v1\/paymaster$/, async (route) => {
      await held;
      await route.fallback();
    });
    await pickStakes(page, world);
    await page.getByRole('button', { name: SEAL }).click();
    await expect(page.getByRole('button', { name: CONFIRMING })).toBeVisible();
    await expect(
      page.getByText('Waiting for Base to include your entry. Usually a few seconds.'),
    ).toBeVisible();
    // The other option is not pickable while the entry is out.
    await expect(page.getByRole('radio', { name: QUESTION.options[0] })).toBeDisabled();
    // No axe here: the held request leaves the page mid-flight, where injecting axe is flaky. The
    // pending screen's own accessibility is the `core/stakes-entry/pending` artboard's.
    release();
    await expect(page.getByText('Your pick is sealed')).toBeVisible({ timeout: 15_000 });
  });

  test('tells the player when the entry reverts, and keeps their selection', async ({ page }) => {
    const world = await mockWorld(page, { stakes: { eligible: true } });
    await pickStakes(page, world);
    world.stakes!.revert = true;
    await page.getByRole('button', { name: SEAL }).click();
    await expect(page.getByRole('alert')).toContainText(
      "Base turned the entry down. Your USDC didn't move.",
    );
    // The pick is still selected, and the CTA is live again.
    await expect(page.getByRole('radio', { name: QUESTION.options[1] })).toBeChecked();
    await expect(page.getByRole('button', { name: SEAL })).toBeEnabled();
    await expectAccessible(page);
  });
});
