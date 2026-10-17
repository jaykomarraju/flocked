// The card models the Paper artboards draw, with the example values the design uses (screens.md
// "Cards decisions": the Core flow question, 62/38, @woolgatherer, Oct 12, 1,204 Free players and
// 212–214 Stakes). The pixel test renders these and compares them with the exports, so each one
// matches its artboard's state exactly.
import {
  CARD_GOT_FLOCKED,
  CARD_REFUNDED_TITLE,
  CARD_TEASER_LINE,
  CARD_UNFLOCKED,
  cardRefundLine,
  playersLabel,
  roundLine,
  type CardModel,
} from '../../src/cards/model.js';

export const QUESTION = 'Would you rather fight one horse-sized duck or 100 duck-sized horses?';
const A = 'One horse-sized duck';
const B = '100 duck-sized horses';

/** The 62/38 split: option B is the minority that strayed and won. */
function split(picked: 0 | 1 | null, winner: 0 | 1 | null = 1) {
  return [
    { label: A, pct: '62%', fill: 62, winner: winner === 0, picked: picked === 0 },
    { label: B, pct: '38%', fill: 38, winner: winner === 1, picked: picked === 1 },
  ] as const;
}

const base = {
  kind: 'result' as const,
  meta: 'Free · Oct 12',
  question: QUESTION,
  bars: true,
  outlines: false,
  count: null,
  sealed: false,
  streak: null,
  resultValue: null,
  resultAccent: false,
  resultIsAmount: false,
  note: null,
  handle: 'woolgatherer',
};

export const MODELS: Readonly<Record<string, CardModel>> = {
  'result__free-win': {
    ...base,
    options: split(1),
    resultLabel: CARD_UNFLOCKED,
    resultValue: '+86 pts',
    resultAccent: true,
    pose: 'smug',
  },
  'result__free-win-streak': {
    ...base,
    options: split(1),
    streak: 3,
    resultLabel: CARD_UNFLOCKED,
    resultValue: '+86 pts',
    resultAccent: true,
    pose: 'smug',
  },
  'result__free-loss': {
    ...base,
    options: split(0),
    resultLabel: CARD_GOT_FLOCKED,
    pose: 'flock',
  },
  'result__stakes-win-amount': {
    ...base,
    meta: 'Stakes · Oct 12',
    options: split(1),
    resultLabel: CARD_UNFLOCKED,
    resultValue: '+16.00 USDC',
    resultAccent: true,
    resultIsAmount: true,
    pose: 'smug',
  },
  'result__stakes-win-multiple': {
    ...base,
    meta: 'Stakes · Oct 12',
    options: split(1),
    resultLabel: CARD_UNFLOCKED,
    resultValue: '2.6x',
    resultAccent: true,
    resultIsAmount: true,
    pose: 'smug',
  },
  'result__free-refund-headcount-tie': {
    ...base,
    options: [
      { label: A, pct: '50%', fill: 50, winner: false, picked: false },
      { label: B, pct: '50%', fill: 50, winner: false, picked: true },
    ],
    resultLabel: CARD_REFUNDED_TITLE,
    note: cardRefundLine(3),
    pose: 'neutral',
  },
  'result__free-refund-voided': {
    ...base,
    options: [
      { label: A, pct: null, fill: 0, winner: false, picked: false },
      { label: B, pct: null, fill: 0, winner: false, picked: false },
    ],
    bars: false,
    count: playersLabel(1204),
    sealed: true,
    resultLabel: CARD_REFUNDED_TITLE,
    note: cardRefundLine(4),
    pose: 'neutral',
  },
  teaser__sealed: {
    ...base,
    kind: 'teaser',
    options: [
      { label: A, pct: null, fill: 0, winner: false, picked: false },
      { label: B, pct: null, fill: 0, winner: false, picked: false },
    ],
    bars: false,
    outlines: true,
    sealed: true,
    resultLabel: CARD_TEASER_LINE,
    pose: 'neutral',
  },
  round__free: {
    ...base,
    kind: 'round',
    meta: `Free · Oct 12 · ${playersLabel(1204)}`,
    options: split(null),
    resultLabel: roundLine(458, 1204),
    pose: 'neutral',
    handle: null,
  },
};
