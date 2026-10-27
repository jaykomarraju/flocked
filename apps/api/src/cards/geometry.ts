// Per-variant card geometry, as the Paper card artboards declare it (`card__<kind>__<state>__<og|
// embed|square>`, page "Cards and notifications", frozen OA-D4). Every number here is a literal from
// an artboard's styles, so a card is the artboard's layout at the variant's size; the notes band on
// each artboard names the primitives these build with (flex only, no grid, no transforms).
//
// `og` and `embed` lay the result line out as one wrapping row (label then value); `square` stacks it
// (`stackResult`). Sheep sizes are the mascot viewBox (160×140) at 0.875, 1 and 1.25.
import type { CardVariant } from '@flocked/shared';

export interface CardGeometry {
  width: number;
  height: number;
  padBlock: number;
  padInline: number;
  /** Header row: the mode and day label, with the streak pill or sealed badge on the right. */
  headerHeight: number;
  metaSize: number;
  metaLine: number;
  /** The streak pill and the sealed badge (header row height). */
  badgeHeight: number;
  badgePadding: number;
  badgeSize: number;
  badgeLine: number;
  questionSize: number;
  questionLine: number;
  questionMaxWidth: number;
  /** Floor for the stepped-down question size (spec "Card content"). */
  questionMinSize: number;
  /** Split bars: the gap between the two bars, and between a label row and its track. */
  barsGap: number;
  barGap: number;
  labelRowHeight: number;
  labelSize: number;
  labelLine: number;
  pickPillHeight: number;
  pickPillPadding: number;
  pickPillSize: number;
  pickPillLine: number;
  pctSize: number;
  pctLine: number;
  pctWidth: number;
  trackHeight: number;
  /** The count that replaces the bars on refund rules 4, 6, 7 and 8, and its badge gap. */
  countSize: number;
  countLine: number;
  countGap: number;
  /** The teaser's two option outlines: the row's height, its gap and the border radius. */
  optionBoxHeight: number;
  optionBoxRadius: number;
  optionBoxPadding: number;
  optionGap: number;
  /** The teaser's big line (the share text), which wraps to two lines. */
  teaserSize: number;
  teaserLine: number;
  /** Result row: the line (and its value) beside the sheep. */
  resultGap: number;
  resultValueGap: number;
  resultSize: number;
  resultLine: number;
  /** Stakes amounts are longer, so they drop a step to stay on one line (W6-C). */
  resultAmountSize: number;
  /** The "Refunded" title, which the refund artboards set a step smaller than a result line. */
  resultRefundSize: number;
  /** Floor for the stepped-down result line (spec "Card content"). */
  resultMinSize: number;
  stackResult: boolean;
  noteSize: number;
  noteLine: number;
  noteGap: number;
  sheepWidth: number;
  sheepHeight: number;
  /** The five-sheep flock (a 560×180 viewBox) on a loss, which is laid out much wider. */
  flockWidth: number;
  footerHeight: number;
  avatarSize: number;
  avatarLetterSize: number;
  avatarLetterLine: number;
  handleSize: number;
  handleLine: number;
  handleGap: number;
  wordmarkSize: number;
  wordmarkLine: number;
  urlSize: number;
  urlLine: number;
  wordmarkGap: number;
}

export const CARD_GEOMETRY: Readonly<Record<CardVariant, CardGeometry>> = {
  og: {
    width: 1200,
    height: 630,
    padBlock: 52,
    padInline: 64,
    headerHeight: 40,
    metaSize: 22,
    metaLine: 28,
    badgeHeight: 40,
    badgePadding: 18,
    badgeSize: 22,
    badgeLine: 28,
    questionSize: 42,
    questionLine: 48,
    questionMaxWidth: 900,
    questionMinSize: 32,
    barsGap: 16,
    barGap: 8,
    labelRowHeight: 36,
    labelSize: 26,
    labelLine: 34,
    pickPillHeight: 32,
    pickPillPadding: 14,
    pickPillSize: 18,
    pickPillLine: 22,
    pctSize: 30,
    pctLine: 36,
    pctWidth: 120,
    trackHeight: 24,
    countSize: 56,
    countLine: 64,
    countGap: 20,
    optionBoxHeight: 72,
    optionBoxRadius: 16,
    optionBoxPadding: 24,
    optionGap: 16,
    teaserSize: 64,
    teaserLine: 68,
    resultGap: 32,
    resultValueGap: 24,
    resultSize: 88,
    resultLine: 88,
    resultAmountSize: 76,
    resultRefundSize: 72,
    resultMinSize: 56,
    stackResult: false,
    noteSize: 26,
    noteLine: 32,
    noteGap: 8,
    sheepWidth: 140,
    sheepHeight: 122,
    flockWidth: 430,
    footerHeight: 40,
    avatarSize: 40,
    avatarLetterSize: 18,
    avatarLetterLine: 20,
    handleSize: 24,
    handleLine: 32,
    handleGap: 12,
    wordmarkSize: 32,
    wordmarkLine: 36,
    urlSize: 22,
    urlLine: 28,
    wordmarkGap: 14,
  },
  embed: {
    width: 1200,
    height: 800,
    padBlock: 64,
    padInline: 64,
    headerHeight: 44,
    metaSize: 24,
    metaLine: 30,
    badgeHeight: 44,
    badgePadding: 20,
    badgeSize: 24,
    badgeLine: 30,
    questionSize: 48,
    questionLine: 56,
    questionMaxWidth: 1000,
    questionMinSize: 32,
    barsGap: 20,
    barGap: 10,
    labelRowHeight: 40,
    labelSize: 28,
    labelLine: 36,
    pickPillHeight: 36,
    pickPillPadding: 16,
    pickPillSize: 20,
    pickPillLine: 24,
    pctSize: 34,
    pctLine: 40,
    pctWidth: 120,
    trackHeight: 28,
    countSize: 60,
    countLine: 68,
    countGap: 22,
    optionBoxHeight: 80,
    optionBoxRadius: 18,
    optionBoxPadding: 26,
    optionGap: 16,
    teaserSize: 68,
    teaserLine: 72,
    resultGap: 32,
    resultValueGap: 24,
    resultSize: 92,
    resultLine: 92,
    resultAmountSize: 74,
    resultRefundSize: 76,
    resultMinSize: 56,
    stackResult: false,
    noteSize: 28,
    noteLine: 34,
    noteGap: 10,
    sheepWidth: 160,
    sheepHeight: 140,
    flockWidth: 490,
    footerHeight: 44,
    avatarSize: 44,
    avatarLetterSize: 20,
    avatarLetterLine: 22,
    handleSize: 26,
    handleLine: 34,
    handleGap: 12,
    wordmarkSize: 34,
    wordmarkLine: 40,
    urlSize: 24,
    urlLine: 30,
    wordmarkGap: 14,
  },
  square: {
    width: 1080,
    height: 1080,
    padBlock: 72,
    padInline: 72,
    headerHeight: 48,
    metaSize: 26,
    metaLine: 32,
    badgeHeight: 48,
    badgePadding: 20,
    badgeSize: 26,
    badgeLine: 32,
    questionSize: 56,
    questionLine: 64,
    questionMaxWidth: 700,
    questionMinSize: 32,
    barsGap: 24,
    barGap: 12,
    labelRowHeight: 44,
    labelSize: 32,
    labelLine: 40,
    pickPillHeight: 40,
    pickPillPadding: 18,
    pickPillSize: 22,
    pickPillLine: 26,
    pctSize: 38,
    pctLine: 44,
    pctWidth: 120,
    trackHeight: 32,
    countSize: 68,
    countLine: 76,
    countGap: 24,
    optionBoxHeight: 88,
    optionBoxRadius: 20,
    optionBoxPadding: 28,
    optionGap: 16,
    teaserSize: 80,
    teaserLine: 86,
    resultGap: 32,
    resultValueGap: 0,
    resultSize: 112,
    resultLine: 108,
    resultAmountSize: 112,
    resultRefundSize: 92,
    resultMinSize: 56,
    stackResult: true,
    noteSize: 30,
    noteLine: 38,
    noteGap: 12,
    sheepWidth: 200,
    sheepHeight: 175,
    flockWidth: 300,
    footerHeight: 48,
    avatarSize: 48,
    avatarLetterSize: 22,
    avatarLetterLine: 26,
    handleSize: 28,
    handleLine: 36,
    handleGap: 12,
    wordmarkSize: 38,
    wordmarkLine: 44,
    urlSize: 26,
    urlLine: 32,
    wordmarkGap: 14,
  },
};

/** The light theme's tokens (cards are light only: they are images on other apps' feeds). */
export const CARD_COLORS = {
  bg: '#FAF7F2',
  surface: '#FFFFFF',
  ink: '#141414',
  muted: '#6E6E6E',
  line: '#E6E1D8',
  accent: '#FF4F2E',
  accentInk: '#FFFFFF',
} as const;
