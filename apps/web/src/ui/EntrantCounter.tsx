// The entrant and pool counter (Paper Components › Round status): "1,204 in · 30,100 points" in the
// number role, after an 8px ink dot that marks a live value (it doesn't blink). Free counts points,
// Stakes counts USDC. The dot goes once entries close. It never shows the split before the reveal.
import { formatAmount, groupDigits } from './amounts';
import s from './EntrantCounter.module.css';

export interface EntrantCounterProps {
  mode: 'free' | 'stakes';
  /** Entries in this mode. */
  entrants: number;
  /** The mode's pool as on the wire: points in Free, USDC base units in Stakes. */
  pool: bigint;
  /** While entries are open: shows the live dot. */
  live: boolean;
  className?: string;
}

export function EntrantCounter({ mode, entrants, pool, live, className }: EntrantCounterProps) {
  return (
    <p className={className ? `${s.counter} ${className}` : s.counter}>
      {live && <span role="img" aria-label="Live" className={s.dot} />}
      <span className="type-number">
        {groupDigits(entrants)} in · {formatAmount(pool, mode)}
      </span>
    </p>
  );
}
