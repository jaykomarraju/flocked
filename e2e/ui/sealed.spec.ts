// Sealed (W9-C; spec "Client app" › Sealed; "Sealed picks" › Client requirements): the Sealed artboards
// against their Paper exports, and Sealed in the browser (world.ts): the pick this device stored, or
// "Pick not on this device" when only the server knows the entry, each with axe.
import { VOICE } from '@flocked/shared';
import { expect, test } from '../fixtures';
import { expectArtboard } from '../fixtures/screenshot';
import { QUESTION, expectAccessible, mockWorld } from './world';

const SEALED_STATES = ['pick-known', 'pick-lost'] as const;
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

test.describe('Sealed sheets match Paper', () => {
  for (const state of SEALED_STATES) {
    for (const breakpoint of BREAKPOINTS) {
      const artboard = `core/sealed/${state}/${breakpoint}`;
      test(artboard, { tag: '@screenshot' }, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

test.describe('Sealed in the browser', () => {
  test('the stored pick, the stake and the reveal countdown, with axe', async ({ page }) => {
    await mockWorld(page, { storedPick: 1 });
    await page.goto('/');
    await expect(page.getByText(VOICE.sealed)).toBeVisible();
    await expect(page.getByText(QUESTION.options[1], { exact: true }).first()).toBeVisible();
    await expect(page.getByText('25 points')).toBeVisible();
    await expect(page.getByRole('timer', { name: 'Reveal in' })).toContainText('01:02:0');
    await expectAccessible(page);
  });

  test('"Pick not on this device" when this device lost the pick, with axe', async ({ page }) => {
    const world = await mockWorld(page);
    world.myEntry = { stake: '25', optionIndex: null };
    await page.goto('/');
    await expect(page.getByText('Pick not on this device')).toBeVisible();
    await expect(
      page.getByText(
        "Your pick is sealed, but this device doesn't remember it. It shows up at the reveal.",
      ),
    ).toBeVisible();
    await expectAccessible(page);
  });
});
