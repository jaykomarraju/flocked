// The leaderboard row (Paper Components › Lists › Leaderboard row): rank in a 32px slot (flexShrink 0,
// so a 3-digit rank fits), avatar 40, the handle in bodyStrong with a caption, and the value in a 72px
// right-aligned slot; 68px rows. A stray streak that is still alive gets an accent pill with a
// cta-role number, but only the board's top live streak (`highlight`): nothing else on a board uses
// the accent. Your row lifts onto a surface card with an ink border and a "You" pill.
import type { ReactNode } from 'react';
import { Avatar } from './Avatar';
import s from './LeaderboardRow.module.css';

/** The board's list: a line rule on top, each row ruled below. */
export function LeaderboardList({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <ol className={className ? `${s.list} ${className}` : s.list} aria-label={ariaLabel}>
      {children}
    </ol>
  );
}

export interface LeaderboardRowProps {
  rank: number;
  handle: string;
  avatarSrc?: string | null;
  /** The caption under the handle, e.g. "Still running", "Ended Oct 5". */
  caption?: string;
  /** The tab's value: a streak, points, wins or creator score. */
  value: ReactNode;
  /** Read after the value by screen readers, e.g. "rounds". */
  valueLabel?: string;
  /** The board's top live stray streak: the value sits in an accent pill. */
  highlight?: boolean;
  /** Your own row: a surface card with an ink border and a "You" pill. */
  you?: boolean;
  /** Your row pinned below the visible page: set apart by 12px. */
  pinned?: boolean;
}

/** One board entry. Render it inside a `LeaderboardList`. */
export function LeaderboardRow({
  rank,
  handle,
  avatarSrc,
  caption,
  value,
  valueLabel,
  highlight = false,
  you = false,
  pinned = false,
}: LeaderboardRowProps) {
  const at = handle.startsWith('@') ? handle : `@${handle}`;
  const classes = [s.row, you && s.you, pinned && s.pinned].filter(Boolean).join(' ');
  return (
    <li className={classes} aria-current={you ? 'true' : undefined}>
      <span className={`type-number ${s.rank}`}>
        <span className="visually-hidden">Rank </span>
        {rank}
      </span>
      <Avatar handle={handle} size={40} src={avatarSrc} />
      <span className={s.who}>
        <span className={s.handleLine}>
          <span className={`type-body-strong ${s.handle}`}>{at}</span>
          {you && <span className={s.youPill}>You</span>}
        </span>
        {caption && <span className={`type-caption ${s.caption}`}>{caption}</span>}
      </span>
      <span className={highlight ? s.pillSlot : s.valueSlot}>
        <span
          className={
            highlight ? `type-cta tnum ${s.streakPill}` : `type-body-strong tnum ${s.value}`
          }
          data-highlight={highlight || undefined}
        >
          {value}
          {valueLabel && <span className="visually-hidden"> {valueLabel}</span>}
        </span>
      </span>
    </li>
  );
}
