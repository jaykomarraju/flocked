// Properties of classify on corrupted ciphertexts: it never throws for bad data (a throw is reserved for a
// bad signature or a broken runtime), and only the untouched ciphertext is valid.
import { VOID_REASONS } from '@flocked/settle';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { QUICKNET, classify } from '../src/index.js';
import { fixturePick, withBody } from './helpers.js';

const NUM_RUNS = Number(process.env.FAST_CHECK_RUNS ?? 1000);
/** Most mutation runs decrypt (a pairing, ~12 ms in Node), so that property runs a quarter as often. */
const MUTATION_RUNS = Math.ceil(NUM_RUNS / 4);
const ROUND = 1_000_000;
const pick = fixturePick(ROUND);

const classifyCt = (ct: Uint8Array) =>
  classify({
    ct,
    chain: QUICKNET,
    beaconRound: ROUND,
    signature: pick.signature,
    roundRef: pick.roundRef,
  });

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, k) => x === b[k]);

type Mutation =
  | { kind: 'set'; at: number; value: number }
  | { kind: 'flip'; at: number; bit: number }
  | { kind: 'insert'; at: number; bytes: Uint8Array }
  | { kind: 'delete'; at: number; count: number }
  | { kind: 'truncate'; at: number };

// A position is taken modulo the current length, so a mutation applies to any ciphertext. Half of them
// are negative and count back from the end (the payload and the MAC line), where an edit gets past the
// header checks and costs a decryption; uniform positions almost always break the header first.
const at = fc.oneof(fc.nat(), fc.integer({ min: -96, max: -1 }));
const index = (p: number, n: number) => (p < 0 ? Math.max(0, n + p) : p % n);
const mutation: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ kind: fc.constant('set'), at, value: fc.integer({ min: 0, max: 255 }) }),
  fc.record({ kind: fc.constant('flip'), at, bit: fc.integer({ min: 0, max: 7 }) }),
  fc.record({
    kind: fc.constant('insert'),
    at,
    bytes: fc.uint8Array({ minLength: 1, maxLength: 8 }),
  }),
  fc.record({ kind: fc.constant('delete'), at, count: fc.integer({ min: 1, max: 8 }) }),
  fc.record({ kind: fc.constant('truncate'), at }),
);

function apply(ct: Uint8Array, m: Mutation): Uint8Array {
  const i = index(m.at, ct.length + 1);
  switch (m.kind) {
    case 'set':
    case 'flip': {
      if (ct.length === 0) return ct;
      const out = ct.slice();
      const k = index(m.at, ct.length);
      out[k] = m.kind === 'set' ? m.value : (out[k] ?? 0) ^ (1 << m.bit);
      return out;
    }
    case 'insert':
      return new Uint8Array([...ct.subarray(0, i), ...m.bytes, ...ct.subarray(i)]);
    case 'delete':
      return new Uint8Array([...ct.subarray(0, i), ...ct.subarray(i + m.count)]);
    case 'truncate':
      return ct.slice(0, i);
  }
}

describe('TL-3 properties: classify on corrupted ciphertexts', () => {
  it('property: byte edits, insertions, deletions and truncations are VOIDs, never exceptions', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(mutation, { minLength: 1, maxLength: 3 }), async (ms) => {
        const ct = ms.reduce(apply, pick.ct);
        const r = await classifyCt(ct);
        if (sameBytes(ct, pick.ct)) {
          expect(r.valid).toBe(true);
        } else {
          if (r.valid) throw new Error('a corrupted ciphertext classified as valid');
          expect(VOID_REASONS).toContain(r.voidReason);
        }
      }),
      { numRuns: MUTATION_RUNS },
    );
  });

  it('property: any stanza body other than the real one, canonically wrapped, is decrypt_failed', async () => {
    // Half the bodies get the compression flag and a clear infinity flag, so more of them reach the
    // curve-point checks instead of failing on the flags.
    const body = fc
      .tuple(fc.uint8Array({ minLength: 128, maxLength: 128 }), fc.boolean())
      .map(([b, compressed]) => {
        if (compressed) b[0] = ((b[0] ?? 0) & 0x3f) | 0x80;
        return b;
      });
    await fc.assert(
      fc.asyncProperty(body, async (b) => {
        expect(await classifyCt(withBody(pick.ct, b))).toEqual({
          valid: false,
          voidReason: 'decrypt_failed',
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
