// The countdown (Paper Components › Round status › Countdown): a label-role line ("Closes in",
// "Reveal in") over the time in numberXL with tabular figures. Today counts to close and Sealed to the
// reveal as hh:mm:ss, keeping the 00 under an hour so the width never shifts. The unsealing countdown
// after close is m:ss ("Unsealing in 1:42"): the beacon delay is at most 600 s, so it never passes 10:00.
//
// A pure display of a remaining time: it runs no timer. The screen ticks `remainingMs`.
import { useId } from 'react';
import s from './Countdown.module.css';

/** `hms`: hh:mm:ss (to close, to the reveal). `ms`: m:ss, at most 10:00 (unsealing). */
export type CountdownStyle = 'hms' | 'ms';

/** The unsealing countdown never shows more than this (the beacon delay is at most 600 s). */
export const UNSEALING_MAX_SECONDS = 600;

/** Whole seconds left: rounded up, so 00:00:00 shows only once the time is actually up. */
function secondsLeft(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A remaining time as countdown text. `hms`: "04:12:37", "00:00:42" (hours keep two digits and grow
 * past 99 if they must). `ms`: "1:42", capped at "10:00". Negative or non-finite times read as zero.
 */
export function formatCountdown(ms: number, style: CountdownStyle = 'hms'): string {
  const total = secondsLeft(ms);
  if (style === 'ms') {
    const capped = Math.min(total, UNSEALING_MAX_SECONDS);
    return `${Math.floor(capped / 60)}:${pad(capped % 60)}`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${pad(hours)}:${pad(minutes)}:${pad(total % 60)}`;
}

/** The same time as an ISO 8601 duration for `<time dateTime>`: "PT4H12M37S". */
export function countdownDuration(ms: number, style: CountdownStyle = 'hms'): string {
  let total = secondsLeft(ms);
  if (style === 'ms') total = Math.min(total, UNSEALING_MAX_SECONDS);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `PT${hours}H${minutes}M${total % 60}S`;
}

export interface CountdownProps {
  /** The line above the time, which also names the timer: "Closes in", "Reveal in", "Unsealing in". */
  label: string;
  /** Time left in ms. Zero or less shows zero. */
  remainingMs: number;
  style?: CountdownStyle;
  className?: string;
}

export function Countdown({ label, remainingMs, style = 'hms', className }: CountdownProps) {
  const labelId = useId();
  return (
    <div
      role="timer"
      aria-labelledby={labelId}
      className={className ? `${s.countdown} ${className}` : s.countdown}
    >
      <span id={labelId} className="type-label">
        {label}
      </span>
      <time className="type-number-xl" dateTime={countdownDuration(remainingMs, style)}>
        {formatCountdown(remainingMs, style)}
      </time>
    </div>
  );
}
