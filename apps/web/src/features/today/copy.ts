// Today's copy beyond the voice lines in @flocked/shared: the crowd-history hint, the DST notice, the
// sealing note, and what a refused or failed entry says. Lines not in Design_Language.md "Voice" are
// drafts (listed as spec issues in docs/sessions/W9-C.md) in the same voice.
import { VOICE, type Category, type CrowdHint } from '@flocked/shared';
import type { EntryRefusal } from '../../crypto/entry';

/** How the hint names a category's days (Paper: "Would-you-rather days"). */
const CATEGORY_DAYS: Record<Category, string> = {
  food: 'Food days',
  life: 'Life days',
  tech: 'Tech days',
  money: 'Money days',
  pop: 'Pop culture days',
  hypothetical: 'Would-you-rather days',
  other: 'Days like this',
};

/**
 * "Would-you-rather days split 63/37 on average.": the category's mean split over its last settled
 * daily rounds in the shown mode, the larger side first (the winning share is the smaller side).
 */
export function crowdHintLine(hint: CrowdHint): string {
  const minority = Math.round(hint.winningShare * 100);
  return `${CATEGORY_DAYS[hint.category]} split ${100 - minority}/${minority} on average.`;
}

/** Under the CTA while the pick is being sealed (Paper `core/today/sealing/*`). */
export const SEALING_NOTE = 'Locking it until the reveal. Keep this open a second.';

export interface DstNotice {
  title: string;
  body: string;
}

/**
 * A round longer or shorter than a day, because the clocks change before it closes (Paper
 * `core/today/dst-notice/*`: "Clocks go back tonight" / "So this round runs 25 hours. It still closes
 * at 9pm ET."). The spring-forward line is a draft in the same shape.
 */
export function dstNotice(opensAt: number, closesAt: number): DstNotice | null {
  const hours = Math.round((closesAt - opensAt) / 3600);
  if (hours === 24) return null;
  return {
    title: hours > 24 ? 'Clocks go back tonight' : 'Clocks go forward tonight',
    body: `So this round runs ${hours} hours. It still closes at 9pm ET.`,
  };
}

/** Why the client refused to seal: nothing was sent. */
export function refusalMessage(r: EntryRefusal): string {
  switch (r.kind) {
    case 'no_free_mode':
      return "This round has no Free mode. Your pick wasn't sent.";
    case 'stake_out_of_range':
      return 'That stake is outside this round. Pick another.';
    case 'target_round':
      return r.reason === 'beacon_in_past'
        ? VOICE.entryClosed
        : "This round's timelock doesn't check out, so we won't seal your pick to it.";
    case 'config_hash':
    case 'lock_leaf':
      return "This round doesn't match its onchain record, so we won't seal your pick to it.";
    case 'chain':
      return "We couldn't reach Base to check this round. Your pick wasn't sent.";
  }
}

/** API error codes an entry can meet, as the error box says them. */
export function entryErrorMessage(code: string): string {
  switch (code) {
    case 'round_closed':
    case 'round_not_open':
      return VOICE.entryClosed;
    case 'already_entered':
      return 'You already sealed a pick in this round.';
    case 'insufficient_balance':
      return "You don't have enough points for that stake.";
    case 'stake_out_of_range':
      return 'That stake is outside this round. Pick another.';
    case 'self_excluded':
      return "You're on a break. No picks until it ends.";
    case 'rate_limited':
      return 'Too many tries. Wait a minute and seal again.';
    case 'turnstile_failed':
      return "The human check didn't go through. Try again.";
    case 'network':
      return VOICE.offline;
    default:
      return VOICE.error;
  }
}

/** A receipt that failed its checks: shown on Sealed, and kept on the device as evidence. */
export const RECEIPT_MISMATCH =
  "Your receipt doesn't match what you sent. We kept it on this device as evidence.";
