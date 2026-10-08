import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TargetRoundVector } from '../scripts/vectors.js';
import { generateVectors } from '../scripts/vectors.js';
import { QUICKNET, TARGET_ROUND_ERRORS, checkTargetRound } from '../src/index.js';

const file = readFileSync(join(import.meta.dirname, '../vectors/target-round.json'), 'utf8');
const { cases } = JSON.parse(file) as { cases: TargetRoundVector[] };

describe('TL-4 (TypeScript half): target-round vectors', () => {
  it('vectors/target-round.json is fresh (run `pnpm --filter @flocked/tlock vectors`)', () => {
    expect(file).toBe(generateVectors());
  });

  it.each(cases)('$id', (v) => {
    const r = checkTargetRound({
      chain: { ...QUICKNET, genesis: Number(v.genesis), period: Number(v.period) },
      closesAt: Number(v.closesAt),
      beaconDelay: Number(v.beaconDelay),
      beaconRound: Number(v.beaconRound),
      now: Number(v.now),
      ...(v.gameDay ? { dailyClose: { gameDay: v.gameDay } } : {}),
    });
    expect(r).toEqual(v.expectedOk ? { ok: true } : { ok: false, reason: v.reason });
  });

  it('covers every TargetRoundError, both contract reverts, exact bounds and round 0', () => {
    const reasons = new Set(cases.map((c) => c.reason));
    for (const e of TARGET_ROUND_ERRORS) expect(reasons).toContain(e);
    const errors = new Set(cases.map((c) => c.contractError));
    expect([...errors].sort()).toEqual(['', 'BeaconOutOfRange', 'InvalidBeaconRound']);
    expect(cases.some((c) => c.beaconRound === '0')).toBe(true);
    const offset = (c: TargetRoundVector) =>
      Number(c.genesis) + (Number(c.beaconRound) - 1) * Number(c.period) - Number(c.closesAt);
    for (const edge of [59, 60, 600, 601])
      expect(cases.some((c) => c.beaconRound !== '0' && offset(c) === edge)).toBe(true);
  });

  it('the client never accepts what the contract rejects', () => {
    for (const c of cases) if (c.contractError) expect(c.expectedOk).toBe(false);
  });

  it('every field the contract reads is a decimal string', () => {
    for (const c of cases) {
      for (const k of [
        'closesAt',
        'beaconDelay',
        'beaconRound',
        'genesis',
        'period',
        'now',
      ] as const) {
        expect(c[k]).toMatch(/^(0|[1-9][0-9]*)$/);
      }
    }
  });
});
