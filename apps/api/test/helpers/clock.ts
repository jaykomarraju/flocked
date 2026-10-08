// Fixed clock: an env whose src/lib/clock.ts `now()` returns `ms` (ENVIRONMENT forced to local,
// the only environment where FLOCKED_TEST_CLOCK is honoured).
import type { Env } from '../../src/env.js';

/** 2026-10-08T12:00:00-04:00: inside the fixture daily round (test/helpers/db.ts). */
export const FIXED_NOW = Date.UTC(2026, 9, 8, 16, 0, 0);

export function withFixedClock<E extends Env>(env: E, ms: number = FIXED_NOW): E {
  return { ...env, ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(ms) };
}
