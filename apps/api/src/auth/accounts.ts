// Accounts behind sign-in identities (spec "Identity and personhood" › Identities). New accounts are
// created only from a Farcaster account or a wallet; `createAccount`'s provider type has no email.
// Creation is one D1 batch: the user, the identity, the signup grant (spec "Modes: Free and
// Stakes": 500 points) through src/points/, and a pending referral when a valid `ref` was carried.
// A new account has no handle until the user picks one with PATCH /me (migration 0002).
import { NotifyMessageSchema, newUlid, type SessionUser as SessionUserView } from '@flocked/shared';
import type { Env } from '../env.js';
import type { SessionUser } from '../lib/auth-context.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { GLOBAL_SCOPE, POINTS, grantMovement } from '../points/index.js';
import { randomString } from './crypto.js';

export type SignInProvider = 'wallet' | 'farcaster' | 'email';
/** Spec: "New accounts are created with Farcaster or a wallet (SIWE)". */
export type CreatingProvider = Exclude<SignInProvider, 'email'>;

export interface UserRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role: SessionUser['role'];
  status: SessionUser['status'];
  merged_into: string | null;
  person_id: string | null;
  kyc_status: string | null;
}

const USER_COLUMNS =
  'u.id, u.handle, u.display_name, u.avatar_url, u.role, u.status, u.merged_into, u.person_id, u.kyc_status';

/** Merges chain at most this deep (a merged account's kept account is normally active). */
const MAX_MERGE_HOPS = 4;

async function userById(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?1`)
    .bind(id)
    .first<UserRow>();
}

/**
 * The account a verified identity signs in to, following merges to the kept account. Null when
 * no verified identity matches. A deleted account answers 403 `account_deleted`.
 */
export async function findAccount(
  db: D1Database,
  provider: SignInProvider,
  externalId: string,
): Promise<UserRow | null> {
  let user = await db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM identities i JOIN users u ON u.id = i.user_id ` +
        'WHERE i.provider = ?1 AND i.external_id = ?2 AND i.verified_at IS NOT NULL',
    )
    .bind(provider, externalId)
    .first<UserRow>();
  for (let hop = 0; user?.status === 'merged' && user.merged_into && hop < MAX_MERGE_HOPS; hop++) {
    user = await userById(db, user.merged_into);
  }
  if (!user) return null;
  if (user.status === 'deleted' || user.status === 'merged') {
    throw new HttpError('account_deleted', 'This account no longer exists');
  }
  return user;
}

/** `users.ref_code`: stable, random, not the handle (Decision log, Oct 7). */
export function generateRefCode(): string {
  return randomString(10, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789');
}

const CREATE_ATTEMPTS = 4;

export interface CreateAccountInput {
  provider: CreatingProvider;
  externalId: string;
  /** Referral code carried into signup; ignored unless it names another active user. */
  ref?: string | undefined;
  now: number;
}

/**
 * Creates the account, identity, signup grant and referral in one batch. If the identity was
 * claimed concurrently, returns that account with `created: false` instead.
 */
export async function createAccount(
  env: Pick<Env, 'DB'>,
  input: CreateAccountInput,
): Promise<{ user: UserRow; created: boolean }> {
  const db = env.DB;
  const { provider, externalId, ref, now } = input;
  for (let attempt = 1; ; attempt++) {
    const userId = newUlid(now);
    const grant = grantMovement(db, {
      userId,
      scope: GLOBAL_SCOPE,
      amount: POINTS.signupGrant,
      reason: 'signup',
      refId: userId,
      now,
    });
    const statements = [
      db
        .prepare('INSERT INTO users (id, ref_code, created_at) VALUES (?1, ?2, ?3)')
        .bind(userId, generateRefCode(), now),
      db
        .prepare(
          'INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, ?3, ?4, ?5)',
        )
        .bind(newUlid(now), userId, provider, externalId, now),
      ...grant.statements,
    ];
    if (ref) {
      statements.push(
        db
          .prepare(
            "INSERT INTO referrals (referrer_user_id, referee_user_id, status, created_at) SELECT id, ?2, 'pending', ?3 " +
              "FROM users WHERE ref_code = ?1 AND status = 'active' AND id <> ?2",
          )
          .bind(ref, userId, now),
      );
    }
    try {
      await db.batch(statements);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed: identities.')) {
        const existing = await findAccount(db, provider, externalId);
        if (existing) return { user: existing, created: false };
      }
      const collision = msg.includes('UNIQUE constraint failed: users.ref_code');
      if (collision && attempt < CREATE_ATTEMPTS) continue;
      throw err;
    }
    const user = await userById(db, userId);
    if (!user) throw new Error('created user not found');
    log.info('account_created', { userId, provider });
    return { user, created: true };
  }
}

/** The `user` of a sign-in response. */
export function sessionUserView(user: UserRow): SessionUserView {
  return {
    id: user.id,
    handle: user.handle,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    role: user.role,
  };
}

export type SecurityNoticeKind =
  'email_sign_in' | 'identity_linked' | 'merge_pending' | 'merge_completed';

/**
 * Enqueues a `security_notice` on the notify queue (spec "API" › Rate limits: every new email
 * sign-in and every newly linked identity sends the user a notice; W9-A delivers it). A queue
 * failure is logged, not raised: the sign-in itself already happened.
 */
export async function enqueueSecurityNotice(
  env: Pick<Env, 'QUEUE_NOTIFY'>,
  userId: string,
  kind: SecurityNoticeKind,
  now: number,
): Promise<void> {
  const noticeId = newUlid(now);
  const message = NotifyMessageSchema.parse({
    event: 'security_notice',
    userId,
    dedupeKey: `security_notice:${noticeId}`,
    payload: { noticeId, kind },
  });
  try {
    await env.QUEUE_NOTIFY.send(message);
  } catch (err) {
    log.error('security_notice_enqueue_failed', {
      userId,
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
