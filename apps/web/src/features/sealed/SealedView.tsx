// Sealed (Paper Core flow `core/sealed/{pick-known,pick-lost}/*`; spec "Client app" › Sealed; "Sealed
// picks" › Client requirements): the date and the mode toggle, the question, the padlock badge, the
// locked pick and stake (or "Pick not on this device" when this device lost it), the voice line, the
// countdown to the reveal with the live counter, "Remind me" and "Invite friends". A receipt that failed
// its checks shows the error box under the pick (kept on the device as evidence).
// Presentational, like TodayView: the live screen and the design sheets feed it plain props.
import { VOICE } from '@flocked/shared';
import type { Breakpoint } from '../../theme';
import { Button } from '../../ui/Button';
import { Countdown } from '../../ui/Countdown';
import { EntrantCounter } from '../../ui/EntrantCounter';
import { ErrorBox } from '../../ui/ErrorBox';
import { ModeToggle, type Mode } from '../../ui/ModeToggle';
import { SealedBadge } from '../../ui/SealedBadge';
import { SealedPick } from '../../ui/SealedPick';
import { PICK_LOST } from '../reveal/copy';
import s from './SealedView.module.css';

/** The line under a pick this device doesn't remember (Paper `core/sealed/pick-lost`). */
export const PICK_LOST_LINE =
  "Your pick is sealed, but this device doesn't remember it. It shows up at the reveal.";

export interface SealedViewProps {
  breakpoint: Breakpoint;
  date: string;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  stakesAvailable?: boolean;
  question: string;
  /** The picked option's text, or null when this device doesn't have the pick. */
  pick: string | null;
  /** Points (Free) or USDC base units (Stakes). */
  stake: bigint;
  /** Time left until the reveal (the beacon), ms. */
  revealInMs: number;
  entrants: number;
  pool: bigint;
  live: boolean;
  /** The receipt failed its checks: what the error box says. */
  mismatch?: string | null;
  onRemind?: () => void;
  onInvite?: () => void;
}

export function SealedView({
  breakpoint,
  date,
  mode,
  onModeChange,
  stakesAvailable = true,
  question,
  pick,
  stake,
  revealInMs,
  entrants,
  pool,
  live,
  mismatch = null,
  onRemind,
  onInvite,
}: SealedViewProps) {
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
      <h1 className={s.question} data-breakpoint={breakpoint}>
        {question}
      </h1>
      <div className={s.sealed}>
        <SealedBadge />
        <SealedPick option={pick ?? PICK_LOST} mode={mode} stake={stake} />
        <p className={`type-body ${s.line}`}>{pick === null ? PICK_LOST_LINE : VOICE.sealed}</p>
        {mismatch ? <ErrorBox message={mismatch} /> : null}
      </div>
      <div className={s.status} data-breakpoint={breakpoint}>
        <Countdown label="Reveal in" remainingMs={revealInMs} />
        <EntrantCounter
          mode={mode}
          entrants={entrants}
          pool={pool}
          live={live}
          className={s.counter}
        />
      </div>
      <div className={s.actions}>
        <Button variant="secondary" onClick={onRemind}>
          Remind me
        </Button>
        <Button variant="secondary" onClick={onInvite}>
          Invite friends
        </Button>
      </div>
    </>
  );
}
