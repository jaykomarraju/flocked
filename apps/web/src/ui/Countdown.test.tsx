import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Countdown, countdownDuration, formatCountdown } from './Countdown';

const s = (h: number, m: number, sec: number) => (h * 3600 + m * 60 + sec) * 1000;

describe('formatCountdown', () => {
  it('formats hh:mm:ss, keeping the 00 hours under an hour', () => {
    expect(formatCountdown(s(4, 12, 37))).toBe('04:12:37');
    expect(formatCountdown(s(0, 0, 42))).toBe('00:00:42');
    expect(formatCountdown(s(0, 59, 59), 'hms')).toBe('00:59:59');
    expect(formatCountdown(s(23, 0, 0))).toBe('23:00:00');
  });

  it('lets hours grow past two digits rather than wrap', () => {
    expect(formatCountdown(s(120, 5, 9))).toBe('120:05:09');
  });

  it('rounds partial seconds up, so zero shows only when the time is up', () => {
    expect(formatCountdown(41_001)).toBe('00:00:42');
    expect(formatCountdown(1)).toBe('00:00:01');
    expect(formatCountdown(0)).toBe('00:00:00');
  });

  it('reads negative and non-finite times as zero', () => {
    expect(formatCountdown(-5000)).toBe('00:00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00:00');
    expect(formatCountdown(Number.NaN, 'ms')).toBe('0:00');
  });

  it('formats the unsealing countdown as m:ss', () => {
    expect(formatCountdown(s(0, 1, 42), 'ms')).toBe('1:42');
    expect(formatCountdown(s(0, 0, 7), 'ms')).toBe('0:07');
    expect(formatCountdown(s(0, 10, 0), 'ms')).toBe('10:00');
  });

  it('never shows the unsealing countdown above 10:00', () => {
    expect(formatCountdown(s(0, 10, 1), 'ms')).toBe('10:00');
    expect(formatCountdown(s(2, 0, 0), 'ms')).toBe('10:00');
  });

  it('gives the same time as an ISO 8601 duration', () => {
    expect(countdownDuration(s(4, 12, 37))).toBe('PT4H12M37S');
    expect(countdownDuration(s(1, 0, 0), 'ms')).toBe('PT0H10M0S');
  });
});

describe('Countdown', () => {
  it('is a timer named by its label, showing the time', () => {
    render(<Countdown label="Closes in" remainingMs={s(4, 12, 37)} />);
    const timer = screen.getByRole('timer', { name: 'Closes in' });
    expect(timer).toHaveTextContent('04:12:37');
    expect(timer.querySelector('time')).toHaveAttribute('datetime', 'PT4H12M37S');
  });

  it('shows the unsealing countdown as m:ss', () => {
    render(<Countdown label="Unsealing in" remainingMs={s(0, 1, 42)} style="ms" />);
    expect(screen.getByRole('timer', { name: 'Unsealing in' })).toHaveTextContent('1:42');
  });

  it('is a pure display: it shows a new time only when given one', () => {
    const { rerender } = render(<Countdown label="Reveal in" remainingMs={s(0, 0, 42)} />);
    const timer = screen.getByRole('timer', { name: 'Reveal in' });
    expect(timer).toHaveTextContent('00:00:42');
    rerender(<Countdown label="Reveal in" remainingMs={s(0, 0, 41)} />);
    expect(timer).toHaveTextContent('00:00:41');
  });
});
