// Today (W9-C; spec "Client app" › Today, Entry flow (Free)): the Today artboards against their Paper
// exports, the entry flow's refusals and receipt checks in the browser (world.ts), axe on Today, and a
// Free pick sealed in the browser on the stack.
import { VOICE } from '@flocked/shared';
import { expect, test } from '../fixtures';
import { QUESTION, expectAccessible, mockWorld, readStoredPick } from './world';

const RECEIPT_MISMATCH =
  "Your receipt doesn't match what you sent. We kept it on this device as evidence.";

test.describe('Today in the browser', () => {
  test('signed out and signed in, with axe', async ({ page }) => {
    await mockWorld(page, { signedIn: false });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in to play' })).toBeVisible();
    await expectAccessible(page);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const world = await mockWorld(page);
    await page.goto('/');
    await expect(page.getByText('Would-you-rather days split 63/37 on average.')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Stake presets' })).toBeVisible();
    await page.getByRole('radio', { name: QUESTION.options[0] }).click();
    await expectAccessible(page);
    expect(world.posted).toHaveLength(0);
  });

  test('a round that differs from its onchain lock leaf is refused before anything is sent', async ({
    page,
  }) => {
    const world = await mockWorld(page);
    world.leaf = { ...world.leaf, questionHash: `0x${'ab'.repeat(32)}` };
    await page.goto('/');
    await page.getByRole('radio', { name: QUESTION.options[1] }).click();
    await page.getByRole('button', { name: 'Seal my pick' }).click();
    await expect(page.getByRole('alert')).toContainText("doesn't match its onchain record");
    await expect(page.getByRole('radio', { name: QUESTION.options[1] })).toBeChecked();
    expect(world.posted).toHaveLength(0);
    expect(await readStoredPick(page, world)).toBeNull();
  });

  test('a receipt that fails its checks is shown and kept on the device as evidence', async ({
    page,
  }) => {
    const world = await mockWorld(page);
    // The server answers with another commitment than keccak256 of the browser's ciphertext.
    world.tamper = (r) => ({
      ...r,
      receipt: { ...r.receipt, commitment: `0x${'11'.repeat(32)}` },
    });
    await page.goto('/');
    await page.getByRole('radio', { name: QUESTION.options[0] }).click();
    await page.getByRole('button', { name: 'Seal my pick' }).click();
    await expect(page.getByText(VOICE.sealed)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText(RECEIPT_MISMATCH);
    const stored = await readStoredPick(page, world);
    expect(stored?.mismatches).toEqual(['receipt.commitment']);
    expect(stored?.evidence).toMatchObject({ receipt: { commitment: `0x${'11'.repeat(32)}` } });
  });

  test('retries a 503 from a RoundDO that is down', async ({ page }) => {
    const world = await mockWorld(page);
    let first = true;
    await page.route(/\/api\/v1\/rounds\/[^/]+\/entries$/, async (route) => {
      if (first) {
        first = false;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'unavailable', message: 'down' } }),
        });
      }
      return route.fallback();
    });
    await page.goto('/');
    await page.getByRole('radio', { name: QUESTION.options[0] }).click();
    await page.getByRole('button', { name: 'Seal my pick' }).click();
    await page.clock.runFor(1500);
    await expect(page.getByText(VOICE.sealed)).toBeVisible();
    expect(world.posted).toHaveLength(1);
  });
});
