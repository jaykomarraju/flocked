// Onboarding (W8-C; spec "Client app" › Onboarding): the three cards at mobile, tablet and desktop
// against their Paper exports (tagged @screenshot: they run in the macOS screenshot job), then the
// real modal on a signed-out first visit: card 1 on its own, keyboard paging, "Sign in to play"
// opening sign-in, not again after a reload, and axe on every card. The live tests stub the two API
// reads the shell makes, so they pass against a dev server or `vite preview` as well as the stack.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures';
import { expectArtboard } from '../fixtures/screenshot';

test.describe('onboarding cards match Paper', () => {
  for (const card of ['card-1', 'card-2', 'card-3'] as const) {
    for (const breakpoint of ['mobile', 'tablet', 'desktop'] as const) {
      const artboard = `core/onboarding/${card}/${breakpoint}`;
      test(artboard, { tag: '@screenshot' }, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

/** A signed-out visitor with no round today: `GET /me` answers 401, `GET /rounds/today` no round. */
async function stubSignedOut(page: Page): Promise<void> {
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in' } }),
    }),
  );
  await page.route('**/api/v1/rounds/today', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ round: null, previousRoundId: null, crowdHint: null }),
    }),
  );
}

/**
 * No serious or critical axe violations on the page as it is. The page runs with reduced motion, so
 * no dialog is still fading in (half-transparent) when axe measures contrast.
 */
async function expectNoSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
  ).toEqual([]);
}

test.describe('onboarding on a first visit', () => {
  test('pages by keyboard, opens sign-in and stays closed after a reload', async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubSignedOut(page);
    await page.goto('/');

    const dialog = page.getByRole('dialog', { name: 'Pick the side fewer people pick' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('1 of 3')).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.keyboard.press('ArrowRight');
    await expect(
      page.getByRole('dialog', { name: 'Picks stay sealed until just after 9pm ET' }),
    ).toBeVisible();
    await expect(page.getByText('2 of 3')).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.keyboard.press('ArrowLeft');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const last = page.getByRole('dialog', { name: 'The Flock loses. Strays win.' });
    await expect(last).toBeVisible();
    await expect(page.getByText('3 of 3')).toBeVisible();
    await expectNoSeriousViolations(page);

    await last.getByRole('button', { name: 'Sign in to play' }).click();
    await expect(last).toBeHidden();
    // The sign-in dialog (its own spec covers what's in it).
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.reload();
    await expect(page.getByText('No question yet. The sheep are deliberating.')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Pick the side fewer people pick' })).toHaveCount(
      0,
    );
  });

  test('closing it any other way also ends it', async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 850 });
    await stubSignedOut(page);
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Pick the side fewer people pick' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(page.getByText('No question yet. The sheep are deliberating.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
