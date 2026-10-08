// Fake users and session injection. The real session middleware (src/auth/session.ts) sets `user`
// and `session`; tests put the same values in place with `injectSession`, wrap a sub-app with
// `withSession`, or create a real session row with `realSession` and send its cookie or token.
import { Hono, type MiddlewareHandler } from 'hono';
import { createSession, sessionCookieName } from '../../src/auth/session.js';
import type { Env } from '../../src/env.js';
import type { AppEnv, SessionInfo, SessionUser } from '../../src/lib/auth-context.js';
import { notFound, onError } from '../../src/lib/errors.js';
import { FIXTURE_IDS } from './db.js';

export function fakeUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: FIXTURE_IDS.user,
    status: 'active',
    role: 'user',
    personId: null,
    kycStatus: null,
    ...overrides,
  };
}

export function fakeAdmin(overrides: Partial<SessionUser> = {}): SessionUser {
  return fakeUser({ id: FIXTURE_IDS.admin, role: 'admin', ...overrides });
}

export function fakeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { idHash: `0x${'ab'.repeat(32)}`, kind: 'cookie', ...overrides };
}

/** Test-only middleware standing in for the session middleware. */
export function injectSession(
  user: SessionUser | undefined,
  session: SessionInfo | undefined = user ? fakeSession() : undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (user) c.set('user', user);
    if (session) c.set('session', session);
    await next();
  };
}

/**
 * A test app: the session injection, then `sub` mounted at `prefix`, with the real error handlers.
 * Call it with `app.request(path, init, env)`.
 */
export function withSession(
  sub: Hono<AppEnv>,
  user?: SessionUser,
  opts: { prefix?: string; session?: SessionInfo } = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(notFound);
  app.use('*', injectSession(user, opts.session ?? (user ? fakeSession() : undefined)));
  app.route(opts.prefix ?? '/', sub);
  return app;
}

/** A real session: its row is in D1 and `headers` carry it the way a client would. */
export interface RealSession {
  token: string;
  idHash: string;
  expiresAt: number;
  headers: Record<string, string>;
}

/**
 * Inserts a real session for `userId` (through src/auth/session.ts) and returns request headers
 * that carry it: a `Cookie` for `cookie`, an `Authorization: Bearer` header for `bearer`. Requests
 * then go through the real session middleware (`app.request(path, { headers }, env)`).
 */
export async function realSession(
  env: Env,
  userId: string,
  kind: SessionInfo['kind'] = 'cookie',
): Promise<RealSession> {
  const s = await createSession(env, userId, 'vitest');
  const headers: Record<string, string> =
    kind === 'cookie'
      ? { Cookie: `${sessionCookieName(env)}=${s.token}` }
      : { Authorization: `Bearer ${s.token}` };
  return { ...s, headers };
}
