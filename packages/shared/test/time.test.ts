import { isDailyClose } from '@flocked/tlock';
import { describe, expect, it } from 'vitest';

import {
  addGameDays,
  dailyClosesAt,
  dailyOpensAt,
  gameDayOf,
  isGameDay,
  isoWeekOf,
  openGameDayAt,
} from '../src/time';

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const HOUR = 3600;

/** Every calendar day from `from` to `to` inclusive. */
function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addGameDays(d, 1)) out.push(d);
  return out;
}
const ALL = days('2026-01-01', '2030-12-31');

describe('fixed instants', () => {
  it('21:00 EDT and EST', () => {
    expect(iso(dailyClosesAt('2026-10-07'))).toBe('2026-10-08T01:00:00.000Z');
    expect(dailyClosesAt('2026-10-07')).toBe(1_791_421_200);
    expect(iso(dailyOpensAt('2026-10-07'))).toBe('2026-10-07T01:00:00.000Z');
    expect(iso(dailyClosesAt('2026-12-25'))).toBe('2026-12-26T02:00:00.000Z');
    expect(gameDayOf(1_791_421_200)).toBe('2026-10-07');
  });
});

describe('DST change days (US: second Sunday of March, first Sunday of November)', () => {
  it.each([
    ['2026-03-08', 23, '2026-03-08T02:00:00.000Z', '2026-03-09T01:00:00.000Z'],
    ['2026-11-01', 25, '2026-11-01T01:00:00.000Z', '2026-11-02T02:00:00.000Z'],
    ['2027-03-14', 23, '2027-03-14T02:00:00.000Z', '2027-03-15T01:00:00.000Z'],
    ['2027-11-07', 25, '2027-11-07T01:00:00.000Z', '2027-11-08T02:00:00.000Z'],
  ])('%s round lasts %i h', (day, hours, opens, closes) => {
    expect(iso(dailyOpensAt(day))).toBe(opens);
    expect(iso(dailyClosesAt(day))).toBe(closes);
    expect(dailyClosesAt(day) - dailyOpensAt(day)).toBe(hours * HOUR);
  });

  it('every other round lasts 24 h; one 23 h and one 25 h round per year, 2026–2030', () => {
    const odd = ALL.filter((d) => dailyClosesAt(d) - dailyOpensAt(d) !== 24 * HOUR);
    expect(odd).toEqual([
      '2026-03-08',
      '2026-11-01',
      '2027-03-14',
      '2027-11-07',
      '2028-03-12',
      '2028-11-05',
      '2029-03-11',
      '2029-11-04',
      '2030-03-10',
      '2030-11-03',
    ]);
  });
});

describe('every game day 2026–2030', () => {
  it('round-trips and agrees with @flocked/tlock isDailyClose', () => {
    for (const d of ALL) {
      const closes = dailyClosesAt(d);
      expect(gameDayOf(closes)).toBe(d);
      expect(isDailyClose(closes, d)).toBe(true);
      expect(isDailyClose(closes - 1, d)).toBe(false);
      expect(isDailyClose(closes + 1, d)).toBe(false);
      expect(isDailyClose(closes, addGameDays(d, 1))).toBe(false);
      expect(dailyOpensAt(d)).toBe(dailyClosesAt(addGameDays(d, -1)));
      expect(openGameDayAt(dailyOpensAt(d))).toBe(d);
      expect(openGameDayAt(closes - 1)).toBe(d);
      expect(openGameDayAt(closes)).toBe(addGameDays(d, 1));
      expect(addGameDays(addGameDays(d, 1), -1)).toBe(d);
    }
  });

  it('ISO weeks run Monday to Sunday', () => {
    for (const d of ALL) {
      const next = addGameDays(d, 1);
      const isSunday = new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
      expect(isoWeekOf(next) !== isoWeekOf(d)).toBe(isSunday);
    }
  });
});

describe('isoWeekOf', () => {
  it.each([
    ['2026-01-01', '2026-W01'],
    ['2025-12-29', '2026-W01'],
    ['2026-10-07', '2026-W41'],
    ['2026-12-31', '2026-W53'],
    ['2027-01-03', '2026-W53'],
    ['2027-01-04', '2027-W01'],
    ['2021-01-03', '2020-W53'],
    ['2024-12-30', '2025-W01'],
    ['2028-01-01', '2027-W52'],
  ])('%s → %s', (day, week) => {
    expect(isoWeekOf(day)).toBe(week);
  });
});

describe('game day strings', () => {
  it('isGameDay accepts only real YYYY-MM-DD dates', () => {
    expect(isGameDay('2028-02-29')).toBe(true);
    expect(isGameDay('2026-02-29')).toBe(false);
    expect(isGameDay('2026-13-01')).toBe(false);
    expect(isGameDay('2026-1-01')).toBe(false);
    expect(isGameDay('2026-10-07T00:00')).toBe(false);
    expect(isGameDay(20261007)).toBe(false);
  });

  it('addGameDays crosses months, years and leap days', () => {
    expect(addGameDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addGameDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addGameDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addGameDays('2026-10-07', 0)).toBe('2026-10-07');
    expect(addGameDays('2026-10-07', 365)).toBe('2027-10-07');
  });

  it('throws on bad input', () => {
    expect(() => dailyClosesAt('2026-02-30')).toThrow(RangeError);
    expect(() => addGameDays('2026-10-07', 0.5)).toThrow(RangeError);
    expect(() => gameDayOf(-1)).toThrow(RangeError);
    expect(() => gameDayOf(1.5)).toThrow(RangeError);
    expect(() => isoWeekOf('nope')).toThrow(RangeError);
  });
});
