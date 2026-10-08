// The one clock for server code (plan P2.4). Tests and the local e2e stack pin time through
// FLOCKED_TEST_CLOCK (epoch ms), which is honoured only when ENVIRONMENT is 'local', so a stray
// var in staging or production can never move the game clock.
import type { Env } from '../env.js';

export type ClockEnv = Pick<Env, 'ENVIRONMENT' | 'FLOCKED_TEST_CLOCK'>;

const EPOCH_MS = /^(0|[1-9][0-9]{0,15})$/;

/** Current time in epoch milliseconds. */
export function now(env: ClockEnv): number {
  if (env.ENVIRONMENT === 'local' && env.FLOCKED_TEST_CLOCK !== undefined) {
    const raw = env.FLOCKED_TEST_CLOCK.trim();
    if (raw !== '') {
      const ms = Number(raw);
      if (!EPOCH_MS.test(raw) || !Number.isSafeInteger(ms)) {
        throw new RangeError('FLOCKED_TEST_CLOCK must be epoch milliseconds');
      }
      return ms;
    }
  }
  return Date.now();
}

/** Current time in Unix seconds (beacon math; spec "Data model" timestamps paragraph). */
export function nowSeconds(env: ClockEnv): number {
  return Math.floor(now(env) / 1000);
}
