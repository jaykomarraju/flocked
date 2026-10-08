// ULIDs and their 16-byte binary form. Spec: "Data model" (IDs are ULIDs), "Sealed picks" (the plaintext's
// round reference is the round's 16-byte binary ULID), "Settlement and payout math" (Merkle leaves use
// 16-byte binary ULIDs).
//
// Input is strict: 26 upper-case Crockford base32 characters, first character 0–7 (at most 128 bits). Lower
// case and the Crockford aliases (I, L, O, U) are rejected, so every ID has exactly one spelling and string
// comparison, D1 keys and R2 paths stay unambiguous. Output is always upper case.
import type { Hex } from 'viem';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A canonical ULID: 26 upper-case Crockford base32 characters, ≤ 7ZZZZZZZZZZZZZZZZZZZZZZZZZ. */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Largest ULID timestamp (48 bits of milliseconds). */
export const ULID_TIME_MAX = 2 ** 48 - 1;

const DECODE: Readonly<Record<string, number>> = Object.fromEntries(
  [...CROCKFORD].map((ch, i) => [ch, i]),
);

/** True for a canonical (upper-case) ULID. */
export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}

function assertUlid(ulid: string): void {
  if (!isUlid(ulid)) throw new RangeError(`not a canonical ULID: ${JSON.stringify(ulid)}`);
}

/** The 16-byte big-endian binary form of a ULID. Throws on a non-canonical ULID. */
export function ulidToBytes(ulid: string): Uint8Array {
  assertUlid(ulid);
  let n = 0n;
  for (const ch of ulid) n = (n << 5n) | BigInt(DECODE[ch] ?? 0);
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** The ULID for 16 bytes (big-endian). Throws unless `bytes` is exactly 16 bytes long. */
export function bytesToUlid(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    throw new RangeError('a binary ULID is exactly 16 bytes');
  }
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 26; i++) {
    s = CROCKFORD.charAt(Number(n & 31n)) + s;
    n >>= 5n;
  }
  return s;
}

/** The ULID as 0x-prefixed lower-case bytes16 hex, for ABI encoding. */
export function ulidToHex(ulid: string): Hex {
  let hex = '0x';
  for (const b of ulidToBytes(ulid)) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

/** The ULID for bytes16 hex (0x-prefixed, either case). */
export function hexToUlid(hex: string): string {
  if (!/^0x[0-9a-fA-F]{32}$/.test(hex)) throw new RangeError('expected 0x-prefixed bytes16 hex');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  return bytesToUlid(out);
}

function defaultRandom(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * A new ULID: 48-bit millisecond time `now` (default `Date.now()`) then 80 random bits from `random`
 * (default `crypto.getRandomValues`). Not monotonic within a millisecond.
 */
export function newUlid(
  now: number = Date.now(),
  random: (n: number) => Uint8Array = defaultRandom,
): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > ULID_TIME_MAX) {
    throw new RangeError('ULID time must be an integer in [0, 2^48)');
  }
  const r = random(10);
  if (!(r instanceof Uint8Array) || r.length !== 10) {
    throw new RangeError('random(10) must return 10 bytes');
  }
  const bytes = new Uint8Array(16);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes.set(r, 6);
  return bytesToUlid(bytes);
}

/** The ULID's timestamp in epoch milliseconds. */
export function ulidTime(ulid: string): number {
  assertUlid(ulid);
  let t = 0;
  for (const ch of ulid.slice(0, 10)) t = t * 32 + (DECODE[ch] ?? 0);
  return t;
}
