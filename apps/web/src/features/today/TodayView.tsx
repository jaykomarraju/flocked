// Today, open (Paper Core flow `core/today/{open-signed-out,open-free,sealing,dst-notice,open-stakes,
// open-stakes-unverified,config-warning}/*`, `core/stakes-entry/{pending,error,mismatch}/*`,
// `core/reveal/next-live/*`; spec "Client app" › Today): the date and the mode toggle, a notice (the
// DST day, the round's special rules, or a config that doesn't match the chain), the question
// (question role on mobile, display from tablet up), the two option cards, the crowd-history hint,
// the stake selector (Free: presets and slider; Stakes: the round's fixed stake), the countdown to close
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
import { ErrorIcon } from '../../ui/icons/ErrorIcon';
import { ModeToggle, type Mode } from '../../ui/ModeToggle';
import { OptionGroup, type OptionGroupOption } from '../../ui/OptionCard';
import { StakeSelector } from '../../ui/StakeSelector';
import { SEALING_NOTE, type DstNotice } from './copy';
import s from './TodayView.module.css';

export const FREE_NOTE = 'Free to play. Points have no cash value.';

/** The notice's info mark (Paper `core/today/config-warning`): 24px on a 24 grid, stroked at 2. */
function NoticeInfoIcon({ className }: { className?: string }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 11v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="7.75" r="1.25" fill="currentColor" />
    </svg>
  );
}

/** The DST notice's clock (Paper `notice/dst` › `clock`): 24px on a 24 grid, stroked at 2. */
function NoticeClockIcon({ className }: { className?: string }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 7v5l3 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The round's fixed Stakes stake (signed in and eligible). USDC base units. */
export interface StakesStakeProps {
  stake: bigint;
  /** Today's remaining Stakes cap, shown when this entry would pass it. */
  dailyCap?: bigint;
  overCap?: boolean;
}

/** A notice above the question, in one of the three styles Paper draws. */
export interface TodayNotice extends DstNotice {
  variant?: 'read-only' | 'strong' | 'refusal';
  /** An underlined line under the body: the change log, or "See what doesn't match". */
  link?: { label: string; onClick: () => void };
}

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
  /** Stakes, signed in and eligible: the round's fixed stake, instead of the Free selector. */
  stakesStake?: StakesStakeProps | null;
  /**
   * A notice above the question: the DST day (`read-only`), the round's non-default rules
   * (`strong`, Paper `config-warning`), or a config that doesn't match the chain (`refusal`, Paper
   * `stakes-entry/mismatch`, which also disables the CTA).
   */
  notice?: TodayNotice | null;
  /** Between the hint and the countdown, where the stake selector sits: the verify callout. */
  callout?: ReactNode;
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
  /** "Seal my pick", or "Verify with Coinbase" for an unverified player on Stakes. */
  onSeal?: () => void;
  /** The primary action's label; "Seal my pick" unless the screen says otherwise. */
  ctaLabel?: string;
  /** What the CTA reads while it works: "Sealing" (Free) or "Confirming" (Stakes). */
  ctaLoadingLabel?: string;
  /** The note under the CTA while it works; the Free sealing note unless the screen says otherwise. */
  workingNote?: string;
  /** Keeps "Seal my pick" disabled even with a pick (offline, or no entry flow). */
  sealDisabled?: boolean;
  /** The pick is being sealed: the CTA spins, the other option is disabled, the sealing note shows. */
  sealing?: boolean;
  /** A failed or refused entry, above the CTA. `onRetry` only when retrying can help. */
  error?: { message: string; onRetry?: () => void } | null;
}

/** The notice's mark: a clock for the DST day, an info mark for rules, the error mark for a refusal. */
function NoticeMark({ variant, className }: { variant: string; className?: string }) {
  if (variant === 'refusal') return <ErrorIcon className={className} />;
  if (variant === 'strong') return <NoticeInfoIcon className={className} />;
  return <NoticeClockIcon className={className} />;
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
  stakesStake = null,
  notice = null,
  callout = null,
  lastRound,
  remainingMs,
  entrants,
  pool,
  live,
  signedIn,
  onSignIn,
  onSeal,
  ctaLabel = 'Seal my pick',
  ctaLoadingLabel = 'Sealing',
  workingNote = SEALING_NOTE,
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
        <div
          className={s.notice}
          data-variant={notice.variant ?? 'read-only'}
          role={notice.variant === 'refusal' ? 'alert' : 'note'}
        >
          <NoticeMark variant={notice.variant ?? 'read-only'} className={s.noticeIcon} />
          <div className={s.noticeText}>
            <p className="type-body-strong">{notice.title}</p>
            <p className={s.noticeBody}>{notice.body}</p>
            {notice.link ? (
              <button type="button" className={s.noticeLink} onClick={notice.link.onClick}>
                {notice.link.label}
              </button>
            ) : null}
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
      {mode === 'stakes' && stakesStake ? (
        <StakeSelector
          mode="stakes"
          stake={stakesStake.stake}
          dailyCap={stakesStake.dailyCap}
          overCap={stakesStake.overCap}
        />
      ) : null}
      {callout}
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
          disabled={(pick === null && !callout) || sealDisabled}
          loading={sealing}
          loadingLabel={ctaLoadingLabel}
          onClick={onSeal}
        >
          {ctaLabel}
        </Button>
      ) : (
        <Button className={s.cta} onClick={onSignIn}>
          Sign in to play
        </Button>
      )}
      {sealing ? (
        <p className={s.note}>{workingNote}</p>
      ) : !signedIn && mode === 'free' ? (
        <p className={`${s.note} ${s.freeNote}`}>{FREE_NOTE}</p>
      ) : null}
    </>
  );
}
