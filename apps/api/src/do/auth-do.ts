// AuthDO: single-use SIWE nonces, email codes and OAuth state with attempt counters (spec "Data
// model": nonces and email codes live in KV with a 5-minute TTL, stored only as hashes, and AuthDO
// consumes each one atomically and counts attempts; "Identity and personhood": OAuth state).
//
// One instance per subject (`authDOFor`): a nonce, an email address or an OAuth state. Each method
// runs inside blockConcurrencyWhile, so a KV read cannot interleave with a second consume of the
// same subject; the instance's own storage records use, because KV deletes are eventually
// consistent. An alarm deletes everything once the subject has expired.
import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from '../auth/crypto.js';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import type {
  AuthDORpc,
  ConsumeResult,
  EmailCodeAttempt,
  EmailCodeResult,
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

/** KV record of the latest email code for an address, at `emailCodeKvKey(emailHash)`. */
export interface EmailCodeRecord {
  /** Identifies this code; attempts and use are counted per ID. */
  id: string;
  codeHash: string;
  expiresAt: number;
}

export const nonceKvKey = (nonceHash: string) => `auth:nonce:${nonceHash}`;
export const emailCodeKvKey = (emailHash: string) => `auth:email-code:${emailHash}`;

/** The AuthDO instance for one subject. */
export function authDOFor(
  env: Pick<Env, 'AUTH'>,
  subject: 'nonce' | 'email' | 'oauth',
  hash: string,
): DurableObjectStub<AuthDO> {
  return env.AUTH.get(env.AUTH.idFromName(`${subject}:${hash}`));
}

export class AuthDO extends DurableObject<Env> implements AuthDORpc {
  private async cleanupAt(expiresAt: number): Promise<void> {
    const at = expiresAt + CLEANUP_GRACE_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < at) await this.ctx.storage.setAlarm(at);
  }

  consumeNonce(nonceHash: string): Promise<ConsumeResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<boolean>('used')) return { ok: false, reason: 'used' };
      const record = await this.env.KV.get<NonceRecord>(nonceKvKey(nonceHash), 'json');
      if (!record) return { ok: false, reason: 'unknown' };
      const t = now(this.env);
      // Burn it either way: an expired nonce must not become valid again.
      await this.ctx.storage.put('used', true);
      await this.cleanupAt(Math.max(record.expiresAt, t));
      await this.env.KV.delete(nonceKvKey(nonceHash));
      if (t >= record.expiresAt) return { ok: false, reason: 'expired' };
      return { ok: true };
    });
  }

  consumeEmailCode(attempt: EmailCodeAttempt): Promise<EmailCodeResult> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<EmailCodeResult> => {
      const record = await this.env.KV.get<EmailCodeRecord>(
        emailCodeKvKey(attempt.emailHash),
        'json',
      );
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
        const attemptsLeft = EMAIL_CODE_MAX_ATTEMPTS - attempts;
        if (attemptsLeft === 0) {
          // Spent: no later attempt can succeed, so drop the code itself too.
          await this.env.KV.delete(emailCodeKvKey(attempt.emailHash));
        }
        return { ok: false, reason: 'wrong_code', attemptsLeft };
      }
      await this.ctx.storage.put(`used:${record.id}`, true);
      await this.env.KV.delete(emailCodeKvKey(attempt.emailHash));
      return { ok: true };
    });
  }

  bindOAuthState(binding: OAuthStateBinding): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get('oauth')) || (await this.ctx.storage.get('used'))) {
        throw new Error('oauth state already bound');
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
