import type { SettleParams } from './types.js';

export const BPS = 10_000n;

export interface BigParams {
  feeBps: bigint;
  creatorBps: bigint;
  capMultiple: bigint;
  minEntrants: bigint;
  creatorAwardBps: bigint;
  countQualifyingOnly: boolean;
}

function count(name: string, value: number, min: number, max: number): bigint {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
  return BigInt(value);
}

/** Validates params and lifts them to bigint so no settlement arithmetic ever touches `number`. */
export function toBigParams(p: SettleParams): BigParams {
  const feeBps = count('feeBps', p.feeBps, 0, 10_000);
  const creatorBps = count('creatorBps', p.creatorBps, 0, 10_000);
  if (feeBps + creatorBps > BPS) {
    throw new RangeError(`feeBps + creatorBps must be <= 10000, got ${feeBps + creatorBps}`);
  }
  return {
    feeBps,
    creatorBps,
    capMultiple: count('capMultiple', p.capMultiple, 1, Number.MAX_SAFE_INTEGER),
    minEntrants: count('minEntrants', p.minEntrants, 0, Number.MAX_SAFE_INTEGER),
    creatorAwardBps: count('creatorAwardBps', p.creatorAwardBps ?? 0, 0, 10_000),
    countQualifyingOnly: p.countQualifyingOnly ?? false,
  };
}
