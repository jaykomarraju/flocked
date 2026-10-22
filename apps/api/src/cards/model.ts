// What a card draws, independent of its variant: one `CardModel` renders as all three sizes
// (src/cards/render.ts). Spec: "Share cards and distribution" › Card content. The states are the
// Paper card artboards: result (win, loss, one per refund rule and mode), teaser and round.
import {
  BRAND,
  formatShare,
  refundReasonInfo,
  type CardKind,
  type MascotPose,
  type Mode,
  type RefundReason,
} from '@flocked/shared';

/** One option's row: its label, its share of the valid entries, and who it belongs to. */
export interface CardOption {
  label: string;
  /** Whole-percent text ("62%", "<1%"), or null on a card with no split (teaser, rules 4/6/7/8). */
  pct: string | null;
  /** 0–100 of the track, as the bar's own width. */
  fill: number;
  /** The minority side that won: the one bar (and only bar) that may carry the accent. */
  winner: boolean;
  /** The card owner's pick ("Your pick" pill). Never set on a teaser or round card. */
  picked: boolean;
}

export interface CardModel {
  kind: CardKind;
  /** "Free · Oct 12", or "Free · Oct 12 · 1,204 players" on a round card. */
  meta: string;
  question: string;
  options: readonly [CardOption, CardOption];
  /** Split bars (a result with a tally, or a round card). */
  bars: boolean;
  /** Both options as plain outlines, with no per-option data (teaser only). */
  outlines: boolean;
  /** "1,204 players" where the bars would be (refund rules 4, 6, 7 and 8). */
  count: string | null;
  /** The sealed badge: a teaser, and refund rules 4, 7 and 8 (no pick was ever opened). */
  sealed: boolean;
  /** The stray-streak pill, at 2 or more (spec "Card content"). */
  streak: number | null;
  /** "UNFLOCKED", "GOT FLOCKED", "Refunded", or the teaser's and round card's line. */
  resultLabel: string;
  /** "+86 pts", "2.6x", "+16.00 USDC"; null when the label stands alone. */
  resultValue: string | null;
  /** The accent on the result line: a win only (a loss, refund, teaser and round are ink). */
  resultAccent: boolean;
  /** A Stakes amount or multiple, which steps down a size to stay on one line (W6-C). */
  resultIsAmount: boolean;
  /** The refund's why line, exactly as Design_Language's refund table has it. */
  note: string | null;
  pose: MascotPose;
  /** The handle without its "@" — null on a round card and after account deletion. */
  handle: string | null;
}

/**
 * The refund lines (Design_Language.md's refund table). The reveal draws the same lines from
 * `apps/web/src/features/reveal/copy.ts`; the Worker can't import the web, so the table is here
 * too (W10-A handoff: it belongs in @flocked/shared, which neither session owns this wave).
 */
export const CARD_REFUND_LINES: Readonly<Record<string, string>> = {
  too_few_entrants: 'Not enough sheep showed up. Everyone gets their stake back.',
  one_sided: 'Everyone picked the same side. No strays, no round. Everyone gets their stake back.',
  headcount_tie: 'A dead heat. Nobody strayed, so everyone gets their stake back.',
  voided: 'This round was called off before it closed. Everyone gets their stake back.',
  vetoed: 'The result was challenged and thrown out. Everyone gets their stake back.',
  timeout: 'No result was posted in time. Everyone gets their stake back.',
  commitment_not_anchored:
    "The picks weren't locked in on time, so this round doesn't count. Points returned.",
  beacon_unavailable: 'The timelock never opened, so the picks stay sealed. Points returned.',
};

/** The refund line for a code, by `REFUND_REASONS[].name`; the tie line for an unknown code. */
export function cardRefundLine(code: number | null): string {
  try {
    return CARD_REFUND_LINES[refundReasonInfo(code as RefundReason).name] as string;
  } catch {
    return CARD_REFUND_LINES.headcount_tie as string;
  }
}

/** Rules 1, 2, 3 and 5 keep the split; 4, 6, 7 and 8 have no tally to show (screens.md, W6-C). */
export function refundKeepsSplit(code: number | null): boolean {
  return code === 1 || code === 2 || code === 3 || code === 5;
}

/** Rules 4, 7 and 8 refunded before any pick was opened, so they carry the sealed badge. */
export function refundSealed(code: number | null): boolean {
  return code === 4 || code === 7 || code === 8;
}

/** "Refunded", the result-card component's refunded title. */
export const CARD_REFUNDED_TITLE = 'Refunded';

/** The teaser's big line (spec "Share surfaces": the pre-reveal share text). */
export const CARD_TEASER_LINE = 'I sealed my pick. Can you out-think the flock?';

/** The wordmark's URL (Decision log, Oct 12, 2026: the domain is flocked.xyz). */
export const CARD_URL = 'flocked.xyz';

/** "1,204 players" (and "1 player"). */
export function playersLabel(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'player' : 'players'}`;
}

/** The mode and day label: "Free · Oct 12". */
export function metaLabel(mode: Mode, gameDay: string): string {
  const [y, m, d] = gameDay.split('-').map(Number) as [number, number, number];
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${mode === 'free' ? 'Free' : 'Stakes'} · ${month} ${d}`;
}

/** The round card's line: "38% strayed. They won." (screens.md, cards/round). */
export function roundLine(winnerCount: number, total: number): string {
  return `${formatShare(winnerCount, total, 'win')} strayed. They won.`;
}

/** "UNFLOCKED" and "GOT FLOCKED" as the cards set them (BRAND, upper case). */
export const CARD_UNFLOCKED = BRAND.unflocked.toUpperCase();
export const CARD_GOT_FLOCKED = BRAND.gotFlocked.toUpperCase();

/** The stray-streak pill, from 2 up: "3-day stray streak". */
export function streakLabel(days: number): string {
  return `${days}-day stray streak`;
}
