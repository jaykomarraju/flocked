// Today (W9-C; spec "Client app" › Today, Entry flow (Free)): the Today artboards against their Paper
// exports, the entry flow's refusals and receipt checks in the browser (world.ts), axe on Today, and a
// Free pick sealed in the browser on the stack.
import { randomInt } from 'node:crypto';
import { VOICE } from '@flocked/shared';
import { expect, test } from '../fixtures';
import { pageRoundMe, preparePage, signInByCookie } from '../fixtures/browser';
import { enterFree, scheduleRound, waitRound } from '../fixtures/rounds';
import { expectArtboard } from '../fixtures/screenshot';
import { QUESTION, expectAccessible, mockWorld, readStoredPick } from './world';

const TODAY_STATES = ['open-signed-out', 'open-free', 'sealing', 'dst-notice'] as const;
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

test.describe('Today sheets match Paper', () => {
  for (const state of TODAY_STATES) {
    for (const breakpoint of BREAKPOINTS) {
      const artboard = `core/today/${state}/${breakpoint}`;
      test(artboard, { tag: '@screenshot' }, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

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

// --- On the stack ------------------------------------------------------------------------------

test.describe('a Free round in the browser on the stack', () => {
  test('sign in, seal a pick, Sealed, then the reveal (the Worker opens the browser ciphertext)', async ({
    page,
    stack,
    user,
  }) => {
    test.setTimeout(6 * 60_000);
    const prompt = `Browser round ${randomInt(1e9)}: cats or dogs?`;
    const scheduled = await scheduleRound(stack, { openForMs: 75_000, beaconDelay: 60, prompt });
    const round = await waitRound(
      stack,
      scheduled.roundId,
      'the round to open',
      90_000,
      (r) => r.status === 'open' && r.lockedAt !== null,
    );
    // Two players on option 1 through the API, so the browser's option 0 is the smaller side.
    for (const pick of [1, 1] as const) await enterFree(stack, await user(), round, pick, 10n);

    // The browser: its own IP, the stack's chain and drand, Turnstile stubbed, signed in by cookie.
    await preparePage(page, stack);
    await signInByCookie(page, stack);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: prompt })).toBeVisible();
    await page.getByRole('radio').first().click();
    await page.getByRole('button', { name: 'Seal my pick' }).click();
    await expect(page.getByText(VOICE.sealed)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expectAccessible(page);
    const mine = await pageRoundMe(page, round.id);
    expect(mine.modes.free?.entry.stake).toBe('25');

    // Close, the beacon, the reveal: the stack's Worker decrypts the browser's ciphertext.
    await expect(page.getByRole('timer', { name: 'Unsealing in' })).toBeVisible({
      timeout: 120_000,
    });
    await expectAccessible(page);
    await expect(page.locator('[data-phase="revealed"]')).toBeVisible({ timeout: 180_000 });
    await expect(
      page.getByText('Unflocked. You and 33% of people out-thought everyone.'),
    ).toBeVisible({ timeout: 15_000 });
    await expectAccessible(page);
  });
});
