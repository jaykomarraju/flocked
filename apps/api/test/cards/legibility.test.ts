// The 25% legibility check (W10-A required test; Design_Language "Share cards": "The result line must
// be legible at 25% scale", and each card artboard's notes band records the same check by eye).
//
// Method. Render the card, box-filter it to a quarter of its size (300×158 for `og`, 300×200 for
// `embed`, 270×270 for `square` — the sizes the artboards' notes bands name), then take the result
// line's own band: the tallest band of inked rows, cropped to the left 70% of the card so the sheep
// stays out of it. Two numbers come out of that region:
//
//   * coverage — the share of pixels that are inked rather than background. Under the floor the line
//     has dissolved into the ground at this scale; over the ceiling it has become a solid blob.
//   * contrast — the WCAG 2.1 ratio between the mean of the darkest fifth of the region's pixels and
//     the card's background. It holds the line to 4.5:1 in ink, and to 2.5:1 in the accent, whose own
//     ratio on `bg` is 3.1:1 before the downscale blends its edges (screens.md "Contrast").
import { describe, expect, it } from 'vitest';
import { CARD_GEOMETRY } from '../../src/cards/geometry.js';
import { renderCard } from '../../src/cards/render.js';
import { MODELS } from './models.js';
import { contrastRatio, decodePng, downscale, inkBands, luminance } from './png.js';

const BG = [0xfa, 0xf7, 0xf2] as const;
/** The background's own relative luminance, the other side of every contrast ratio here. */
const BG_LUMINANCE = 0.9226;

async function check(state: string, variant: 'og' | 'embed' | 'square') {
  const g = CARD_GEOMETRY[variant];
  const full = await decodePng(await renderCard(MODELS[state]!, variant));
  const small = downscale(full, Math.round(g.width / 4), Math.round(g.height / 4));
  const bands = inkBands(small, BG);
  const [y0, y1] = bands.reduce((m, b) => (b[1] - b[0] > m[1] - m[0] ? b : m), bands[0]!);
  const right = Math.round(small.width * 0.7);
  const lums: number[] = [];
  let inked = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < right; x++) {
      const i = (y * small.width + x) * 4;
      lums.push(luminance(small, i));
      if (
        Math.abs(small.data[i]! - BG[0]) +
          Math.abs(small.data[i + 1]! - BG[1]) +
          Math.abs(small.data[i + 2]! - BG[2]) >
        48
      ) {
        inked++;
      }
    }
  }
  lums.sort((a, b) => a - b);
  const darkest = lums.slice(0, Math.max(1, Math.round(lums.length / 5)));
  const mean = darkest.reduce((s, v) => s + v, 0) / darkest.length;
  return {
    size: `${small.width}×${small.height}`,
    band: `${y0}..${y1}`,
    coverage: inked / lums.length,
    contrast: contrastRatio(mean, BG_LUMINANCE),
  };
}

const CASES = [
  ['result__free-win', 'og', 2.5],
  ['result__free-win', 'square', 2.5],
  ['result__free-loss', 'og', 4.5],
  ['result__free-refund-voided', 'og', 4.5],
  ['teaser__sealed', 'og', 4.5],
] as const;

describe('W10-A: the result line is legible at 25%', () => {
  for (const [state, variant, minContrast] of CASES) {
    it(`${state} ${variant}`, async () => {
      const r = await check(state, variant);
      console.log(
        `${state} ${variant} ${r.size} band ${r.band}: coverage ${(r.coverage * 100).toFixed(1)}% contrast ${r.contrast.toFixed(2)}`,
      );
      expect(r.coverage).toBeGreaterThan(0.05);
      expect(r.coverage).toBeLessThan(0.5);
      expect(r.contrast).toBeGreaterThan(minContrast);
    });
  }
});
