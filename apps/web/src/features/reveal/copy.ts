// Reveal copy (Design_Language.md "Voice"): the refund line per refund reason, keyed by
// `RefundReasonName` (packages/shared/src/reasons.ts), and the core-flow lines around the reveal.
import { VOICE, refundReasonInfo, type RefundReason, type RefundReasonName } from '@flocked/shared';

export const REFUND_LINES: Record<RefundReasonName, string> = {
  too_few_entrants: 'Not enough sheep showed up. Everyone gets their stake back.',
  one_sided: 'Everyone picked the same side. No strays, no round. Everyone gets their stake back.',
  headcount_tie: VOICE.refundedTie,
  voided: 'This round was called off before it closed. Everyone gets their stake back.',
  vetoed: 'The result was challenged and thrown out. Everyone gets their stake back.',
  timeout: 'No result was posted in time. Everyone gets their stake back.',
  commitment_not_anchored:
    "The picks weren't locked in on time, so this round doesn't count. Points returned.",
  beacon_unavailable: 'The timelock never opened, so the picks stay sealed. Points returned.',
};

/** The refund line for a refund code (1–8); the tie line for an unknown one. */
export function refundLine(code: number | null): string {
  try {
    return REFUND_LINES[refundReasonInfo(code as RefundReason).name as RefundReasonName];
  } catch {
    return VOICE.refundedTie;
  }
}

/**
 * Rules 1, 2, 3 and 5 keep the split (one-sided reads 100% / 0%); 4, 6, 7 and 8 have no tally to
 * show, so the bars give way to the final entrant count (docs/design/screens.md, W3-C.2).
 */
export function refundKeepsSplit(code: number | null): boolean {
  return code === 1 || code === 2 || code === 3 || code === 5;
}

export const UNSEALING_LABEL = 'Unsealing in';
export const UNSEALING_NOTE = 'Entries closed at 9pm. The timelock opens for everyone at once.';
export const COUNTING_TITLE = 'Counting the flock…';
export const COUNTING_NOTE = 'The timelock is open. Every pick is being tallied.';
export const NEXT_LIVE_TITLE = 'The next question is already live';
export const LAST_ROUND = 'Last round';
export const SEE_THE_REVEAL = 'See the reveal';
export const PICK_LOST = 'Pick not on this device';

/** A mode the player didn't play, toggled to on the reveal. */
export function notPlayedLine(mode: 'free' | 'stakes'): string {
  return `You didn't play ${mode === 'free' ? 'Free' : 'Stakes'} this round.`;
}
export function backToLine(mode: 'free' | 'stakes'): string {
  return `Back to your ${mode === 'free' ? 'Free' : 'Stakes'} result`;
}
