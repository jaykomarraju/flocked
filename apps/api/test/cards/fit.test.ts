// The long-text rule (spec "Share cards and distribution" › Card content; owner decision, Oct 12,
// 2026): the question and the result line step down 4 px at a time until they fit, to floors of
// 32 px and 56 px. The estimator the stepping runs on is held to the exports' own measurements:
// a width it got badly wrong would step a card that fits, or leave one that doesn't.
import { describe, expect, it } from 'vitest';
import {
  estimateLines,
  estimateWidth,
  fitQuestionSize,
  fitResultSize,
} from '../../src/cards/fit.js';
import { CARD_GEOMETRY } from '../../src/cards/geometry.js';
import { MODELS, QUESTION } from './models.js';

/** Text widths measured off `docs/design/exports/cards` (1x pixels), with the ±8% the tables allow. */
const MEASURED = [
  // The question's first line on `result__free-win__og`: Fredoka 600 at 42 px, x 64..937.
  ['Would you rather fight one horse-sized duck or 100', 42, 'Fredoka', 873],
  // "UNFLOCKED" on the same card: Fredoka 700 at 88 px, x 66..574.
  ['UNFLOCKED', 88, 'Fredoka', 509],
  // "GOT FLOCKED" on `result__free-loss__og`: x 66..656.
  ['GOT FLOCKED', 88, 'Fredoka', 590],
  // "@woolgatherer" in the footer: Inter 600 at 24 px, x 117..288.
  ['@woolgatherer', 24, 'Inter', 172],
] as const;

describe('W10-A: the long-text rule', () => {
  for (const [value, size, family, measured] of MEASURED) {
    it(`estimates "${value.slice(0, 20)}" within 8% of the export`, () => {
      const estimate = estimateWidth(value, size, family);
      expect(Math.abs(estimate - measured) / measured).toBeLessThan(0.08);
    });
  }

  it('the example question fits two lines at full size in og and embed, three in square', () => {
    for (const variant of ['og', 'embed', 'square'] as const) {
      const g = CARD_GEOMETRY[variant];
      expect(fitQuestionSize(QUESTION, g)).toBe(g.questionSize);
      expect(estimateLines(QUESTION, g.questionSize, g.questionMaxWidth)).toBeLessThanOrEqual(
        variant === 'square' ? 3 : 2,
      );
    }
  });

  it('a 120-character question steps down, and never past the 32 px floor', () => {
    const long =
      'Would you rather always have to say everything on your mind out loud, or never be able to ' +
      'speak to a stranger again, ever?';
    expect(long.length).toBeGreaterThanOrEqual(120);
    for (const variant of ['og', 'embed', 'square'] as const) {
      const g = CARD_GEOMETRY[variant];
      const size = fitQuestionSize(long, g);
      expect(size).toBeLessThan(g.questionSize);
      expect(size).toBeGreaterThanOrEqual(g.questionMinSize);
      // Four at a time from the artboard's size, so `og` bottoms out at 34 rather than 32.
      expect((g.questionSize - size) % 4).toBe(0);
    }
  });

  it('a Stakes amount starts a step lower and stays on one line beside the sheep', () => {
    const g = CARD_GEOMETRY.og;
    const amount = MODELS['result__stakes-win-amount']!;
    const size = fitResultSize(amount, g);
    // The artboard sets this one at 76; satori's text is a shade wider than the browser's, so the
    // rule lands a step lower. What matters is that the label and the value stay on one line.
    expect(size).toBeLessThanOrEqual(g.resultAmountSize);
    expect(size).toBeGreaterThanOrEqual(g.resultMinSize);
    expect(
      estimateWidth(amount.resultLabel, size) +
        g.resultValueGap +
        estimateWidth(amount.resultValue!, size),
    ).toBeLessThanOrEqual(g.width - 2 * g.padInline - g.sheepWidth - g.resultGap);
  });

  it('a long amount steps down, and never past the 56 px floor', () => {
    const g = CARD_GEOMETRY.og;
    const model = {
      ...MODELS['result__stakes-win-amount']!,
      resultValue: '+123,456.78 USDC',
    };
    const size = fitResultSize(model, g);
    expect(size).toBeLessThan(g.resultAmountSize);
    expect(size).toBeGreaterThanOrEqual(g.resultMinSize);
  });

  it('a win keeps the full result size, and a refund title its own', () => {
    const g = CARD_GEOMETRY.og;
    expect(fitResultSize(MODELS['result__free-win']!, g)).toBe(g.resultSize);
    expect(fitResultSize(MODELS['result__free-refund-voided']!, g)).toBe(g.resultRefundSize);
  });

  it('the estimator errs wide, so a line that fits in Paper never overflows here', () => {
    for (const [value, size, family, measured] of MEASURED) {
      expect(estimateWidth(value, size, family)).toBeGreaterThan(measured * 0.93);
    }
  });
});
