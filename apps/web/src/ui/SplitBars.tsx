// The split bars (Paper Components › Round status › Split bars): one bar per option, in the question's
// order (never sorted). While unsealing both bars sit at half, in ink, with no numbers. Settled, each
// fill is its headcount share and the winning (smaller) side fills with the accent; a headcount tie (or
// any refund) has no winner and no accent. Shares are text from `formatShare` (winner rounds down,
// loser up, "<1%" and ">99%" at the ends), in ink, so the result never relies on colour.
//
// Fill widths come from the counts. A partial fill never drops below 24px (one full round end), so a
// tiny winning side stays visible, and never comes closer than 24px to the track's end (Paper draws
// ">99%" at the track width less 24). The track is decoration only.
//
// Motion: from the unsealing state, the fills grow to their shares over motion.reveal, then the winner
// fills with the accent. Reduced motion skips to the end state.
import { formatShare, type ShareSide } from '@flocked/shared';
import type { CSSProperties } from 'react';
import s from './SplitBars.module.css';

/** A partial fill's floor (and its distance from the track's end), in px. */
export const SPLIT_FILL_MIN_PX = 24;

/**
 * A fill's CSS width for `count` of `total` entries: "0px" for none, "100%" for all, otherwise the
 * share clamped to [24px, track − 24px].
 */
export function splitFillWidth(count: number, total: number): string {
  if (total <= 0 || count <= 0) return '0px';
  if (count >= total) return '100%';
  const percent = (count / total) * 100;
  return `clamp(${SPLIT_FILL_MIN_PX}px, ${percent}%, calc(100% - ${SPLIT_FILL_MIN_PX}px))`;
}

/**
 * Which way an option's share rounds. The winner rounds down and everyone else up; with no winner
 * (a refund) the strictly smallest side rounds down, so the shares still add up to 100%. A tie reads
 * an exact 50% either way.
 */
function shareSide(i: number, counts: readonly number[], winner: number | null): ShareSide {
  if (winner !== null) return i === winner ? 'win' : 'loss';
  const count = counts[i] ?? 0;
  const smallest = counts.every((c, j) => j === i || c > count);
  return smallest ? 'win' : 'loss';
}

export interface SplitBarsProps {
  /** The options' text, in the question's order. */
  options: readonly string[];
  /** Valid entries per option, in the same order. Omitted while unsealing: equal bars, no numbers. */
  counts?: readonly number[];
  /** The winning option's index; null or omitted when nobody won (a headcount tie or a refund). */
  winner?: number | null;
  /** The player's option: an ink "Your pick" pill after its text (W9-C, the Reveal screens). */
  pick?: number | null;
  /** Share text to show instead of the counts' (the reveal's count-up, W9-C); widths still follow `counts`. */
  display?: readonly string[];
  /** The list's accessible name. */
  label?: string;
  className?: string;
}

export function SplitBars({
  options,
  counts,
  winner = null,
  pick = null,
  display,
  label = 'How the crowd split',
  className,
}: SplitBarsProps) {
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;
  return (
    <ul aria-label={label} className={className ? `${s.bars} ${className}` : s.bars}>
      {options.map((option, i) => {
        const count = counts?.[i] ?? 0;
        const won = counts !== undefined && winner === i;
        const share = !counts
          ? null
          : (display?.[i] ??
            (total > 0 ? formatShare(count, total, shareSide(i, counts, winner)) : '0%'));
        const width = counts ? splitFillWidth(count, total) : '50%';
        return (
          <li key={i} className={s.bar}>
            <div className={s.head}>
              <span className={s.option}>
                <span className="type-body-strong">{option}</span>
                {pick === i && <span className={`type-label ${s.pick}`}>Your pick</span>}
              </span>
              {share !== null && <span className="type-number">{share}</span>}
              {won && <span className="visually-hidden">, the winning side</span>}
            </div>
            <div className={s.track} aria-hidden="true">
              <div
                className={s.fill}
                data-winner={won ? 'true' : undefined}
                style={{ '--fill': width } as CSSProperties}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
