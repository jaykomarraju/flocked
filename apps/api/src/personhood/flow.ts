// `POST /me/personhood` and `GET /me/personhood/callback` (spec "Identity and personhood" ›
// Personhood › Flow and State). The state is 32 random bytes, sent to Coinbase in the clear and
// stored only as its SHA-256 in an AuthDO instance with the starting user's ID and the PKCE
// verifier. The callback consumes it once and attributes the result to that user only, whatever
// session cookie arrives with it (login CSRF, ID-3). Tokens never outlive the callback.
import type {
  PersonhoodCallbackQuery,
  PersonhoodCallbackResponse,
  StartPersonhoodResponse,
} from '@flocked/shared';
import { randomToken, sha256Hex } from '../auth/crypto.js';
import { authDOFor } from '../do/auth-do.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import {
  CoinbaseError,
  authorizeUrl,
  exchangeCode,
  fetchCoinbaseUserId,
  fetchPersonLocation,
  personIdFor,
  pkcePair,
} from './coinbase.js';
import { OAUTH_STATE_TTL_MS, personIdKey, type PersonhoodEnv } from './config.js';
import { applyVerification, failed } from './verify.js';

/** Starts a Coinbase sign-in for `userId`: binds a fresh state and returns the authorize URL. */
export async function startPersonhood(
  env: PersonhoodEnv,
  userId: string,
): Promise<StartPersonhoodResponse> {
  personIdKey(env); // refuse to start a flow that could not finish
  const state = randomToken(32);
  const stateHash = await sha256Hex(state);
  const { verifier, challenge } = await pkcePair();
  const url = authorizeUrl(env, state, challenge);
  await authDOFor(env, 'oauth', stateHash).bindOAuthState({
    stateHash,
    userId,
    codeVerifier: verifier,
    expiresAt: now(env) + OAUTH_STATE_TTL_MS,
  });
  return { authorizeUrl: url };
}

/**
 * Finishes a Coinbase sign-in. Failures are outcomes, not errors: the browser is redirected back
 * to the app either way, so nothing here throws for a user-caused or Coinbase-caused failure.
 */
export async function completePersonhood(
  env: PersonhoodEnv,
  query: PersonhoodCallbackQuery,
): Promise<{ outcome: PersonhoodCallbackResponse; userId: string | null }> {
  const stateHash = await sha256Hex(query.state);
  const consumed = await authDOFor(env, 'oauth', stateHash).consumeOAuthState(stateHash);
  if (!consumed.ok) {
    log.warn('personhood_state_rejected', { reason: consumed.reason });
    return { outcome: failed('invalid_state'), userId: null };
  }
  const userId = consumed.userId;
  if (query.error || !query.code) {
    // The user declined, or Coinbase refused the request. The state is spent either way.
    log.info('personhood_denied', { userId });
    return { outcome: failed('denied'), userId };
  }
  try {
    const token = await exchangeCode(env, query.code, consumed.codeVerifier);
    const coinbaseUserId = await fetchCoinbaseUserId(env, token);
    const personId = await personIdFor(env, coinbaseUserId);
    const location = await fetchPersonLocation(env, token);
    const outcome = await applyVerification(env, userId, personId, location, now(env));
    return { outcome, userId };
  } catch (err) {
    if (err instanceof CoinbaseError) return { outcome: failed('coinbase_error'), userId };
    if (err instanceof HttpError && err.code === 'unavailable') {
      return { outcome: failed('unavailable'), userId };
    }
    throw err;
  }
}
