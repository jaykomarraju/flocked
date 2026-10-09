// Sign-in configuration read from vars (src/env.ts). A missing var is a deployment error: the
// routes that need it answer 503 `unavailable` and log which var is missing.
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';

/** Farcaster's Quick Auth server: the JWT issuer, with its JWKS at `/.well-known/jwks.json`. */
export const FARCASTER_AUTH_ORIGIN = 'https://auth.farcaster.xyz';

function missing(name: string): never {
  log.error('auth_config_missing', { var: name });
  throw new HttpError('unavailable', 'Sign-in is not configured');
}

/** `APP_ORIGIN` parsed: `host` is the SIWE domain and the Quick Auth audience. */
export function appOrigin(env: Pick<Env, 'APP_ORIGIN'>): { origin: string; host: string } {
  const raw = env.APP_ORIGIN;
  if (!raw) return missing('APP_ORIGIN');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return missing('APP_ORIGIN');
  }
  return { origin: url.origin, host: url.host };
}

export function tosVersion(env: Pick<Env, 'TOS_VERSION'>): string {
  return env.TOS_VERSION || missing('TOS_VERSION');
}

export function emailFrom(env: Pick<Env, 'EMAIL_FROM'>): string {
  return env.EMAIL_FROM || missing('EMAIL_FROM');
}

/** The Quick Auth origin: Farcaster's, or the e2e mock's when ENVIRONMENT is 'local'. */
export function farcasterAuthOrigin(
  env: Pick<Env, 'ENVIRONMENT' | 'FARCASTER_AUTH_ORIGIN'>,
): string {
  if (env.ENVIRONMENT === 'local' && env.FARCASTER_AUTH_ORIGIN) return env.FARCASTER_AUTH_ORIGIN;
  return FARCASTER_AUTH_ORIGIN;
}

/** Cookies are `Secure` with the `__Host-` prefix everywhere but local (plain-http dev servers). */
export function secureCookies(env: Pick<Env, 'ENVIRONMENT'>): boolean {
  return env.ENVIRONMENT !== 'local';
}
