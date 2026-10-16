// Today, open (Paper Core flow `core/today/open-signed-out/*`; spec "Client app" › Today): the date
// and the mode toggle, the question (question role on mobile, display from tablet up), the two option
// cards, the crowd-history hint, the countdown to close and the entrant counter (one row from tablet
// up), the CTA ("Sign in to play" signed out, "Seal my pick" signed in) and the Free note.
// Presentational: Today (the live screen) and the design sheets feed it plain props. It renders the
// screen's sections into the shell's content column, which owns the gaps.
import { useId } from 'react';
import type { Breakpoint } from '../theme';
import { Button } from '../ui/Button';
import { Countdown } from '../ui/Countdown';
import { EntrantCounter } from '../ui/EntrantCounter';
import { ModeToggle, type Mode } from '../ui/ModeToggle';
import { OptionGroup, type OptionGroupOption } from '../ui/OptionCard';
import s from './TodayView.module.css';

export const FREE_NOTE = 'Free to play. Points have no cash value.';

export interface TodayViewProps {
  breakpoint: Breakpoint;
  /** The game day as the date line shows it: "Thursday, Oct 8". */
  date: string;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  /** False shows the static "Free" label instead of the toggle. */
  stakesAvailable?: boolean;
  question: string;
  /** The two answers, in the question's order. */
  options: readonly OptionGroupOption[];
  /** The picked option's value, or null. */
  pick: string | null;
  onPick: (value: string) => void;
  /** The crowd-history hint ("Would-you-rather days split 63/37 on average."), or null to hide it. */
  crowdHint?: string | null;
  /** Time left until entries close (ms). */
  remainingMs: number;
  /** The selected mode's entrant count and pool (points in Free, USDC base units in Stakes). */
  entrants: number;
  pool: bigint;
  /** Entries are open: the counter's live dot. */
  live: boolean;
  signedIn: boolean;
  /** "Sign in to play". */
  onSignIn: () => void;
  /** "Seal my pick". */
  onSeal?: () => void;
  /** Keeps "Seal my pick" disabled even with a pick (offline, or no entry flow yet). */
  sealDisabled?: boolean;
}

export function TodayView({
  breakpoint,
  date,
  mode,
  onModeChange,
  stakesAvailable = true,
  question,
  options,
  pick,
  onPick,
  crowdHint = null,
  remainingMs,
  entrants,
  pool,
  live,
  signedIn,
  onSignIn,
  onSeal,
  sealDisabled = false,
}: TodayViewProps) {
  const questionId = useId();
  return (
    <>
      <div className={s.meta}>
        <p className={`type-label ${s.date}`}>{date}</p>
        <ModeToggle
          value={mode}
          onChange={onModeChange}
          stakesAvailable={stakesAvailable}
          className={s.toggle}
        />
      </div>
      <h1 id={questionId} className={breakpoint === 'mobile' ? 'type-question' : 'type-display'}>
        {question}
      </h1>
      <div className={s.options}>
        <OptionGroup
          options={options}
          value={pick}
          onChange={onPick}
          labelledBy={questionId}
          className={s.cards}
        />
        {crowdHint ? <p className={s.hint}>{crowdHint}</p> : null}
      </div>
      <div className={s.status} data-breakpoint={breakpoint}>
        <Countdown label="Closes in" remainingMs={remainingMs} className={s.countdown} />
        <EntrantCounter
          mode={mode}
          entrants={entrants}
          pool={pool}
          live={live}
          className={s.counter}
        />
      </div>
      {signedIn ? (
        <Button className={s.cta} disabled={pick === null || sealDisabled} onClick={onSeal}>
          Seal my pick
        </Button>
      ) : (
        <Button className={s.cta} onClick={onSignIn}>
          Sign in to play
        </Button>
      )}
      {mode === 'free' ? <p className={s.note}>{FREE_NOTE}</p> : null}
    </>
  );
}
