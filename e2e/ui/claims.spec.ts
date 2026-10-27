// Claims (W10-C; spec "Client app" › Claims; "API" › `GET /claims`): the four Claims artboards
// against their Paper exports, and the screen itself with axe.
//
// `/claims` is still a Placeholder in the route table (registering it is W10-D's), so the browser
// checks run against the design sheets, which draw the real ClaimsView and the real confirm sheet
// inside the real shell.
import { expect, test } from '../fixtures';
import { expectArtboard } from '../fixtures/screenshot';
import { expectAccessible } from './world';

const CLAIMS_STATES = ['list', 'claim-all', 'pending', 'empty'] as const;
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

test.describe('Claims sheets match Paper', () => {
  for (const state of CLAIMS_STATES) {
    for (const breakpoint of BREAKPOINTS) {
      const artboard = `core/claims/${state}/${breakpoint}`;
      test(artboard, { tag: '@screenshot' }, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

test.describe('Claims in the browser', () => {
  test('the list, the ready total and the claim-open times, with axe', async ({ page }) => {
    await page.goto('/__sheets/core/claims/list/mobile');
    await page.locator('[data-sheet-ready="true"]').waitFor();

    await expect(page.getByRole('heading', { name: 'Claims' })).toBeVisible();
    await expect(page.getByText('Ready to claim')).toBeVisible();
    await expect(page.getByText('17.67 USDC')).toBeVisible();
    await expect(page.getByText('2 of 3 are ready. The third opens at 11:03pm.')).toBeVisible();
    await expect(page.getByText('Pineapple on pizza: yes or no?')).toBeVisible();
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(2);
    await expect(page.getByText('Opens 11:03pm')).toBeVisible();
    await expect(
      page.getByText(/Payouts go to the wallet that entered, 0x3f2c…a91c\./),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim all' })).toBeEnabled();

    await expectAccessible(page);
  });

  test('the confirm sheet lists the ready payouts and what opens later, with axe', async ({
    page,
  }) => {
    await page.goto('/__sheets/core/claims/claim-all/mobile');
    await page.locator('[data-sheet-ready="true"]').waitFor();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Claim 17.67 USDC');
    await expect(dialog).toContainText('Two payouts, one transaction. They go to 0x3f2c…a91c.');
    await expect(dialog).toContainText('The Oct 8 payout opens at 11:03pm. Claim it then.');
    await expect(dialog.getByRole('button', { name: 'Not now' })).toBeVisible();

    await expectAccessible(page);
  });

  test('nothing to claim, with axe', async ({ page }) => {
    await page.goto('/__sheets/core/claims/empty/mobile');
    await page.locator('[data-sheet-ready="true"]').waitFor();

    await expect(page.getByText('Nothing to claim. The flock owes you nothing.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to Today' })).toBeVisible();

    await expectAccessible(page);
  });
});
