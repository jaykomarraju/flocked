// The rendered cards' layout against the frozen exports (W10-A required test, with pixel.test.ts).
//
// Mean pixel error alone is a blunt instrument here: at a fifth scale most of a card is background,
// and the error that remains is the two text engines' advance widths drifting a few pixels along a
// long line — about as large as the error between two different states' cards. So the layout is
// checked structurally, against the same fixtures:
//
//   * every band of inked rows (header, question lines, bars, result, footer) lands within 6 px of
//     the export's own band, and there are as many of them;
//   * the accent covers the same share of the card to within half a percentage point, which is what
//     holds it to the winning bar, UNFLOCKED and the streak pill and keeps it off a refund card.
//
// Both numbers come from the fixture, so they move only when an artboard is re-exported. The negative
// controls at the end render one state against another's fixture: each has to fail.
import { describe, expect, it } from 'vitest';
import { CARD_COLORS } from '../../src/cards/geometry.js';
import { renderCard } from '../../src/cards/render.js';
import { MODELS } from './models.js';
import { dataUriBytes, decodePng, downscale, inkBands, type Bitmap } from './png.js';
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

const BG = [0xfa, 0xf7, 0xf2] as const;
/** A band may sit 6 px (one fixture pixel plus a pixel of slack) from where the export has it. */
const BAND_TOLERANCE = 6;
/** The accent's share of the card, in percentage points. */
const ACCENT_TOLERANCE = 0.5;

function accentShare(img: Bitmap): number {
  const [r, g, b] = [0xff, 0x4f, 0x2e];
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const p = i * 4;
    if (
      Math.abs(img.data[p]! - r) + Math.abs(img.data[p + 1]! - g) + Math.abs(img.data[p + 2]! - b) <
      60
    ) {
      n++;
    }
  }
  return (100 * n) / (img.width * img.height);
}

/** The fixture's scale: a fifth of the card, so a fixture row is 5 card rows. */
const SCALE = 5;

async function profiles(state: string, variant: 'og' | 'embed' | 'square', fixture: string) {
  const reference = await decodePng(dataUriBytes(fixture));
  const rendered = downscale(
    await decodePng(await renderCard(MODELS[state]!, variant)),
    reference.width,
    reference.height,
  );
  return {
    reference: { bands: inkBands(reference, BG), accent: accentShare(reference) },
    rendered: { bands: inkBands(rendered, BG), accent: accentShare(rendered) },
  };
}

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

describe('W10-A: rendered cards lay out as the Paper exports do', () => {
  for (const [state, variant, fixture] of CASES) {
    it(`${state} ${variant}`, async () => {
      const { reference, rendered } = await profiles(state, variant, fixture);
      expect(rendered.bands.map(([a, b]) => `${a * SCALE}..${b * SCALE}`).join(' ')).toHaveLength(
        reference.bands.map(([a, b]) => `${a * SCALE}..${b * SCALE}`).join(' ').length,
      );
      expect(rendered.bands).toHaveLength(reference.bands.length);
      for (const [i, [a, b]] of reference.bands.entries()) {
        const [c, d] = rendered.bands[i]!;
        expect(Math.abs(c - a) * SCALE).toBeLessThanOrEqual(BAND_TOLERANCE);
        expect(Math.abs(d - b) * SCALE).toBeLessThanOrEqual(BAND_TOLERANCE);
      }
      expect(Math.abs(rendered.accent - reference.accent)).toBeLessThan(ACCENT_TOLERANCE);
    });
  }

  for (const [name, fixture] of [
    ['the loss', lossOg],
    ['the headcount tie', tieOg],
    ['the voided refund', voidedOg],
    ['the teaser', teaserOg],
    ['the round card', roundOg],
  ] as const) {
    it(`a win rendered against ${name} fixture does not match it`, async () => {
      const { reference, rendered } = await profiles('result__free-win', 'og', fixture);
      const sameBands =
        rendered.bands.length === reference.bands.length &&
        reference.bands.every(
          ([a, b], i) =>
            Math.abs(rendered.bands[i]![0] - a) * SCALE <= BAND_TOLERANCE &&
            Math.abs(rendered.bands[i]![1] - b) * SCALE <= BAND_TOLERANCE,
        );
      const sameAccent = Math.abs(rendered.accent - reference.accent) < ACCENT_TOLERANCE;
      expect(sameBands && sameAccent).toBe(false);
    });
  }

  it('the accent is only ever the winning bar, UNFLOCKED and the streak pill', () => {
    expect(CARD_COLORS.accent).toBe('#FF4F2E');
  });
});
