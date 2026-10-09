// Route module `auth`: sign-in (SIWE, Farcaster Quick Auth, email codes) and logout (spec "API",
// "Identity and personhood" › Identities). Owner: W3-A. Every unauthenticated endpoint takes a
// token from the caller's per-IP bucket. Accounts are created only by SIWE or Farcaster, behind
// Turnstile; email signs in to an account that already has the address, verified.
import {
  EmailStartRequestSchema,
  EmailVerifyRequestSchema,
  FarcasterAuthRequestSchema,
  SiweVerifyRequestSchema,
  type AuthSessionResponse,
  type EmailStartResponse,
  type LogoutResponse,
  type SessionTransport,
} from '@flocked/shared';
import { Hono, type Context } from 'hono';
import {
  createAccount,
  enqueueSecurityNotice,
  findAccount,
  sessionUserView,
  type CreatingProvider,
  type UserRow,
} from '../auth/accounts.js';
import { authDeps } from '../auth/deps.js';
import { checkEmailCode, emailHash, issueEmailCode, normalizeEmail } from '../auth/email.js';
import { verifyQuickAuth } from '../auth/farcaster.js';
import { clientIp, emailCodeBucket, enforce, limitAuthIp } from '../auth/rate-limit.js';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  setSessionCookie,
} from '../auth/session.js';
import { issueNonce, verifySiwe } from '../auth/siwe.js';
import { requireUser, type AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { validate } from '../lib/validate.js';

type Ctx = Context<AppEnv>;

/** Turnstile on sign-up (spec "Anti-abuse"). */
async function requireTurnstile(c: Ctx, token: string | undefined): Promise<void> {
  if (!token) {
    throw new HttpError('turnstile_failed', 'Complete the human check to create an account');
  }
  const result = await verifyTurnstile(c.env, token, {
    remoteIp: clientIp(c),
    fetch: authDeps(c.env).turnstileFetch,
  });
  if (!result.success) {
    if (result.errorCodes.includes('missing-input-secret')) {
      log.error('turnstile_secret_missing', {});
    }
    throw new HttpError('turnstile_failed', 'The human check failed; try again');
  }
}

/** Starts a session for `user` and answers with it, as a cookie or a Bearer token. */
async function respondWithSession(
  c: Ctx,
  user: UserRow,
  created: boolean,
  transport: SessionTransport,
) {
  const session = await createSession(c.env, user.id, c.req.header('User-Agent'));
  if (transport === 'cookie') setSessionCookie(c, session);
  const body: AuthSessionResponse = {
    user: sessionUserView(user),
    created,
    token: transport === 'bearer' ? session.token : null,
    expiresAt: session.expiresAt,
  };
  return c.json(body);
}

/** Signs in to the identity's account, creating it (behind Turnstile) if there is none. */
async function signInOrCreate(
  c: Ctx,
  provider: CreatingProvider,
  externalId: string,
  body: { turnstileToken?: string | undefined; ref?: string | undefined },
): Promise<{ user: UserRow; created: boolean }> {
  const existing = await findAccount(c.env.DB, provider, externalId);
  if (existing) return { user: existing, created: false };
  await requireTurnstile(c, body.turnstileToken);
  return createAccount(c.env, { provider, externalId, ref: body.ref, now: now(c.env) });
}

/** Runs `task` after the response when the runtime allows (so timing can't reveal that it ran). */
async function inBackground(c: Ctx, what: string, task: () => Promise<unknown>): Promise<void> {
  const run = task().then(
    () => undefined,
    (err: unknown) => {
      log.error(`${what}_failed`, { error: err instanceof Error ? err.message : String(err) });
    },
  );
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    waitUntil = (p) => ctx.waitUntil(p);
  } catch {
    waitUntil = undefined;
  }
  if (waitUntil) waitUntil(run);
  else await run;
}

export const auth = new Hono<AppEnv>();

// Registered in ENDPOINTS order.

auth.post('/auth/siwe/nonce', limitAuthIp, async (c) => c.json(await issueNonce(c.env)));

auth.post(
  '/auth/siwe/verify',
  limitAuthIp,
  validate('json', SiweVerifyRequestSchema),
  async (c) => {
    const body = c.req.valid('json');
    const address = await verifySiwe(c.env, authDeps(c.env), body);
    const { user, created } = await signInOrCreate(c, 'wallet', address, body);
    return respondWithSession(c, user, created, body.transport ?? 'cookie');
  },
);

auth.post(
  '/auth/farcaster',
  limitAuthIp,
  validate('json', FarcasterAuthRequestSchema),
  async (c) => {
    const body = c.req.valid('json');
    const fid = await verifyQuickAuth(c.env, authDeps(c.env), body.token);
    const { user, created } = await signInOrCreate(c, 'farcaster', fid, body);
    return respondWithSession(c, user, created, body.transport ?? 'bearer');
  },
);

// The same answer whether or not the address is linked, so it can't probe for accounts.
auth.post(
  '/auth/email/start',
  limitAuthIp,
  validate('json', EmailStartRequestSchema),
  async (c) => {
    const body = c.req.valid('json');
    const email = normalizeEmail(body.email);
    await enforce(c, emailCodeBucket(await emailHash(email)));
    if (body.turnstileToken !== undefined) await requireTurnstile(c, body.turnstileToken);

    let linked = false;
    try {
      linked = (await findAccount(c.env.DB, 'email', email)) !== null;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
    if (linked) {
      const sender = authDeps(c.env).email;
      await inBackground(c, 'email_code_send', () => issueEmailCode(c.env, sender, email));
    }
    return c.json({ ok: true } satisfies EmailStartResponse);
  },
);

// Signs in only: an address with no account never creates one.
auth.post(
  '/auth/email/verify',
  limitAuthIp,
  validate('json', EmailVerifyRequestSchema),
  async (c) => {
    const body = c.req.valid('json');
    const email = normalizeEmail(body.email);
    await checkEmailCode(c.env, email, body.code);
    const user = await findAccount(c.env.DB, 'email', email);
    if (!user) throw new HttpError('invalid_code', 'No account uses this email address');
    const response = await respondWithSession(c, user, false, body.transport ?? 'cookie');
    await enqueueSecurityNotice(c.env, user.id, 'email_sign_in', now(c.env));
    return response;
  },
);

auth.post('/auth/logout', requireUser, async (c) => {
  const session = c.get('session');
  if (session) await deleteSession(c.env, session.idHash);
  clearSessionCookie(c);
  return c.json({ ok: true } satisfies LogoutResponse);
});
