// The padlock sealed badge (Paper Components › Round status): a 32px ink pill with a padlock and
// "Sealed" in bg, Inter 600 at the label size. It marks a sealed entry anywhere.
import { PadlockIcon } from './icons/PadlockIcon';
import s from './SealedBadge.module.css';

export interface SealedBadgeProps {
  className?: string;
}

export function SealedBadge({ className }: SealedBadgeProps) {
  return (
    <span className={className ? `${s.badge} ${className}` : s.badge}>
      <PadlockIcon className={s.icon} />
      <span className={`type-label ${s.text}`}>Sealed</span>
    </span>
  );
}
