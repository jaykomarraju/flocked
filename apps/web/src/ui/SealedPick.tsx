// The locked pick (Paper Components › Round status, next to the sealed badge): on Sealed, the picked
// option keeps the ink fill, with a padlock in the radio slot and the stake under the option. It is a
// display, not a control.
import { formatAmount } from './amounts';
import { PadlockIcon } from './icons/PadlockIcon';
import s from './SealedPick.module.css';

export interface SealedPickProps {
  /** The picked option's text. */
  option: string;
  mode: 'free' | 'stakes';
  /** The stake as on the wire: points in Free, USDC base units in Stakes. */
  stake: bigint;
  className?: string;
}

export function SealedPick({ option, mode, stake, className }: SealedPickProps) {
  return (
    <div className={className ? `${s.pick} ${className}` : s.pick}>
      <div className={s.text}>
        <p className="type-option">{option}</p>
        <p className="type-number-small">{formatAmount(stake, mode)}</p>
      </div>
      <PadlockIcon width={22} height={26} strokeWidth={1.6} className={s.icon} />
      <span className="visually-hidden">Sealed</span>
    </div>
  );
}
