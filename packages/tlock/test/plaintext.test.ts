import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PLAINTEXT_LENGTH,
  decodePlaintext,
  encodePlaintext,
  roundRefFromChainId,
  roundRefFromUlid,
} from '../src/index.js';

const NUM_RUNS = Number(process.env.FAST_CHECK_RUNS ?? 1000);
const bytes16 = fc.uint8Array({ minLength: 16, maxLength: 16 });

describe('plaintext codec', () => {
  it('property: encode/decode round-trip and the length is always 34', () => {
    fc.assert(
      fc.property(
        bytes16,
        fc.constantFrom(0 as const, 1 as const),
        bytes16,
        (roundRef, optionIndex, nonce) => {
          const b = encodePlaintext({ roundRef, optionIndex, nonce });
          expect(b.length).toBe(PLAINTEXT_LENGTH);
          expect(decodePlaintext(b)).toEqual({ version: 1, roundRef, optionIndex, nonce });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('property: decode accepts exactly the 34-byte inputs, and re-encoding a valid one is the identity', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 70 }), (b) => {
        const d = decodePlaintext(b);
        if (b.length !== PLAINTEXT_LENGTH) {
          expect(d).toBeNull();
          return;
        }
        if (!d) throw new Error('34 bytes must decode');
        if (d.version === 1 && (d.optionIndex === 0 || d.optionIndex === 1)) {
          expect(encodePlaintext({ ...d, optionIndex: d.optionIndex })).toEqual(b);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('lays out version | roundRef | option | nonce', () => {
    const roundRef = Uint8Array.from({ length: 16 }, (_, k) => k + 1);
    const nonce = Uint8Array.from({ length: 16 }, (_, k) => 0xf0 + k);
    expect(Array.from(encodePlaintext({ roundRef, optionIndex: 1, nonce }))).toEqual([
      1,
      ...roundRef,
      1,
      ...nonce,
    ]);
  });

  it('refuses malformed fields', () => {
    const ok = { roundRef: new Uint8Array(16), optionIndex: 0 as const, nonce: new Uint8Array(16) };
    expect(() => encodePlaintext({ ...ok, roundRef: new Uint8Array(15) })).toThrow(RangeError);
    expect(() => encodePlaintext({ ...ok, nonce: new Uint8Array(17) })).toThrow(RangeError);
    expect(() => encodePlaintext({ ...ok, optionIndex: 2 as 0 })).toThrow(RangeError);
  });
});

describe('round references', () => {
  it('a ULID decodes to its 16 bytes; the first 6 are the millisecond timestamp', () => {
    // From the ULID reference implementation: ulid(1469918176385) starts 01ARYZ6S41.
    const ref = roundRefFromUlid('01ARYZ6S41TSV4RRFFQ69G5FAV');
    const ms = ref.slice(0, 6).reduce((n, x) => n * 256 + x, 0);
    expect(ms).toBe(1469918176385);
    expect(roundRefFromUlid('01aryz6s41tsv4rrffq69g5fav')).toEqual(ref);
    expect(roundRefFromUlid('00000000000000000000000000')).toEqual(new Uint8Array(16));
    expect(roundRefFromUlid('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toEqual(new Uint8Array(16).fill(0xff));
  });

  it('property: a ULID built from 16 bytes decodes back to them', () => {
    const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    fc.assert(
      fc.property(bytes16, (b) => {
        let n = b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
        let s = '';
        for (let k = 0; k < 26; k++, n >>= 5n) s = (A[Number(n & 31n)] ?? '') + s;
        expect(roundRefFromUlid(s)).toEqual(b);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('refuses malformed ULIDs', () => {
    for (const bad of [
      '',
      '01ARZ3NDEKTSV4RRFFQ69G5FA',
      '01ARZ3NDEKTSV4RRFFQ69G5FAVV',
      '01ARZ3NDEKTSV4RRFFQ69G5FAI',
      '01ARZ3NDEKTSV4RRFFQ69G5FAU',
      '80000000000000000000000000',
    ]) {
      expect(() => roundRefFromUlid(bad)).toThrow(RangeError);
    }
  });

  it('a chain round ID is a big-endian uint128', () => {
    expect(Array.from(roundRefFromChainId(1n))).toEqual([...new Array<number>(15).fill(0), 1]);
    expect(Array.from(roundRefFromChainId(0x0102n)).slice(-2)).toEqual([1, 2]);
    expect(roundRefFromChainId(2n ** 128n - 1n)).toEqual(new Uint8Array(16).fill(0xff));
    expect(() => roundRefFromChainId(2n ** 128n)).toThrow(RangeError);
    expect(() => roundRefFromChainId(-1n)).toThrow(RangeError);
  });
});
