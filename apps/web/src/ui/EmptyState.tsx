// The empty state (Paper Components › Feedback › Empty state): the neutral sheep, a voice line in the
// title role and at most one way out, in a read-only box (line border). Lists use the same layout with
// their own line ("No rounds yet.").
import { VOICE } from '@flocked/shared';
import { Mascot } from '@flocked/shared/mascot/react';
import type { ReactNode } from 'react';
import s from './EmptyState.module.css';

export interface EmptyStateProps {
  /** The voice line. Defaults to "No question yet. The sheep are deliberating." */
  line?: string;
  /** At most one way out (a small secondary pill or link). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ line = VOICE.emptyState, action, className }: EmptyStateProps) {
  return (
    <div className={className ? `${s.empty} ${className}` : s.empty}>
      <Mascot pose="neutral" size={150} className={s.sheep} />
      <p className={`type-title ${s.line}`}>{line}</p>
      {action}
    </div>
  );
}
