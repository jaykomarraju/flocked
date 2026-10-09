// Small WebCrypto helpers for sign-in secrets. Session IDs, nonces and email codes are stored only
// as SHA-256 hashes (spec "Data model": sessions, SIWE nonce and email-code paragraph).
import { bytesToHex, toHex } from 'viem';

const encoder = new TextEncoder();

/** SHA-256 of a UTF-8 string as lowercase 0x hex (the repo's hash convention). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** `n` cryptographically random bytes. */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A base64url string of `n` random bytes (session IDs: 32 bytes, 256 bits). */
export function randomToken(n = 32): string {
  let bin = '';
  for (const b of randomBytes(n)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random lowercase hex without a prefix (`2n` characters); SIWE nonces must be alphanumeric. */
export function randomHex(n: number): string {
  return toHex(randomBytes(n)).slice(2);
}

/** A uniformly random string of `length` characters from `alphabet` (rejection sampling). */
export function randomString(length: number, alphabet: string): string {
  if (alphabet.length < 2 || alphabet.length > 256) throw new RangeError('bad alphabet');
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** An 8-digit email code, uniformly random (leading zeros allowed). */
export function randomDigits(length: number): string {
  return randomString(length, '0123456789');
}

/** Constant-time comparison of two equal-length strings (hashes). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
