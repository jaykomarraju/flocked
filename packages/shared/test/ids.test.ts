import { roundRefFromUlid } from '@flocked/tlock';
import fc from 'fast-check';
import { bytesToHex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  bytesToUlid,
  hexToUlid,
  isUlid,
  newUlid,
  ULID_RE,
  ULID_TIME_MAX,
  ulidTime,
  ulidToBytes,
  ulidToHex,
} from '../src/ids';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ulidArb = fc
  .tuple(
    fc.constantFrom(...'01234567'),
    fc.array(fc.constantFrom(...CROCKFORD), { minLength: 25, maxLength: 25 }),
  )
  .map(([first, rest]) => first + rest.join(''));
const bytes16 = fc.uint8Array({ minLength: 16, maxLength: 16 });

describe('known vectors', () => {
  it.each([
    ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '0x01563e3ab5d3d6764c61efb99302bd5b'],
    ['00000000000000000000000000', '0x00000000000000000000000000000000'],
    ['7ZZZZZZZZZZZZZZZZZZZZZZZZZ', '0xffffffffffffffffffffffffffffffff'],
  ])('%s ⇄ %s', (ulid, hex) => {
    expect(bytesToHex(ulidToBytes(ulid))).toBe(hex);
    expect(ulidToHex(ulid)).toBe(hex);
    expect(hexToUlid(hex)).toBe(ulid);
    expect(hexToUlid(hex.toUpperCase().replace('0X', '0x'))).toBe(ulid);
  });

  it('decodes the ULID spec timestamp example', () => {
    // ulid(1469918176385) → 01ARYZ6S41… (github.com/ulid/spec)
    expect(ulidTime('01ARYZ6S41TSV4RRFFQ69G5FAV')).toBe(1469918176385);
    expect(newUlid(1469918176385, (n) => new Uint8Array(n)).slice(0, 10)).toBe('01ARYZ6S41');
    expect(ulidTime('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(ULID_TIME_MAX);
  });
});

describe('validation', () => {
  it.each([
    ['80000000000000000000000000', 'over 128 bits'],
    ['01arz3ndektsv4rrffq69g5fav', 'lower case (input must be canonical upper case)'],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAv', 'one lower-case character'],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAI', 'Crockford alias I'],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAL', 'Crockford alias L'],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAO', 'Crockford alias O'],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAU', 'excluded U'],
    ['01ARZ3NDEKTSV4RRFFQ69G5FA', '25 characters'],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAVV', '27 characters'],
    ['01ARZ3NDEKTSV4RRFFQ69G5FA-', 'punctuation'],
    ['', 'empty'],
  ])('rejects %s (%s)', (s) => {
    expect(isUlid(s)).toBe(false);
    expect(ULID_RE.test(s)).toBe(false);
    expect(() => ulidToBytes(s)).toThrow(RangeError);
    expect(() => ulidTime(s)).toThrow(RangeError);
  });

  it('rejects non-strings and wrong byte lengths', () => {
    expect(isUlid(undefined)).toBe(false);
    expect(isUlid(42)).toBe(false);
    expect(() => bytesToUlid(new Uint8Array(15))).toThrow(RangeError);
    expect(() => bytesToUlid(new Uint8Array(17))).toThrow(RangeError);
    expect(() => hexToUlid('0x00')).toThrow(RangeError);
  });
});

describe('newUlid', () => {
  it('uses the given time and random bytes', () => {
    const random = vi.fn((n: number) => new Uint8Array(n).fill(0xff));
    const u = newUlid(1_791_421_200_000, random);
    expect(random).toHaveBeenCalledWith(10);
    expect(ulidTime(u)).toBe(1_791_421_200_000);
    expect(ulidToBytes(u).slice(6)).toEqual(new Uint8Array(10).fill(0xff));
  });

  it('defaults to Date.now and crypto.getRandomValues', () => {
    const before = Date.now();
    const a = newUlid();
    const b = newUlid();
    expect(isUlid(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(ulidTime(a)).toBeGreaterThanOrEqual(before);
    expect(ulidTime(a)).toBeLessThanOrEqual(Date.now());
  });

  it('rejects bad times and random sources', () => {
    expect(() => newUlid(-1)).toThrow(RangeError);
    expect(() => newUlid(ULID_TIME_MAX + 1)).toThrow(RangeError);
    expect(() => newUlid(1.5)).toThrow(RangeError);
    expect(() => newUlid(0, () => new Uint8Array(9))).toThrow(RangeError);
  });
});

describe('properties', () => {
  it('bytes → ULID → bytes round-trips', () => {
    fc.assert(
      fc.property(bytes16, (b) => {
        const u = bytesToUlid(b);
        expect(isUlid(u)).toBe(true);
        expect(ulidToBytes(u)).toEqual(b);
        expect(hexToUlid(bytesToHex(b))).toBe(u);
      }),
    );
  });

  it('ULID → bytes → ULID round-trips', () => {
    fc.assert(fc.property(ulidArb, (u) => bytesToUlid(ulidToBytes(u)) === u));
  });

  it('matches @flocked/tlock roundRefFromUlid', () => {
    fc.assert(
      fc.property(ulidArb, (u) => {
        expect(ulidToBytes(u)).toEqual(roundRefFromUlid(u));
      }),
    );
  });

  it('string order equals byte order', () => {
    fc.assert(
      fc.property(bytes16, bytes16, (a, b) => {
        const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
        expect(cmp(bytesToUlid(a), bytesToUlid(b))).toBe(cmp(bytesToHex(a), bytesToHex(b)));
      }),
    );
  });

  it('newUlid keeps the time and the 80 random bits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: ULID_TIME_MAX }),
        fc.uint8Array({ minLength: 10, maxLength: 10 }),
        (t, r) => {
          const u = newUlid(t, () => r);
          expect(ulidTime(u)).toBe(t);
          expect(ulidToBytes(u).slice(6)).toEqual(r);
        },
      ),
    );
  });
});
