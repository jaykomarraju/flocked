// AC-8 in the browser (spec "Client app" › Today; "Identity and personhood" › Personhood): the
// Stakes UI is absent for every ineligibility reason `/me` can give, and `not_verified` is the one
// that still shows the mode, with "Verify with Coinbase" and the verification sheet.
//
// Against the mocked world (world.ts), so the app's own production bundle runs each case with no
// stack: `/me`'s eligibility is the only thing that changes between them.
import { INELIGIBLE_REASONS } from '@flocked/shared';
import { expect, test } from '../fixtures';
import { expectAccessible, mockWorld, QUESTION } from './world';

/** "Verify with Coinbase" and the sheet's copy (apps/web/src/features/stakes/copy.ts). */
const VERIFY_CTA = 'Verify with Coinbase';
const VERIFY_TITLE = 'Stakes needs a verified account';
const SEAL = 'Seal my pick';

/** The toggle is a radiogroup; without Stakes it is a static "Free" label instead. */
const toggle = (page: import('@playwright/test').Page) =>
  page.getByRole('radiogroup', { name: 'Mode' });

test.describe('Stakes eligibility (AC-8)', () => {
  test('an eligible player sees Stakes with the round’s fixed stake', async ({ page }) => {
    await mockWorld(page, { stakes: { eligible: true } });
    await page.goto('/');
    await expect(toggle(page)).toBeVisible();
    await page.getByRole('radio', { name: 'Stakes' }).click();
    // The round's fixed stake, not the Free presets.
    await expect(page.getByText('Same for everyone')).toBeVisible();
    await expect(page.getByText('USDC', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Stake presets' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: SEAL })).toBeVisible();
    await expectAccessible(page);
  });

  test('an unverified player sees Stakes with "Verify with Coinbase"', async ({ page }) => {
    await mockWorld(page, { stakes: { eligible: false, reasons: ['not_verified'] } });
    await page.goto('/');
    await page.getByRole('radio', { name: 'Stakes' }).click();
    await expect(page.getByText(VERIFY_TITLE)).toBeVisible();
    await expect(page.getByRole('button', { name: VERIFY_CTA })).toBeVisible();
    await expect(page.getByRole('button', { name: SEAL })).toHaveCount(0);
    // No stake selector: there is nothing to stake yet.
    await expect(page.getByText('Same for everyone')).toHaveCount(0);
    await expectAccessible(page);
  });

  test('the verification sheet needs both boxes before it will verify', async ({ page }) => {
    await mockWorld(page, { stakes: { eligible: false, reasons: ['not_verified'] } });
    await page.goto('/');
    await page.getByRole('radio', { name: 'Stakes' }).click();
    await page.getByRole('button', { name: VERIFY_CTA }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText(VERIFY_TITLE)).toBeVisible();
    const verify = sheet.getByRole('button', { name: VERIFY_CTA });
    await expect(verify).toBeDisabled();
    await sheet.getByRole('checkbox', { name: /18 or older/ }).check();
    await expect(verify).toBeDisabled();
    await sheet.getByRole('checkbox', { name: /accept the/ }).check();
    await expect(verify).toBeEnabled();
    await expectAccessible(page);
    await sheet.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  // AC-8: every reason but `not_verified` hides the mode entirely.
  for (const reason of INELIGIBLE_REASONS.filter((r) => r !== 'not_verified')) {
    test(`Stakes is absent for ${reason}`, async ({ page }) => {
      await mockWorld(page, { stakes: { eligible: false, reasons: [reason] } });
      await page.goto('/');
      // The question is there; the mode toggle is a static "Free" label, with no Stakes anywhere.
      await expect(page.getByRole('heading', { name: QUESTION.prompt })).toBeVisible();
      await expect(toggle(page)).toHaveCount(0);
      await expect(page.getByRole('radio', { name: 'Stakes' })).toHaveCount(0);
      await expect(page.getByText('Stakes')).toHaveCount(0);
      await expect(page.getByRole('button', { name: VERIFY_CTA })).toHaveCount(0);
      await expect(page.getByText('Same for everyone')).toHaveCount(0);
    });
  }

  test('Stakes is absent when another reason sits beside not_verified', async ({ page }) => {
    await mockWorld(page, {
      stakes: { eligible: false, reasons: ['not_verified', 'geo_blocked'] },
    });
    await page.goto('/');
    await expect(toggle(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: VERIFY_CTA })).toHaveCount(0);
  });

  test('Stakes is absent on a round that has no Stakes mode', async ({ page }) => {
    await mockWorld(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: QUESTION.prompt })).toBeVisible();
    await expect(toggle(page)).toHaveCount(0);
  });
});
