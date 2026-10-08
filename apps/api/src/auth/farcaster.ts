// Farcaster Quick Auth (mini app sign-in). The client's token is a JWT from Farcaster's auth server:
// issuer = that server's origin, audience = this app's domain, subject = the FID, signed with a key
// from `${origin}/.well-known/jwks.json`. This is what @farcaster/quick-auth's verifyJwt checks;
// the keys are injectable (src/auth/deps.ts) so tests and the e2e mock can sign their own.
import { errors, jwtVerify } from 'jose';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { appOrigin, farcasterAuthOrigin } from './config.js';
import type { AuthDeps } from './deps.js';

/** Farcaster's keys are RSA today; allow the other common JWS algorithms for a key rotation. */
const ALGORITHMS = ['RS256', 'ES256', 'EdDSA'];
const FID_RE = /^[1-9][0-9]{0,15}$/;

/** Errors that mean "this token is not acceptable", as opposed to "we could not check it". */
function isTokenError(err: unknown): boolean {
  return (
    err instanceof errors.JOSEError &&
    !(err instanceof errors.JWKSTimeout) &&
    !(err instanceof errors.JWKSInvalid)
  );
}

/**
 * Verifies a Quick Auth token and returns the FID as a decimal string. Throws 401 `invalid_token`
 * for a bad, expired or foreign token, and 503 `unavailable` when the keys cannot be fetched.
 */
export async function verifyQuickAuth(
  env: Env,
  deps: Pick<AuthDeps, 'farcasterKeys'>,
  token: string,
): Promise<string> {
  const { host } = appOrigin(env);
  let sub: unknown;
  try {
    const { payload } = await jwtVerify(token, deps.farcasterKeys, {
      issuer: farcasterAuthOrigin(env),
      audience: host,
      algorithms: ALGORITHMS,
      requiredClaims: ['sub', 'exp', 'iat'],
      currentDate: new Date(now(env)),
      clockTolerance: 30,
    });
    sub = payload.sub;
  } catch (err) {
    if (isTokenError(err)) {
      throw new HttpError('invalid_token', 'Farcaster token is not valid for this app');
    }
    log.error('farcaster_keys_unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new HttpError('unavailable', 'Could not check the Farcaster token; try again');
  }
  const fid = typeof sub === 'number' ? String(sub) : sub;
  if (typeof fid !== 'string' || !FID_RE.test(fid)) {
    throw new HttpError('invalid_token', 'Farcaster token has no valid FID');
  }
  return fid;
}
