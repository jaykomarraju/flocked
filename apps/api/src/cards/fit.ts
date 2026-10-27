// Long questions and amounts (spec "Share cards and distribution" › Card content; owner decision,
// Oct 12, 2026): the question and the result line each step down 4 px at a time until they fit, to
// floors of 32 px and 56 px.
//
// Deciding that needs text widths, and satori reports none: it lays out and returns an SVG. Rendering
// to find out would cost a render per step, and a daily round renders three cards per settled player
// inside five minutes, so the fit is estimated from per-character advance widths instead. The tables
// are averages of the two families at the weights the cards use, measured off the Paper exports
// (`docs/design/exports/cards`), and they deliberately run a few percent wide: satori's own text is
// a little wider than the browser's that drew the artboards, so a line that just fits in Paper can
// overflow here, and the estimate has to err towards stepping down rather than towards a clipped
// card. test/cards/fit.test.ts holds the tables to the exports' own measurements.
import type { CardGeometry } from './geometry.js';
import type { CardModel } from './model.js';

const NARROW = new Set('ijltfr!|.,:;\'"`()[]{}/\\-');
const WIDE = new Set('mwMW@%');
const DIGIT = new Set('0123456789+');

/** Average advance in em, by character class. */
const ADVANCE = {
  Fredoka: { narrow: 0.3, wide: 0.86, upper: 0.66, other: 0.53, digit: 0.56, space: 0.26 },
  Inter: { narrow: 0.3, wide: 0.86, upper: 0.66, other: 0.57, digit: 0.6, space: 0.26 },
} as const;

/** The estimated width of `value` at `size`, in px. */
export function estimateWidth(
  value: string,
  size: number,
  family: 'Fredoka' | 'Inter' = 'Fredoka',
): number {
  const a = ADVANCE[family];
  let em = 0;
  for (const ch of value) {
    if (ch === ' ') em += a.space;
    else if (DIGIT.has(ch)) em += a.digit;
    else if (NARROW.has(ch)) em += a.narrow;
    else if (WIDE.has(ch)) em += a.wide;
    else if (ch >= 'A' && ch <= 'Z') em += a.upper;
    else em += a.other;
  }
  return em * size;
}

/** How many lines `value` takes in `width`, breaking on spaces as satori does. */
export function estimateLines(
  value: string,
  size: number,
  width: number,
  family: 'Fredoka' | 'Inter' = 'Fredoka',
): number {
  let lines = 1;
  let used = 0;
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const w = estimateWidth(word, size, family);
    const withSpace = used === 0 ? w : used + estimateWidth(' ', size, family) + w;
    if (used > 0 && withSpace > width) {
      lines++;
      used = w;
    } else {
      used = withSpace;
    }
  }
  return lines;
}

/** The question fits on two lines in `og` and `embed`, three in `square` (W6-Z carry-over). */
export function questionMaxLines(g: CardGeometry): number {
  return g.stackResult ? 3 : 2;
}

/** The question's size: `questionSize`, stepped down 4 px at a time to the 32 px floor. */
export function fitQuestionSize(question: string, g: CardGeometry): number {
  const max = questionMaxLines(g);
  let size = g.questionSize;
  // Four at a time, never past the floor: from `og`'s 42 that bottoms out at 34, from the other
  // two at 32 exactly.
  while (size - 4 >= g.questionMinSize && estimateLines(question, size, g.questionMaxWidth) > max) {
    size -= 4;
  }
  return size;
}

/**
 * The result line's size: `resultSize` (a Stakes amount or multiple starts a step lower), stepped
 * down 4 px at a time to the 56 px floor, so the label and its value stay on one line beside the
 * sheep. `square` stacks them, so each one only has to fit on its own.
 */
export function fitResultSize(m: CardModel, g: CardGeometry): number {
  const art = m.pose === 'flock' ? g.flockWidth : g.sheepWidth;
  const available = g.width - 2 * g.padInline - art - g.resultGap;
  const label = m.kind === 'teaser' ? '' : m.resultLabel;
  let size =
    m.note !== null ? g.resultRefundSize : m.resultIsAmount ? g.resultAmountSize : g.resultSize;
  const needed = (at: number) => {
    const l = estimateWidth(label, at);
    const v = m.resultValue === null ? 0 : estimateWidth(m.resultValue, at);
    if (g.stackResult) return Math.max(l, v);
    return v === 0 ? l : l + g.resultValueGap + v;
  };
  while (size - 4 >= g.resultMinSize && needed(size) > available) size -= 4;
  return size;
}
