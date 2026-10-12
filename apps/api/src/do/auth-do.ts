// AuthDO: single-use SIWE nonces, email codes and OAuth state with attempt counters (spec "Data
// model": nonces and email codes are stored only as hashes with a 5-minute TTL, and AuthDO consumes
// each one atomically and counts attempts; "Identity and personhood": OAuth state).
//
// One instance per subject (`authDOFor`): a nonce, an email address or an OAuth state. Each method
// runs inside blockConcurrencyWhile, so two consumes of the same subject never interleave; the
// instance's own storage records use, because KV deletes are eventually consistent. An alarm
// deletes everything once the subject has expired.
//
// Email codes live in the instance's storage, not KV (W3-Z carry-over): KV's edge cache can serve a
// replaced code for about a minute, so a resent code could fail while the old one still worked.
// Nonces are still issued into KV (src/auth/siwe.ts). A KV call that throws answers `unavailable`
// instead of throwing, because an exception inside blockConcurrencyWhile resets the object.
import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from '../auth/crypto.js';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';
import type {
  ConsumeFailure,
  EmailCodeAttempt,
  OAuthStateBinding,
  OAuthStateResult,
} from './types.js';

/** Spec "API" › Rate limits: 5 attempts per email code. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Spec "Data model": nonces and email codes live 5 minutes. */
export const AUTH_SECRET_TTL_MS = 5 * 60 * 1000;
/** Keep the instance's use markers this long past expiry, then delete them. */
const CLEANUP_GRACE_MS = 60 * 1000;

/** KV record of an issued SIWE nonce, at `nonceKvKey(nonceHash)`. */
export interface NonceRecord {
  expiresAt: number;
}

/** The latest email code for an address, kept in its AuthDO instance (`issueEmailCode`). */
export interface EmailCodeRecord {
  /** Identifies this code; attempts and use are counted per ID. */
  id: string;
  codeHash: string;
  expiresAt: number;
}

export const nonceKvKey = (nonceHash: string) => `auth:nonce:${nonceHash}`;

/** `unavailable`: KV could not be read; the caller answers 503. */
export type NonceResult = { ok: true } | { ok: false; reason: ConsumeFailure | 'unavailable' };

export type EmailCodeResult =
  | { ok: true }
  | {
      ok: false;
      reason: ConsumeFailure | 'wrong_code' | 'too_many_attempts';
      /** Of 5 per code (spec "API" › Rate limits). */
      attemptsLeft: number;
    };

/** AuthDO's RPC surface (W7-B; it replaced `AuthDORpc` in ./types.ts). */
export interface AuthDOMethods {
  consumeNonce(nonceHash: string): Promise<NonceResult>;
  issueEmailCode(record: EmailCodeRecord): Promise<void>;
  consumeEmailCode(attempt: EmailCodeAttempt): Promise<EmailCodeResult>;
  bindOAuthState(binding: OAuthStateBinding): Promise<void>;
  consumeOAuthState(stateHash: string): Promise<OAuthStateResult>;
}

/** The AuthDO instance for one subject. */
export function authDOFor(
  env: Pick<Env, 'AUTH'>,
  subject: 'nonce' | 'email' | 'oauth',
  hash: string,
): DurableObjectStub<AuthDO> {
  return env.AUTH.get(env.AUTH.idFromName(`${subject}:${hash}`));
}

const EMAIL_CODE_KEY = 'email-code';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AuthDO extends DurableObject<Env> implements AuthDOMethods {
  private async cleanupAt(expiresAt: number): Promise<void> {
    const at = expiresAt + CLEANUP_GRACE_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < at) await this.ctx.storage.setAlarm(at);
  }

  consumeNonce(nonceHash: string): Promise<NonceResult> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<NonceResult> => {
      if (await this.ctx.storage.get<boolean>('used')) return { ok: false, reason: 'used' };
      let record: NonceRecord | null;
      try {
        record = await this.env.KV.get<NonceRecord>(nonceKvKey(nonceHash), 'json');
      } catch (err) {
        log.error('auth_kv_unavailable', { op: 'get', error: errorText(err) });
        return { ok: false, reason: 'unavailable' };
      }
      if (!record) return { ok: false, reason: 'unknown' };
      const t = now(this.env);
      // Burn it either way: an expired nonce must not become valid again.
      await this.ctx.storage.put('used', true);
      await this.cleanupAt(Math.max(record.expiresAt, t));
      try {
        await this.env.KV.delete(nonceKvKey(nonceHash));
      } catch (err) {
        // The `used` marker already refuses a replay, and KV's TTL removes the record.
        log.warn('auth_kv_unavailable', { op: 'delete', error: errorText(err) });
      }
      if (t >= record.expiresAt) return { ok: false, reason: 'expired' };
      return { ok: true };
    });
  }

  /** Stores a new code for this address. It replaces any earlier code, whose attempts stop mattering. */
  issueEmailCode(record: EmailCodeRecord): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(EMAIL_CODE_KEY, record);
      await this.cleanupAt(record.expiresAt);
    });
  }

  consumeEmailCode(attempt: EmailCodeAttempt): Promise<EmailCodeResult> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<EmailCodeResult> => {
      const record = await this.ctx.storage.get<EmailCodeRecord>(EMAIL_CODE_KEY);
      if (!record) return { ok: false, reason: 'unknown', attemptsLeft: 0 };
      if (await this.ctx.storage.get<boolean>(`used:${record.id}`)) {
        return { ok: false, reason: 'used', attemptsLeft: 0 };
      }
      const t = now(this.env);
      await this.cleanupAt(Math.max(record.expiresAt, t));
      if (t >= record.expiresAt) return { ok: false, reason: 'expired', attemptsLeft: 0 };

      const attemptsKey = `attempts:${record.id}`;
      const used = (await this.ctx.storage.get<number>(attemptsKey)) ?? 0;
      if (used >= EMAIL_CODE_MAX_ATTEMPTS) {
        return { ok: false, reason: 'too_many_attempts', attemptsLeft: 0 };
      }
      const attempts = used + 1;
      await this.ctx.storage.put(attemptsKey, attempts);
      if (!timingSafeEqual(attempt.codeHash, record.codeHash)) {
        // A spent code stays stored until it expires, so later attempts keep answering
        // `too_many_attempts`; the counter here is what refuses them.
        return {
          ok: false,
          reason: 'wrong_code',
          attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - attempts,
        };
      }
      await this.ctx.storage.put(`used:${record.id}`, true);
      return { ok: true };
    });
  }

  /**
   * Binds a new OAuth state. A state is bound once: a second bind (only possible if two random
   * states collided) keeps the first binding, so it can never be redirected to another user.
   */
  bindOAuthState(binding: OAuthStateBinding): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get('oauth')) || (await this.ctx.storage.get('used'))) {
        log.warn('oauth_state_rebind_ignored', {});
        return;
      }
      await this.ctx.storage.put('oauth', binding);
      await this.cleanupAt(binding.expiresAt);
    });
  }

  consumeOAuthState(stateHash: string): Promise<OAuthStateResult> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<OAuthStateResult> => {
      if (await this.ctx.storage.get<boolean>('used')) return { ok: false, reason: 'used' };
      const binding = await this.ctx.storage.get<OAuthStateBinding>('oauth');
      if (!binding || binding.stateHash !== stateHash) return { ok: false, reason: 'unknown' };
      await this.ctx.storage.delete('oauth');
      await this.ctx.storage.put('used', true);
      if (now(this.env) >= binding.expiresAt) return { ok: false, reason: 'expired' };
      return { ok: true, userId: binding.userId, codeVerifier: binding.codeVerifier };
    });
  }

  /** The subject has expired: forget it. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
