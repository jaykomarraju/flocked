// Today, open (Paper Core flow `core/today/{open-signed-out,open-free,sealing,dst-notice}/*`,
// `core/reveal/next-live/*`; spec "Client app" › Today): the date and the mode toggle, a notice (the
// DST day), the question (question role on mobile, display from tablet up), the two option cards, the
// crowd-history hint, the stake selector (signed in, Free: presets and slider), the countdown to close
// and the entrant counter (one row from tablet up), an error box (a failed or refused entry, keeping
// the selection), the CTA ("Sign in to play" signed out; "Seal my pick", "Sealing" while it works) and
// the note under it (the Free note signed out, the sealing note while sealing). While the previous
// round is still revealing, a "Last round" strip sits on top (`next-live`).
// Presentational: Today (the live screen) and the design sheets feed it plain props. It renders the
// screen's sections into the shell's content column, which owns the gaps.
import { useId, type ReactNode } from 'react';
import type { Breakpoint } from '../../theme';
import { Button } from '../../ui/Button';
import { Countdown } from '../../ui/Countdown';
import { EntrantCounter } from '../../ui/EntrantCounter';
import { ErrorBox } from '../../ui/ErrorBox';
import { ClockIcon } from '../../ui/icons/ClockIcon';
import { ModeToggle, type Mode } from '../../ui/ModeToggle';
import { OptionGroup, type OptionGroupOption } from '../../ui/OptionCard';
import { StakeSelector } from '../../ui/StakeSelector';
import { SEALING_NOTE, type DstNotice } from './copy';
import s from './TodayView.module.css';

export const FREE_NOTE = 'Free to play. Points have no cash value.';

/** The Free stake selector's state (signed in). Points. */
export interface FreeStakeProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  presets: readonly number[];
  /** The player's points balance; presets above it are disabled. */
  balance?: number;
}

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
  /** Free, signed in: the stake selector. */
  stake?: FreeStakeProps | null;
  /** A notice above the question (the DST day). */
  notice?: DstNotice | null;
  /** The "Last round" strip above everything (the previous round still revealing). */
  lastRound?: ReactNode;
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
  /** Keeps "Seal my pick" disabled even with a pick (offline, or no entry flow). */
  sealDisabled?: boolean;
  /** The pick is being sealed: the CTA spins, the other option is disabled, the sealing note shows. */
  sealing?: boolean;
  /** A failed or refused entry, above the CTA. `onRetry` only when retrying can help. */
  error?: { message: string; onRetry?: () => void } | null;
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
  stake = null,
  notice = null,
  lastRound,
  remainingMs,
  entrants,
  pool,
  live,
  signedIn,
  onSignIn,
  onSeal,
  sealDisabled = false,
  sealing = false,
  error = null,
}: TodayViewProps) {
  const questionId = useId();
  return (
    <>
      {lastRound}
      <div className={s.meta}>
        <p className={`type-label ${s.date}`}>{date}</p>
        <ModeToggle
          value={mode}
          onChange={onModeChange}
          stakesAvailable={stakesAvailable}
          className={s.toggle}
        />
      </div>
      {notice ? (
        <div className={s.notice} role="note">
          <ClockIcon className={s.noticeIcon} />
          <div>
            <p className="type-body-strong">{notice.title}</p>
            <p className={s.noticeBody}>{notice.body}</p>
          </div>
        </div>
      ) : null}
      <h1 id={questionId} className={breakpoint === 'mobile' ? 'type-question' : 'type-display'}>
        {question}
      </h1>
      <div className={s.options}>
        <OptionGroup
          options={options}
          value={pick}
          onChange={onPick}
          disabled={sealing}
          labelledBy={questionId}
          className={s.cards}
        />
        {crowdHint ? <p className={s.hint}>{crowdHint}</p> : null}
      </div>
      {signedIn && mode === 'free' && stake ? (
        <StakeSelector
          mode="free"
          value={stake.value}
          onChange={stake.onChange}
          min={stake.min}
          max={stake.max}
          presets={stake.presets}
          balance={stake.balance}
        />
      ) : null}
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
      {error ? <ErrorBox message={error.message} onRetry={error.onRetry} /> : null}
      {signedIn ? (
        <Button
          className={s.cta}
          disabled={pick === null || sealDisabled}
          loading={sealing}
          loadingLabel="Sealing"
          onClick={onSeal}
        >
          Seal my pick
        </Button>
      ) : (
        <Button className={s.cta} onClick={onSignIn}>
          Sign in to play
        </Button>
      )}
      {sealing ? (
        <p className={s.note}>{SEALING_NOTE}</p>
      ) : !signedIn && mode === 'free' ? (
        <p className={s.note}>{FREE_NOTE}</p>
      ) : null}
    </>
  );
}
