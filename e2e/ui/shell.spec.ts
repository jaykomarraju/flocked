// The web shell (W8-C; wave-8.md "W8-C"): every component sheet and the mascot sheet, light and dark,
// against their Paper exports (fixtures/screenshot.ts; tagged @screenshot: they run in the macOS
// screenshot job), then the app's own screens with axe.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures';
import { expectArtboard } from '../fixtures/screenshot';

/** The Components page's sheets (docs/design/screens.md "Components"), in its order. */
const COMPONENT_SHEETS = [
  'option-card',
  'actions',
  'stake-selector',
  'round-status',
  'result-card',
  'feedback',
  'lists',
  'forms-overlays',
  'navigation',
] as const;

test.describe('component sheets match Paper', () => {
  for (const sheet of COMPONENT_SHEETS) {
    for (const theme of ['light', 'dark'] as const) {
      const artboard = `components/${sheet}/${theme}/desktop`;
      test(artboard, { tag: '@screenshot' }, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

test.describe('mascot placeholders match Paper', () => {
  for (const theme of ['light', 'dark'] as const) {
    const artboard = `foundations/mascot/${theme}/desktop`;
    test(artboard, { tag: '@screenshot' }, async ({ page }) => {
      await expectArtboard(page, artboard);
    });
  }
});

// The shell's screens, signed out, at mobile and desktop widths: each tab and a You page, the active
// tab, the You sheet (mobile), and axe on each. The two API reads are stubbed (signed out, no round
// today), so this runs against a dev server or `vite preview` as well as the stack, and onboarding is
// marked as seen (onboarding.spec.ts covers it).
test.describe('shell screens', () => {
  const SCREENS = [
    { path: '/', tab: 'Today' },
    { path: '/archive', tab: 'Archive' },
    { path: '/leaderboards', tab: 'Boards' },
    { path: '/rooms', tab: 'Rooms' },
    { path: '/claims', tab: 'You' },
  ] as const;

  async function signedOutVisitor(page: Page): Promise<void> {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => localStorage.setItem('flocked.onboarded', '1'));
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

  /** No serious or critical axe violations (with reduced motion: no sheet still sliding in). */
  async function expectNoSeriousViolations(page: Page): Promise<void> {
    const { violations } = await new AxeBuilder({ page }).analyze();
    const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(
      serious.map(
        (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
      ),
    ).toEqual([]);
  }

  for (const { path, tab } of SCREENS) {
    test(`mobile ${path}`, async ({ page }) => {
      await page.setViewportSize({ width: 380, height: 844 });
      await signedOutVisitor(page);
      await page.goto(path);
      const nav = page.getByRole('navigation', { name: 'Main' });
      const current = nav.locator('[aria-current="page"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveText(tab);
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await expectNoSeriousViolations(page);

      await nav.getByRole('button', { name: 'You' }).click();
      const sheet = page.getByRole('dialog', { name: 'You' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('link', { name: 'Claims' })).toBeVisible();
      await expectNoSeriousViolations(page);
      await sheet.getByRole('button', { name: 'Not now' }).click();
      await expect(sheet).toBeHidden();
    });

    test(`desktop ${path}`, async ({ page }) => {
      await page.setViewportSize({ width: 1120, height: 850 });
      await signedOutVisitor(page);
      await page.goto(path);
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link')).toHaveCount(4);
      const current = nav.locator('[aria-current="page"]');
      // The You pages show no active link from tablet up.
      if (tab === 'You') await expect(current).toHaveCount(0);
      else await expect(current).toHaveText(tab);
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await expectNoSeriousViolations(page);
    });
  }
});
