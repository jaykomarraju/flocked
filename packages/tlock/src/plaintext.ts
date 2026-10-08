// The fixed-length pick plaintext (spec: "Sealed picks" › Scheme):
// version 0x01 (1) | round reference (16) | optionIndex (1) | nonce (16) = 34 bytes.

export const PLAINTEXT_LENGTH = 34;
export const PLAINTEXT_VERSION = 0x01;
const REF = 1;
const OPTION = 17;
const NONCE = 18;

export function encodePlaintext(i: {
  roundRef: Uint8Array;
  optionIndex: 0 | 1;
  nonce: Uint8Array;
}): Uint8Array {
  if (i.roundRef.length !== 16) throw new RangeError('roundRef must be 16 bytes');
  if (i.nonce.length !== 16) throw new RangeError('nonce must be 16 bytes');
  if (i.optionIndex !== 0 && i.optionIndex !== 1) {
    throw new RangeError('optionIndex must be 0 or 1');
  }
  const b = new Uint8Array(PLAINTEXT_LENGTH);
  b[0] = PLAINTEXT_VERSION;
  b.set(i.roundRef, REF);
  b[OPTION] = i.optionIndex;
  b.set(i.nonce, NONCE);
  return b;
}

/**
 * Splits a plaintext into its fields without judging them: `null` only when the length is not 34.
 * `classify` checks the version, round reference and option.
 */
export function decodePlaintext(
  b: Uint8Array,
): { version: number; roundRef: Uint8Array; optionIndex: number; nonce: Uint8Array } | null {
  if (b.length !== PLAINTEXT_LENGTH) return null;
  return {
    version: b[0] ?? 0,
    roundRef: b.slice(REF, OPTION),
    optionIndex: b[OPTION] ?? 0,
    nonce: b.slice(NONCE, PLAINTEXT_LENGTH),
  };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Free rounds: the 16-byte binary form of the round's ULID (26 Crockford base32 chars, any case). */
export function roundRefFromUlid(ulid: string): Uint8Array {
  if (ulid.length !== 26) throw new RangeError('a ULID is 26 characters');
  let n = 0n;
  for (const ch of ulid.toUpperCase()) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new RangeError(`invalid ULID character ${JSON.stringify(ch)}`);
    n = (n << 5n) | BigInt(v);
  }
  if (n >> 128n !== 0n) throw new RangeError('ULID exceeds 128 bits');
  return u128(n);
}

/** Stakes rounds: the onchain round ID as a big-endian uint128. */
export function roundRefFromChainId(id: bigint): Uint8Array {
  if (id < 0n || id >> 128n !== 0n) throw new RangeError('round ID must fit in a uint128');
  return u128(id);
}

function u128(n: bigint): Uint8Array {
  const b = new Uint8Array(16);
  for (let k = 15; k >= 0; k--) {
    b[k] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}
