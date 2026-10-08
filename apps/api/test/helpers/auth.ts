// Fake users and session injection. W3-A's real session middleware sets `user` and `session`; tests
// put the same values in place with `injectSession`, or wrap a sub-app with `withSession`.
import { Hono, type MiddlewareHandler } from 'hono';
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

/** Test-only middleware standing in for W3-A's session middleware. */
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
