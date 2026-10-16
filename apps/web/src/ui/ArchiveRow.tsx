// The archive list row (Paper Components › Lists › List row; Archive and Profile): date and mode in
// the caption role, the question in bodyStrong, a 6px mini split (accent only on the winning side; a
// tie stays ink) and your result in a 96px slot. The whole row links to Round detail.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import s from './ArchiveRow.module.css';

export type SplitWinner = 'first' | 'second' | 'tie';

export interface MiniSplitProps {
  /** The first answer's share of the headcount, in percent (0 to 100). */
  first: number;
  /** The winning (smaller) side; a tie leaves both sides ink. */
  winner: SplitWinner;
  /** An accessible description of the split. Without one the bar is decorative. */
  label?: string;
  className?: string;
}

/** The 6px split under an archive row: two pill segments, 3px apart. */
export function MiniSplit({ first, winner, label, className }: MiniSplitProps) {
  const share = Math.min(100, Math.max(0, first));
  const a11y =
    label === undefined ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label };
  return (
    <div className={className ? `${s.split} ${className}` : s.split} {...a11y}>
      <span
        className={winner === 'first' ? s.win : s.side}
        style={{ width: `round(${share}%, 1px)` }}
        data-winner={winner === 'first' || undefined}
      />
      <span
        className={`${winner === 'second' ? s.win : s.side} ${s.rest}`}
        data-winner={winner === 'second' || undefined}
      />
    </div>
  );
}

export type ArchiveResult = 'win' | 'loss' | 'refunded';

const RESULT_LABEL: Record<ArchiveResult, string> = {
  win: 'Unflocked',
  loss: 'Got flocked',
  refunded: 'Refunded',
};

/** The rows' list: a line rule on top, each row ruled below. */
export function ArchiveList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={className ? `${s.list} ${className}` : s.list}>{children}</ul>;
}

export interface ArchiveRowProps {
  /** Round detail (`/r/:id`). */
  to: string;
  /** The round's date as shown, e.g. "Tue, Oct 6". */
  date: string;
  mode: 'free' | 'stakes';
  question: string;
  result: ArchiveResult;
  split: MiniSplitProps;
}

/** One past round. Render it inside an `ArchiveList`. */
export function ArchiveRow({ to, date, mode, question, result, split }: ArchiveRowProps) {
  return (
    <li>
      <Link to={to} className={s.row}>
        <div className={s.main}>
          <p className={`type-caption ${s.meta}`}>
            {date} · {mode === 'free' ? 'Free' : 'Stakes'}
          </p>
          <p className={`type-body-strong ${s.question}`}>{question}</p>
          <MiniSplit {...split} />
        </div>
        <p className={`type-label ${s.result}`} data-result={result}>
          {RESULT_LABEL[result]}
        </p>
      </Link>
    </li>
  );
}
