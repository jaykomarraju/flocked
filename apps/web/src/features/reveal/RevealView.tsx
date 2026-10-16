// Reveal (Paper Core flow `core/reveal/{unsealing,counting,win,loss,refund,mode-toggle}/*`; spec
// "Client app" › Reveal, "Real-time and the reveal" › Reveal choreography; Design_Language.md "Motion"):
//   unsealing  "Unsealing in 1:42" (m:ss), the final count (no live dot), equal ink bars, the note
//   counting   "Counting the flock…", the final count, equal bars, the note
//   revealed   the bars grow from equal to their headcount shares over 3 s (shares count up with them),
//              the winning bar fills with the accent, then the result card springs up, the sheep moves
//              (win: the lone sheep walks off; loss: the flock slides in), and the share preview,
//              Share and "The next question is already live" fade in last
//   refunded   no animation (no winner): the split for rules 1, 2, 3 and 5, else the entrant count,
//              and the refund card with the reason's line
// A mode the player didn't play shows its split with "You didn't play … this round." and a link back,
// no result card and no Share. Reduced motion skips to the end state with a fade. `animate` is false
// once this device has played the round's reveal (played.ts), and in the design sheets.
// Presentational: the live screen and the design sheets feed it plain props.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Breakpoint } from '../../theme';
import { Countdown, formatCountdown } from '../../ui/Countdown';
import { EntrantCounter } from '../../ui/EntrantCounter';
import { ModeToggle, type Mode } from '../../ui/ModeToggle';
import { ResultCard, type ResultCardProps } from '../../ui/ResultCard';
import { SplitBars } from '../../ui/SplitBars';
import { TextButton } from '../../ui/TextButton';
import {
  COUNTING_NOTE,
  COUNTING_TITLE,
  NEXT_LIVE_TITLE,
  UNSEALING_LABEL,
  UNSEALING_NOTE,
  backToLine,
  notPlayedLine,
} from './copy';
import s from './RevealView.module.css';

/** The reveal's motion.reveal, motion.fade and motion.spring (design tokens), ms. */
export const REVEAL_MS = 3000;

export type RevealPhase = 'unsealing' | 'counting' | 'revealed' | 'refunded';
export type RevealStage = 'start' | 'grow' | 'done';

export interface NextQuestion {
  question: string;
  /** Time left until it closes, ms. */
  remainingMs: number;
  onOpen: () => void;
}

export interface RevealViewProps {
  breakpoint: Breakpoint;
  date: string;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  stakesAvailable?: boolean;
  /** Modes whose segment is enabled (the other is disabled until it reveals). */
  question: string;
  options: readonly string[];
  phase: RevealPhase;
  /** Unsealing: time left until the beacon, ms. */
  unsealingMs?: number;
  entrants: number;
  pool: bigint;
  /** The player's option in this mode, or null (not on this device yet, or not played). */
  pick: number | null;
  /** Revealed or refunded with a split: valid entries per option. */
  counts?: readonly [number, number] | null;
  winner?: number | null;
  /** Refunded without a split (rules 4, 6, 7, 8): the bars give way to the entrant count. */
  hideSplit?: boolean;
  /** The player's result card; null when they didn't play this mode. */
  result?: ResultCardProps | null;
  /** This mode wasn't played: the line and the way back to the played mode. */
  notPlayed?: { onBack: () => void; playedMode: Mode } | null;
  /** The share-card preview and Share (only for a mode the player played). */
  share?: ReactNode;
  next?: NextQuestion | null;
  /** Play the reveal animation (first view on this device). */
  animate?: boolean;
  /** Called when the animation has started, so it plays once per round. */
  onPlayed?: () => void;
}

/** `prefers-reduced-motion: reduce`, live. */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduce, setReduce] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setReduce(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  return reduce;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * The reveal's stages: `start` (equal bars) for one frame, `grow` for REVEAL_MS while the bars widen
 * (CSS) and the shares count up from 50% (rAF), then `done`. Without `animate`, or with reduced
 * motion, it is `done` from the first render.
 */
export function useRevealStage(
  animate: boolean,
  reduce: boolean,
  counts: readonly [number, number] | null,
): { stage: RevealStage; display: string[] | undefined } {
  const run = animate && !reduce && counts !== null;
  const [stage, setStage] = useState<RevealStage>(run ? 'start' : 'done');
  const [display, setDisplay] = useState<string[] | undefined>(run ? ['50%', '50%'] : undefined);
  const total = counts ? counts[0] + counts[1] : 0;
  useEffect(() => {
    if (!run || !counts) return;
    let frame = requestAnimationFrame(() => {
      const t0 = performance.now();
      setStage('grow');
      const tick = (t: number) => {
        const p = Math.min(1, (t - t0) / REVEAL_MS);
        setDisplay(
          counts.map((c) => `${Math.round(50 + ((c / (total || 1)) * 100 - 50) * easeOut(p))}%`),
        );
        if (p < 1) frame = requestAnimationFrame(tick);
        else {
          setDisplay(undefined);
          setStage('done');
        }
      };
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // Runs once per mount (a new phase remounts the view): a revealed mode's counts never change.
  }, [run]);
  return { stage, display };
}

export function RevealView({
  breakpoint,
  date,
  mode,
  onModeChange,
  stakesAvailable = true,
  question,
  options,
  phase,
  unsealingMs = 0,
  entrants,
  pool,
  pick,
  counts = null,
  winner = null,
  hideSplit = false,
  result = null,
  notPlayed = null,
  share,
  next = null,
  animate = false,
  onPlayed,
}: RevealViewProps) {
  const reduce = usePrefersReducedMotion();
  const revealing = phase === 'revealed' && notPlayed === null;
  const { stage, display } = useRevealStage(
    animate && revealing,
    reduce,
    revealing ? counts : null,
  );
  useEffect(() => {
    if (animate && revealing) onPlayed?.();
  }, []);
  // Reduced motion: the end state fades in instead.
  const fade = animate && revealing && reduce;
  const settled = phase === 'revealed' || phase === 'refunded';
  const barCounts = useMemo(
    () => (settled && counts && stage !== 'start' ? counts : undefined),
    [settled, counts, stage],
  );

  return (
    <div
      className={s.reveal}
      data-phase={phase}
      data-reveal-stage={stage}
      data-motion={fade ? 'fade' : animate && revealing ? 'full' : 'none'}
    >
      <div className={s.meta}>
        <p className={`type-label ${s.date}`}>{date}</p>
        <ModeToggle
          value={mode}
          onChange={onModeChange}
          stakesAvailable={stakesAvailable}
          className={s.toggle}
        />
      </div>
      <h1 className={breakpoint === 'mobile' ? 'type-question' : 'type-display'}>{question}</h1>

      {phase === 'unsealing' || phase === 'counting' ? (
        <div className={s.status}>
          {phase === 'unsealing' ? (
            <Countdown label={UNSEALING_LABEL} remainingMs={unsealingMs} style="ms" />
          ) : (
            <p className={`type-title ${s.counting}`} role="status">
              {COUNTING_TITLE}
            </p>
          )}
          <EntrantCounter mode={mode} entrants={entrants} pool={pool} live={false} />
        </div>
      ) : null}

      <div className={s.body} data-fade={fade ? 'true' : undefined}>
        {hideSplit ? (
          <EntrantCounter mode={mode} entrants={entrants} pool={pool} live={false} />
        ) : (
          <SplitBars
            options={options}
            counts={barCounts}
            winner={stage === 'done' || !animate ? winner : null}
            pick={notPlayed ? null : pick}
            display={display}
          />
        )}
        {phase === 'unsealing' ? <p className={`type-body ${s.note}`}>{UNSEALING_NOTE}</p> : null}
        {phase === 'counting' ? <p className={`type-body ${s.note}`}>{COUNTING_NOTE}</p> : null}

        {settled && notPlayed ? (
          <div className={s.notPlayed}>
            <p className="type-body">{notPlayedLine(mode)}</p>
            <EntrantCounter mode={mode} entrants={entrants} pool={pool} live={false} />
            <TextButton onClick={notPlayed.onBack}>{backToLine(notPlayed.playedMode)}</TextButton>
          </div>
        ) : null}

        {settled && result && stage === 'done' ? (
          <div className={s.result} data-result={result.result}>
            <ResultCard {...result} />
          </div>
        ) : null}
        {settled && share && stage === 'done' ? <div className={s.late}>{share}</div> : null}
      </div>

      {next && (settled || phase === 'counting') && stage === 'done' ? (
        <section className={s.next} aria-labelledby="next-live-title">
          <h2 id="next-live-title" className="type-title">
            {NEXT_LIVE_TITLE}
          </h2>
          <button type="button" className={s.nextCard} onClick={next.onOpen}>
            <span className={`type-label ${s.nextCloses}`}>
              Closes in {formatCountdown(next.remainingMs)}
            </span>
            <span className="type-body-strong">{next.question}</span>
          </button>
        </section>
      ) : null}
    </div>
  );
}
