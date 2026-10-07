import { describe, expect, it } from 'vitest';
import type { DrandChain } from '../src/index.js';
import {
  MAX_BEACON_DELAY,
  MIN_BEACON_DELAY,
  QUICKNET,
  beaconTime,
  checkTargetRound,
  firstRoundAtOrAfter,
  isDailyClose,
} from '../src/index.js';

const G = QUICKNET.genesis;

describe('beacon math', () => {
  it('beaconTime is genesis + (round − 1) × period and refuses round 0, like the contract', () => {
    expect(beaconTime(QUICKNET, 1)).toBe(G);
    expect(beaconTime(QUICKNET, 32_870_075)).toBe(G + 32_870_074 * 3);
    for (const r of [0, -1, 1.5]) expect(() => beaconTime(QUICKNET, r)).toThrow(RangeError);
  });

  it('firstRoundAtOrAfter rounds up to the next round time', () => {
    expect(firstRoundAtOrAfter(QUICKNET, 0)).toBe(1);
    expect(firstRoundAtOrAfter(QUICKNET, G)).toBe(1);
    expect(firstRoundAtOrAfter(QUICKNET, G + 1)).toBe(2);
    expect(firstRoundAtOrAfter(QUICKNET, G + 3)).toBe(2);
    expect(firstRoundAtOrAfter(QUICKNET, G + 4)).toBe(3);
    for (let t = G - 5; t < G + 200; t++) {
      const r = firstRoundAtOrAfter(QUICKNET, t);
      expect(beaconTime(QUICKNET, r)).toBeGreaterThanOrEqual(t);
      if (r > 1) expect(beaconTime(QUICKNET, r - 1)).toBeLessThan(t);
    }
  });

  it('works for other periods and refuses non-integer times', () => {
    const c: DrandChain = { ...QUICKNET, genesis: 1000, period: 30 };
    expect(firstRoundAtOrAfter(c, 1001)).toBe(2);
    expect(firstRoundAtOrAfter(c, 1030)).toBe(2);
    expect(firstRoundAtOrAfter(c, 1031)).toBe(3);
    expect(() => firstRoundAtOrAfter(c, 1.5)).toThrow(RangeError);
  });
});

describe('checkTargetRound', () => {
  const closesAt = Date.UTC(2026, 9, 9, 1) / 1000; // 2026-10-08 21:00 EDT
  const ok = (beaconDelay: number) => ({
    chain: QUICKNET,
    closesAt,
    beaconDelay,
    beaconRound: firstRoundAtOrAfter(QUICKNET, closesAt + beaconDelay),
    now: closesAt - 600,
  });

  it('accepts the first round after closesAt + beaconDelay for every delay in bounds', () => {
    for (let d = MIN_BEACON_DELAY; d <= MAX_BEACON_DELAY; d++) {
      const r = checkTargetRound(ok(d));
      const bt = beaconTime(QUICKNET, ok(d).beaconRound);
      expect(r).toEqual(
        bt > closesAt + MAX_BEACON_DELAY ? { ok: false, reason: 'beacon_too_late' } : { ok: true },
      );
    }
  });

  it('reports each error', () => {
    const i = ok(120);
    expect(checkTargetRound({ ...i, beaconRound: 0 })).toEqual({
      ok: false,
      reason: 'invalid_round',
    });
    expect(checkTargetRound({ ...i, beaconRound: i.beaconRound - 30 })).toEqual({
      ok: false,
      reason: 'beacon_too_early',
    });
    expect(checkTargetRound({ ...i, beaconRound: i.beaconRound + 200 })).toEqual({
      ok: false,
      reason: 'beacon_too_late',
    });
    expect(checkTargetRound({ ...i, beaconDelay: 1000 })).toEqual({
      ok: false,
      reason: 'invalid_delay',
    });
    expect(checkTargetRound({ ...i, beaconRound: i.beaconRound + 1 })).toEqual({
      ok: false,
      reason: 'not_first_round',
    });
    expect(checkTargetRound({ ...i, now: closesAt + 1000 })).toEqual({
      ok: false,
      reason: 'beacon_in_past',
    });
    expect(checkTargetRound({ ...i, dailyClose: { gameDay: '2026-10-09' } })).toEqual({
      ok: false,
      reason: 'wrong_daily_close',
    });
    expect(checkTargetRound({ ...i, dailyClose: { gameDay: '2026-10-08' } })).toEqual({ ok: true });
  });

  it('refuses non-integer times as a caller error', () => {
    expect(() => checkTargetRound({ ...ok(120), closesAt: closesAt + 0.5 })).toThrow(RangeError);
    expect(() => checkTargetRound({ ...ok(120), now: Number.NaN })).toThrow(RangeError);
  });
});

describe('isDailyClose: 21:00 America/New_York across DST', () => {
  const at = (y: number, m: number, d: number, h: number) => Date.UTC(y, m - 1, d, h) / 1000;
  it.each([
    ['2026-10-08', at(2026, 10, 9, 1)], // EDT
    ['2026-12-01', at(2026, 12, 2, 2)], // EST
    ['2026-03-08', at(2026, 3, 9, 1)], // spring forward that morning (23 h day)
    ['2026-11-01', at(2026, 11, 2, 2)], // fall back that morning (25 h day)
    ['2027-03-14', at(2027, 3, 15, 1)],
  ])('%s', (day, t) => {
    expect(isDailyClose(t, day)).toBe(true);
    expect(isDailyClose(t + 1, day)).toBe(false);
    expect(isDailyClose(t - 3600, day)).toBe(false);
    expect(isDailyClose(t + 3600, day)).toBe(false);
  });
  it('rejects malformed game days', () => {
    expect(isDailyClose(at(2026, 10, 9, 1), '2026-10-8')).toBe(false);
    expect(isDailyClose(at(2026, 10, 9, 1), '')).toBe(false);
  });
});
