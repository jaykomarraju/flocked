// Identity test setup: accounts with real sign-in identities (an EOA wallet, a Farcaster FID, an
// email), real sessions, and request helpers for the identity endpoints through the real app.
import { env } from 'cloudflare:test';
import { newUlid, type LinkResult, type Merge } from '@flocked/shared';
import { generatePrivateKey, privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { expect } from 'vitest';
import type { Env } from '../../src/env.js';
import { realSession } from '../helpers/index.js';
import {
  authEnv,
  call,
  quickAuthSigner,
  siweBody,
  type QuickAuthSigner,
  type TestAuth,
} from '../auth/fixtures.js';

export const DAY = 24 * 3600 * 1000;

export interface Account {
  id: string;
  wallet: LocalAccount;
  fid: number;
  headers: Record<string, string>;
}

export interface IdentityTest extends TestAuth {
  fc: QuickAuthSigner;
}

/** The sign-in env with a local Quick Auth signer. */
export async function identityEnv(): Promise<IdentityTest> {
  const fc = await quickAuthSigner();
  return { ...authEnv({ farcasterKeys: fc.keys }), fc };
}

let seq = 0;

/**
 * An active account created `createdAt`, with a verified wallet (its own fresh key) and a
 * verified Farcaster FID, a `global` balance of `points`, and a session.
 */
export async function account(
  t: IdentityTest,
  opts: { createdAt?: number; points?: number; handle?: string | null } = {},
): Promise<Account> {
  const n = ++seq;
  const createdAt = opts.createdAt ?? Date.now() - 30 * DAY;
  const id = newUlid(createdAt);
  const wallet = privateKeyToAccount(generatePrivateKey());
  const fid = 900_000 + n + Math.floor(Math.random() * 50_000) * 100;
  const db = env.DB;
  await db.batch([
    db
      .prepare('INSERT INTO users (id, handle, ref_code, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(
        id,
        opts.handle === undefined ? `ewe_${n}_${id.slice(-4).toLowerCase()}` : opts.handle,
        `RID${id.slice(-10)}`,
        createdAt,
      ),
    db
      .prepare(
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'wallet', ?3, ?4)",
      )
      .bind(newUlid(createdAt), id, wallet.address.toLowerCase(), createdAt),
    db
      .prepare(
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'farcaster', ?3, ?4)",
      )
      .bind(newUlid(createdAt), id, String(fid), createdAt),
    db
      .prepare(
        "INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, 'global', ?2, ?3)",
      )
      .bind(id, opts.points ?? 500, createdAt),
  ]);
  const s = await realSession(t.env, id);
  return { id, wallet, fid, headers: s.headers };
}

/** A SIWE proof for `wallet`, as the link and confirm bodies take it. */
export async function walletProof(e: Env, wallet: LocalAccount) {
  const { message, signature } = await siweBody(e, wallet);
  return { provider: 'wallet' as const, message, signature };
}

export async function farcasterProof(t: IdentityTest, fid: number) {
  return { provider: 'farcaster' as const, token: await t.fc.mint(fid) };
}

export async function link(t: IdentityTest, who: Account, body: unknown): Promise<Response> {
  return call(t.env, 'POST', '/me/identities/link', body, who.headers);
}

/** Links `body` as `who` and expects a pending merge. */
export async function pendingMerge(t: IdentityTest, who: Account, body: unknown): Promise<Merge> {
  const res = await link(t, who, body);
  expect(res.status, await res.clone().text()).toBe(200);
  const result = await res.json<LinkResult>();
  if (result.status !== 'merge_pending')
    throw new Error(`expected a pending merge: ${result.status}`);
  return result.merge;
}

export async function confirm(
  t: IdentityTest,
  who: Account,
  mergeId: string,
  body: unknown,
): Promise<Response> {
  return call(t.env, 'POST', `/me/merges/${mergeId}/confirm`, body, who.headers);
}

export async function userRow(id: string) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?1')
    .bind(id)
    .first<Record<string, unknown> & { status: string; merged_into: string | null }>();
}

export async function identitiesOf(userId: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, provider, external_id, verified_at FROM identities WHERE user_id = ?1 ORDER BY provider, external_id',
  )
    .bind(userId)
    .all<{ id: string; provider: string; external_id: string; verified_at: number | null }>();
  return results;
}

export async function balance(userId: string, scope = 'global'): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = ?2',
  )
    .bind(userId, scope)
    .first<{ balance: number }>();
  return row?.balance ?? null;
}

export async function mergeRow(id: string) {
  return env.DB.prepare('SELECT * FROM merges WHERE id = ?1').bind(id).first<{
    status: string;
    kept_user_id: string;
    losing_user_id: string;
    confirmed_at: number | null;
  }>();
}

/** Sets the account's self-exclusion columns directly. */
export async function exclude(userId: string, until: number | null, permanent = false) {
  await env.DB.prepare(
    'INSERT INTO limits (user_id, self_exclusion_started_at, self_exclusion_until, self_exclusion_permanent) ' +
      'VALUES (?1, ?2, ?3, ?4) ON CONFLICT (user_id) DO UPDATE SET self_exclusion_started_at = excluded.self_exclusion_started_at, ' +
      'self_exclusion_until = excluded.self_exclusion_until, self_exclusion_permanent = excluded.self_exclusion_permanent',
  )
    .bind(userId, Date.now(), until, permanent ? 1 : 0)
    .run();
}

/** A Free entry by `userId` in a new daily round whose Free mode has `status`. */
export async function freeEntry(userId: string, status: string): Promise<string> {
  const t = Date.now();
  const roundId = newUlid(t);
  const db = env.DB;
  await db.batch([
    db
      .prepare(
        "INSERT INTO rounds (id, kind, status, opens_at, closes_at) VALUES (?1, 'daily', 'open', ?2, ?3)",
      )
      .bind(roundId, t - DAY, t + DAY + ++seq * 1000),
    db
      .prepare(
        "INSERT INTO round_modes (round_id, mode, status, final_at) VALUES (?1, 'free', ?2, ?3)",
      )
      .bind(roundId, status, ['settled', 'refunded', 'voided'].includes(status) ? t : null),
    db
      .prepare(
        "INSERT INTO entries (id, round_id, mode, user_id, stake, commitment, receipt_seq, created_at) VALUES (?1, ?2, 'free', ?3, 10, ?4, ?5, ?6)",
      )
      .bind(newUlid(t), roundId, userId, `0x${'cd'.repeat(32)}`, seq++, t),
  ]);
  return roundId;
}
