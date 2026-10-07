// Byte encodings without Buffer, so the same code runs in browsers, Node and Workers.

const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encode(b: Uint8Array, alphabet: string): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((b.length - i) * 8) / 6));
    for (let k = 0; k < chars; k++) out += alphabet[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

/** Unpadded and canonical only: no `=`, no whitespace, and the unused trailing bits must be zero. */
function decode(s: string, alphabet: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (const ch of s) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

export const base64Decode = (s: string): Uint8Array | null => decode(s, STD);
export const base64Encode = (b: Uint8Array): string => encode(b, STD);

/** Ciphertexts in JSON are unpadded base64url (P2.1 wire format). */
export const toBase64Url = (b: Uint8Array): string => encode(b, URL_SAFE);
/** Strict inverse of `toBase64Url`: null for padding, other alphabets or non-canonical trailing bits. */
export const fromBase64Url = (s: string): Uint8Array | null => decode(s, URL_SAFE);

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Hex of exactly `bytes` bytes (either case), or null. */
export function hexToBytes(hex: string, bytes: number): Uint8Array | null {
  if (hex.length !== bytes * 2 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** tlock-js's age layer works on binary ("latin1") strings: one char per byte. */
export function bytesToLatin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x2000) s += String.fromCharCode(...b.subarray(i, i + 0x2000));
  return s;
}

export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new RangeError('not a binary string');
    out[i] = c;
  }
  return out;
}
