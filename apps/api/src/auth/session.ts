// Sessions (spec "API": HttpOnly SameSite=Lax cookie on the web, a Bearer token in the mini app;
// "Data model" `sessions`: the cookie or token holds the unhashed ID). Session IDs are 256 random
// bits; D1 stores only their SHA-256.
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import type { AppEnv, SessionInfo, SessionUser } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { secureCookies } from './config.js';
import { randomToken, sha256Hex } from './crypto.js';

/** Sessions last 30 days from sign-in (no sliding renewal). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** At most this much of the User-Agent is kept. */
const USER_AGENT_MAX = 256;

/** Session tokens are base64url of 32 bytes. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type SessionKind = SessionInfo['kind'];

/** The cookie's base name; Hono adds the `__Host-` prefix when cookies are secure. */
const COOKIE = 'flocked_session';

/** The cookie name as sent by browsers. */
export function sessionCookieName(env: Pick<Env, 'ENVIRONMENT'>): string {
  return secureCookies(env) ? `__Host-${COOKIE}` : COOKIE;
}

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(`session:${token}`);
}

export interface NewSession {
  token: string;
  idHash: string;
  expiresAt: number;
}

/** Inserts a session for `userId` and returns its token (shown once, never stored). */
export async function createSession(
  env: Env,
  userId: string,
  userAgent: string | undefined,
): Promise<NewSession> {
  const t = now(env);
  const token = randomToken(32);
  const idHash = await hashSessionToken(token);
  const expiresAt = t + SESSION_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO sessions (id_hash, user_id, expires_at, created_at, user_agent) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(idHash, userId, expiresAt, t, userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null)
    .run();
  return { token, idHash, expiresAt };
}

/** Sets the session cookie on the response. */
export function setSessionCookie(c: Context<AppEnv>, session: NewSession): void {
  const secure = secureCookies(c.env);
  setCookie(c, COOKIE, session.token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    ...(secure ? { prefix: 'host' as const } : {}),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  const secure = secureCookies(c.env);
  deleteCookie(c, COOKIE, {
    path: '/',
    secure,
    httpOnly: true,
    sameSite: 'Lax',
    ...(secure ? { prefix: 'host' as const } : {}),
  });
}

export async function deleteSession(env: Pick<Env, 'DB'>, idHash: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?1').bind(idHash).run();
}

/** The presented token: a Bearer header wins over the cookie and never falls back to it. */
function presentedToken(c: Context<AppEnv>): { token: string; kind: SessionKind } | null {
  const authz = c.req.header('Authorization');
  if (authz !== undefined) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authz);
    return m?.[1] ? { token: m[1], kind: 'bearer' } : null;
  }
  if (c.req.header('Cookie') === undefined) return null;
  const cookie = secureCookies(c.env) ? getCookie(c, COOKIE, 'host') : getCookie(c, COOKIE);
  return cookie ? { token: cookie, kind: 'cookie' } : null;
}

interface SessionRow {
  user_id: string;
  expires_at: number;
  status: SessionUser['status'];
  role: SessionUser['role'];
  person_id: string | null;
  kyc_status: string | null;
}

/**
 * Resolves the cookie or Bearer token and sets `user` and `session` (wave-3 "Session middleware
 * contract"). A missing, malformed, unknown or expired token leaves both unset; `requireUser`
 * then answers 401. Sessions of merged or deleted accounts never authenticate. A stale cookie is
 * cleared on the response.
 */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const presented = presentedToken(c);
  if (presented && TOKEN_RE.test(presented.token)) {
    const idHash = await hashSessionToken(presented.token);
    const row = await c.env.DB.prepare(
      'SELECT s.user_id, s.expires_at, u.status, u.role, u.person_id, u.kyc_status ' +
        'FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?1',
    )
      .bind(idHash)
      .first<SessionRow>();
    if (
      row &&
      row.expires_at > now(c.env) &&
      (row.status === 'active' || row.status === 'suspended')
    ) {
      c.set('user', {
        id: row.user_id,
        status: row.status,
        role: row.role,
        personId: row.person_id,
        kycStatus: row.kyc_status,
      });
      c.set('session', { idHash, kind: presented.kind });
    } else if (presented.kind === 'cookie') {
      clearSessionCookie(c);
    }
  } else if (presented?.kind === 'cookie') {
    clearSessionCookie(c);
  }
  await next();
};
