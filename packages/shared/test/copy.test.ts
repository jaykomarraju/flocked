import { describe, expect, it } from 'vitest';

import { BRAND, formatShare, lossLine, VOICE, winLine } from '../src/index';

describe('brand vocabulary ("Overview": Brand vocabulary)', () => {
  it('has every term from the spec', () => {
    expect(Object.values(BRAND)).toEqual([
      'The Flock',
      'Got flocked',
      'Strays',
      'Unflocked',
      'Stray streak',
      'Play streak',
      'Game day',
    ]);
  });
});

describe('voice (Design_Language.md "Voice")', () => {
  it('never uses exclamation points', () => {
    for (const line of [...Object.values(VOICE), winLine(12, 100), lossLine(88, 100)]) {
      expect(line).not.toContain('!');
    }
  });

  it('templates reproduce the documented lines', () => {
    expect(winLine(38, 100)).toBe(VOICE.win);
    expect(lossLine(61, 100)).toBe(VOICE.loss);
  });
});

describe('share percentages (Decision log, Oct 7, 2026)', () => {
  // [count, total, win, loss]: 0, 1, 49.5, 50.5, 99 and 100%, plus the extremes and exact halves.
  const cases: [number, number, string, string][] = [
    [0, 200, '0%', '0%'],
    [1, 1000, '<1%', '<1%'],
    [1, 200, '<1%', '<1%'],
    [2, 200, '1%', '1%'],
    [3, 200, '1%', '2%'],
    [99, 200, '49%', '50%'],
    [100, 200, '50%', '50%'],
    [101, 200, '50%', '51%'],
    [197, 200, '98%', '99%'],
    [198, 200, '99%', '99%'],
    [199, 200, '>99%', '>99%'],
    [999, 1000, '>99%', '>99%'],
    [200, 200, '100%', '100%'],
    [1, 3, '33%', '34%'],
    [2, 3, '66%', '67%'],
  ];

  it.each(cases)('%i of %i reads %s as a win and %s as a loss', (count, total, win, loss) => {
    expect(formatShare(count, total, 'win')).toBe(win);
    expect(formatShare(count, total, 'loss')).toBe(loss);
  });

  it('a winning (minority) share never reads 50% or more, and a losing one never below 51%', () => {
    for (let total = 3; total <= 400; total++) {
      for (let count = 1; count < total; count++) {
        if (count * 2 < total) {
          const win = formatShare(count, total, 'win');
          if (win !== '<1%') expect(parseInt(win, 10)).toBeLessThan(50);
        }
        if (count * 2 > total) {
          const loss = formatShare(count, total, 'loss');
          if (loss !== '>99%') expect(parseInt(loss, 10)).toBeGreaterThanOrEqual(51);
        }
      }
    }
  });

  it('the lines use the formatted share', () => {
    expect(winLine(1, 400)).toBe('Unflocked. You and <1% of people out-thought everyone.');
    expect(lossLine(399, 400)).toBe('You got flocked. >99% thought the same thing you did.');
  });

  it('rejects counts outside 0..total and non-integers', () => {
    for (const [count, total] of [
      [-1, 10],
      [11, 10],
      [1, 0],
      [0.5, 10],
      [1, Number.NaN],
    ] as const) {
      expect(() => formatShare(count, total, 'win')).toThrow(RangeError);
    }
  });
});
