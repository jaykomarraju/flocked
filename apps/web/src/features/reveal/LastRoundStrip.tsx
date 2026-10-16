// The "Last round" strip on Today while the previous round is still revealing or settling (Paper
// `core/reveal/next-live/*`; `GET /rounds/today` `previousRoundId`): the player's result there and
// "See the reveal", which opens it again.
import type { RoundMeResponse } from '@flocked/shared';
import { BRAND } from '@flocked/shared';
import type { StoredPick } from '../../crypto/picks';
import { TextButton } from '../../ui/TextButton';
import { COUNTING_TITLE, LAST_ROUND, SEE_THE_REVEAL } from './copy';
import s from './LastRoundStrip.module.css';

/** "Unflocked, +38 points", "Got flocked, −25 points", "Refunded", or still counting. */
export function lastRoundSummary(me: RoundMeResponse | null, stored: StoredPick | null): string {
  const free = me?.modes.free;
  if (!free?.result) return COUNTING_TITLE;
  const stake = BigInt(free.entry.stake || stored?.stake || '0');
  const paid = free.payouts.reduce((a, p) => a + BigInt(p.amount), 0n);
  const pts = (n: bigint) => `${n.toLocaleString('en-US')} points`;
  switch (free.result) {
    case 'win':
      return `${BRAND.unflocked}, +${pts(paid - stake)}`;
    case 'loss':
      return `${BRAND.gotFlocked}, −${pts(stake - paid)}`;
    default:
      return 'Refunded';
  }
}

export function LastRoundStrip({ summary, onSee }: { summary: string; onSee: () => void }) {
  return (
    <div className={s.strip}>
      <p className="type-label">
        <span className={s.label}>{LAST_ROUND}: </span>
        {summary}
      </p>
      <TextButton onClick={onSee}>{SEE_THE_REVEAL}</TextButton>
    </div>
  );
}
