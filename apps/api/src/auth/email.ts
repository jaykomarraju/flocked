// Email codes (spec "API" › Rate limits: 8 digits, 5 attempts per code, about 10 codes per hour per
// address; "Data model": stored in KV as hashes with a 5-minute TTL, consumed by AuthDO). Sign-in
// codes go only to a verified email already linked to an account; email never creates one.
// W7-B's `POST /me/email` and `/me/email/verify` reuse `issueEmailCode` and `checkEmailCode`.
import {
  AUTH_SECRET_TTL_MS,
  authDOFor,
  emailCodeKvKey,
  type EmailCodeRecord,
} from '../do/auth-do.js';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { randomDigits, randomHex, sha256Hex } from './crypto.js';
import type { EmailSender } from './deps.js';

export const EMAIL_CODE_DIGITS = 8;

/** The one normal form of an address: trimmed, lowercase. `identities.external_id` holds it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function emailHash(email: string): Promise<string> {
  return sha256Hex(`email:${normalizeEmail(email)}`);
}

export async function emailCodeHash(emailHashHex: string, code: string): Promise<string> {
  return sha256Hex(`email-code:${emailHashHex}:${code}`);
}

/**
 * Stores a new code for `email` (replacing any earlier one) and sends it. The caller has already
 * taken a token from the address's code bucket.
 */
export async function issueEmailCode(
  env: Pick<Env, 'KV' | 'ENVIRONMENT' | 'FLOCKED_TEST_CLOCK'>,
  sender: EmailSender,
  email: string,
): Promise<{ expiresAt: number }> {
  const address = normalizeEmail(email);
  const hash = await emailHash(address);
  const code = randomDigits(EMAIL_CODE_DIGITS);
  const expiresAt = now(env) + AUTH_SECRET_TTL_MS;
  const record: EmailCodeRecord = {
    id: randomHex(8),
    codeHash: await emailCodeHash(hash, code),
    expiresAt,
  };
  await env.KV.put(emailCodeKvKey(hash), JSON.stringify(record), {
    expirationTtl: AUTH_SECRET_TTL_MS / 1000,
  });
  await sender.send({
    to: address,
    subject: `${code} is your Flocked code`,
    text:
      `Your Flocked code is ${code}.\n\n` +
      'It works once and expires in 5 minutes. If you did not ask for it, you can ignore this email.\n',
  });
  return { expiresAt };
}

/**
 * Consumes an attempt at `email`'s current code. Throws 401 `invalid_code` (wrong, unknown or
 * used), 401 `code_expired`, or 429 `too_many_attempts` once the code's 5 attempts are spent.
 */
export async function checkEmailCode(
  env: Pick<Env, 'AUTH'>,
  email: string,
  code: string,
): Promise<void> {
  const hash = await emailHash(email);
  const result = await authDOFor(env, 'email', hash).consumeEmailCode({
    emailHash: hash,
    codeHash: await emailCodeHash(hash, code),
  });
  if (result.ok) return;
  switch (result.reason) {
    case 'expired':
      throw new HttpError('code_expired', 'This code has expired; ask for a new one');
    case 'too_many_attempts':
      throw new HttpError('too_many_attempts', 'Too many wrong codes; ask for a new one');
    case 'wrong_code':
      if (result.attemptsLeft === 0) {
        throw new HttpError('too_many_attempts', 'Too many wrong codes; ask for a new one');
      }
      throw new HttpError(
        'invalid_code',
        `Wrong code; ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left`,
      );
    default:
      throw new HttpError('invalid_code', 'No valid code for this address; ask for a new one');
  }
}
