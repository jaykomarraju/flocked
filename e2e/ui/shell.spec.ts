// The web shell (W8-C; wave-8.md "W8-C"): every component sheet and the mascot sheet, light and dark,
// against their Paper exports (fixtures/screenshot.ts), then the app's own screens with axe.
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
      test(artboard, async ({ page }) => {
        await expectArtboard(page, artboard);
      });
    }
  }
});

test.describe('mascot placeholders match Paper', () => {
  for (const theme of ['light', 'dark'] as const) {
    const artboard = `foundations/mascot/${theme}/desktop`;
    test(artboard, async ({ page }) => {
      await expectArtboard(page, artboard);
    });
  }
});
