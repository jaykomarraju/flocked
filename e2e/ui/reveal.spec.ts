// Reveal (W9-C; spec "Real-time and the reveal" › Reveal choreography; Design_Language.md "Motion"):
// the Reveal artboards against their Paper exports, and the reveal in the browser (world.ts): unsealing
// in m:ss, "Counting the flock…", the 3 s bars once per round on this device, and reduced motion
// skipping to the end state with a fade (NFR-9), each with axe.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { expectArtboard } from '../fixtures/screenshot';
import { expectAccessible, mockWorld, setPageTime, type World } from './world';

/** The Reveal artboard rows the sheet draws (apps/web/src/sheets/core/reveal.sheet.tsx). */
const REVEAL_STATES = [
  'unsealing',
  'counting',
  'win',
  'loss',
  'refund',
  'mode-toggle',
  'next-live',
];
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

test.describe('Reveal sheets match Paper', () => {
  for (const state of REVEAL_STATES) {
    for (const breakpoint of BREAKPOINTS) {
      const artboard = `core/reveal/${state}/${breakpoint}`;
      test(artboard, { tag: '@screenshot' }, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

const TALLY = [
  { headcount: 62, total: '1550' },
  { headcount: 38, total: '950' },
];

/** Sealed, then close (`closed`), then the beacon, then `revealed`. */
async function toCounting(page: Page, world: World) {
  await page.goto('/');
  await expect(page.getByRole('timer', { name: 'Reveal in' })).toBeVisible();
  const r = world.round;
  await setPageTime(page, world, r.closesAt + 18);
  await world.push({
    type: 'closed',
    roundId: r.id,
    closesAt: r.closesAt,
    beaconRound: r.beaconRound,
    beaconTime: r.beaconTime,
  });
  const timer = page.getByRole('timer', { name: 'Unsealing in' });
  await expect(timer).toHaveText(/1:4\d/);
  await expect(page.getByText('Your pick')).toBeVisible();
  await expectAccessible(page);
  await setPageTime(page, world, r.beaconTime + 1);
  await expect(page.getByText('Counting the flock…')).toBeVisible();
  await expectAccessible(page);
}

const revealed = (world: World) => ({
  type: 'revealed',
  roundId: world.round.id,
  mode: 'free',
  winningOption: 1,
  tally: TALLY,
});

test.describe('the reveal in the browser', () => {
  test('reduced motion: the end state at once, with a fade, no 3 s growth (NFR-9)', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const world = await mockWorld(page, { storedPick: 1 });
    await toCounting(page, world);
    await world.push(revealed(world));
    const reveal = page.locator('[data-phase="revealed"]');
    await expect(reveal).toHaveAttribute('data-reveal-stage', 'done');
    await expect(reveal).toHaveAttribute('data-motion', 'fade');
    await expect(
      page.getByText('Unflocked. You and 38% of people out-thought everyone.'),
    ).toBeVisible();
    // The bars are at their shares already: the winning fill is 38% of its track, not 50%.
    const fill = reveal
      .getByRole('list', { name: 'How the crowd split' })
      .locator('[data-winner="true"]');
    const [track, box] = await Promise.all([fill.locator('..').boundingBox(), fill.boundingBox()]);
    expect(box!.width / track!.width).toBeCloseTo(0.38, 1);
    await expectAccessible(page);
  });

  test('the bars grow over 3 s the first time, and not again on this device', async ({ page }) => {
    const world = await mockWorld(page, { storedPick: 1 });
    await toCounting(page, world);
    await world.push(revealed(world));
    const reveal = page.locator('[data-phase="revealed"]');
    await expect(reveal).toHaveAttribute('data-motion', 'full');
    await expect(reveal).toHaveAttribute('data-reveal-stage', 'grow');
    await expect(page.getByText(/Unflocked\. You and/)).toHaveCount(0);
    await page.clock.runFor(3500);
    await expect(reveal).toHaveAttribute('data-reveal-stage', 'done');
    await expect(
      page.getByText('Unflocked. You and 38% of people out-thought everyone.'),
    ).toBeVisible();
    await expectAccessible(page);

    world.onConnect = [world.state({ status: 'closed' }), revealed(world)];
    await page.reload();
    await expect(reveal).toHaveAttribute('data-reveal-stage', 'done');
    await expect(reveal).toHaveAttribute('data-motion', 'none');
  });
});
