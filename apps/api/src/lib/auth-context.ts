// Request identity for route handlers. W3-A's session middleware resolves the cookie or Bearer token
// and calls `c.set('user', …)` and `c.set('session', …)` (wave-3 pinned contract); route modules only
// read them, through `requireUser` / `optionalUser` / `requireAdmin` and `getUser`.
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';
import { HttpError } from './errors.js';

/** The signed-in user as the session middleware sets it (wave-3 "Session middleware contract"). */
export interface SessionUser {
  id: string;
  status: 'active' | 'suspended' | 'merged' | 'deleted';
  role: 'user' | 'admin';
  /** `users.person_id`, set once Coinbase-verified (spec "Identity and personhood"). */
  personId: string | null;
  /** `users.kyc_status`; verified means personId set and kycStatus === 'verified'. */
  kycStatus: string | null;
}

export interface SessionInfo {
  /** `sessions.id_hash`; the unhashed ID never leaves the cookie or token. */
  idHash: string;
  kind: 'cookie' | 'bearer';
}

/** Hono context variables for this app. */
export interface AppVariables {
  user?: SessionUser;
  session?: SessionInfo;
}

/** Hono environment for every app and sub-app in apps/api. */
export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}

/** The user set by the session middleware, or 401 `unauthorized`. */
export function getUser(c: Context<AppEnv>): SessionUser {
  const user = c.get('user');
  if (!user) throw new HttpError('unauthorized', 'Sign in required');
  return user;
}

/** Rejects the request with 401 unless a signed-in user is present. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  getUser(c);
  await next();
};

/** Lets the request through either way; handlers read `c.get('user')` (possibly undefined). */
export const optionalUser: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};

/** 401 without a user, 403 unless the user has `role = admin` (spec "Admin console"). */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = getUser(c);
  if (user.role !== 'admin') throw new HttpError('forbidden', 'Admin only');
  await next();
};
