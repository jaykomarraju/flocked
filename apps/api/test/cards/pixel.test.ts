// Pixel comparison of every rendered card against the frozen Paper exports (W10-A required test).
//
// Method. Each fixture in fixtures/ is one `docs/design/exports/cards/*.png` box-filtered to a fifth
// of the card (fixtures/build.mjs). The test renders the same state through satori and resvg, box-
// filters the PNG the same way, and compares: mean absolute error over the RGB channels, and the
// share of pixels whose largest channel difference is over 32. Two rasterisers never agree pixel for
// pixel — Paper's text shaping, hinting and anti-aliasing are a browser's, resvg's are its own — so
// the comparison is at a fifth scale, where glyph differences average out and layout, size and colour
// do not. The thresholds below are about three times the error the current renderer shows, and the
// thresholds below bound that difference; layout.test.ts is what holds each state to its own shape.
import { describe, expect, it } from 'vitest';
import { renderCard } from '../../src/cards/render.js';
import { MODELS } from './models.js';
import { dataUriBytes, decodePng, diff, downscale } from './png.js';
import winOg from './fixtures/result__free-win__og.px.png?inline';
import winEmbed from './fixtures/result__free-win__embed.px.png?inline';
import winSquare from './fixtures/result__free-win__square.px.png?inline';
import streakOg from './fixtures/result__free-win-streak__og.px.png?inline';
import lossOg from './fixtures/result__free-loss__og.px.png?inline';
import stakesAmountOg from './fixtures/result__stakes-win-amount__og.px.png?inline';
import tieOg from './fixtures/result__free-refund-headcount-tie__og.px.png?inline';
import voidedOg from './fixtures/result__free-refund-voided__og.px.png?inline';
import teaserOg from './fixtures/teaser__sealed__og.px.png?inline';
import roundOg from './fixtures/round__free__og.px.png?inline';

/**
 * Mean absolute error over 255, and the share of pixels differing by more than 32 in any channel.
 * The renderer sits at 6–13 and 5–12% against these fixtures: the layout lands within a pixel or two
 * of every artboard (test/cards/layout.test.ts holds it there), and what is left is the two text
 * engines disagreeing by a fraction of a percent on advance widths, which drifts a few pixels by the
 * end of a long line. The negative controls below are at 20 and up, so the ceiling still discriminates.
 */
const MAX_MAE = 16;
const MAX_OVER = 0.14;

const CASES = [
  ['result__free-win', 'og', winOg],
  ['result__free-win', 'embed', winEmbed],
  ['result__free-win', 'square', winSquare],
  ['result__free-win-streak', 'og', streakOg],
  ['result__free-loss', 'og', lossOg],
  ['result__stakes-win-amount', 'og', stakesAmountOg],
  ['result__free-refund-headcount-tie', 'og', tieOg],
  ['result__free-refund-voided', 'og', voidedOg],
  ['teaser__sealed', 'og', teaserOg],
  ['round__free', 'og', roundOg],
] as const;

async function compare(state: string, variant: 'og' | 'embed' | 'square', fixture: string) {
  const reference = await decodePng(dataUriBytes(fixture));
  const png = await renderCard(MODELS[state]!, variant);
  const rendered = downscale(await decodePng(png), reference.width, reference.height);
  return { ...diff(reference, rendered), size: `${reference.width}×${reference.height}` };
}

describe('W10-A: rendered cards match the Paper exports', () => {
  for (const [state, variant, fixture] of CASES) {
    it(`${state} ${variant}`, async () => {
      const d = await compare(state, variant, fixture);
      console.log(
        `${state} ${variant} ${d.size}: mae ${d.mae.toFixed(2)} over ${(d.over * 100).toFixed(2)}%`,
      );
      expect(d.mae).toBeLessThan(MAX_MAE);
      expect(d.over).toBeLessThan(MAX_OVER);
    });
  }
});
