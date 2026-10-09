// A broken runtime must make classify throw, never VOID: the once-per-isolate self-test, and the rethrow of
// TypeError and ReferenceError from decryption.
import type * as Ibe from 'tlock-js/crypto/ibe.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { QUICKNET, classify } from '../src/index.js';
import { bytesToHex } from '../src/encoding.js';
import { SELF_TEST_CASE, selfTest } from '../src/seal.js';
import { PICKS, beacon, fixturePick } from './helpers.js';

// A runtime whose IBE silently computes a wrong answer: with `corruptFileKey` set, every file key
// `decryptOnG2` unwraps comes out with one bit flipped. Otherwise it is tlock-js's own function.
const runtime = vi.hoisted(() => ({ corruptFileKey: false }));
vi.mock('tlock-js/crypto/ibe.js', async (importOriginal) => {
  const ibe = await importOriginal<typeof Ibe>();
  return {
    ...ibe,
    decryptOnG2: async (key: Uint8Array, ct: Ibe.Ciphertext): Promise<Uint8Array> => {
      const fileKey = await ibe.decryptOnG2(key, ct);
      if (runtime.corruptFileKey) fileKey[0] = (fileKey[0] ?? 0) ^ 1;
      return fileKey;
    },
  };
});

const ROUND = 1_000_000;
const pick = fixturePick(ROUND);
const input = {
  ct: pick.ct,
  chain: QUICKNET,
  beaconRound: ROUND,
  signature: pick.signature,
  roundRef: pick.roundRef,
};

/**
 * Runs `f` with the global `TextEncoder` set to undefined or deleted, and returns what it threw (or
 * 'resolved'). noble-hashes needs `TextEncoder` to hash a string, as tlock-js's `decryptOnG2` does.
 */
async function withoutTextEncoder(
  how: 'undefined' | 'deleted',
  f: () => Promise<unknown>,
): Promise<unknown> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
  if (!saved) throw new Error('this runtime has no TextEncoder');
  if (how === 'deleted') Reflect.deleteProperty(globalThis, 'TextEncoder');
  else Object.defineProperty(globalThis, 'TextEncoder', { ...saved, value: undefined });
  try {
    return await f().then(
      () => 'resolved',
      (e: unknown) => e,
    );
  } finally {
    Object.defineProperty(globalThis, 'TextEncoder', saved);
  }
}

describe('TL-3: a broken runtime throws instead of turning entries into VOIDs', () => {
  beforeAll(async () => {
    // Runs this module's self-test and caches the signature, so later failures come from decryption.
    expect(await classify(input)).toMatchObject({ valid: true });
  });

  it('the embedded self-test case is the committed fixture, and the self-test passes here', async () => {
    const p = PICKS.find((x) => x.round === SELF_TEST_CASE.round);
    if (!p) throw new Error('no committed pick for the self-test round');
    expect(SELF_TEST_CASE).toEqual({
      round: p.round,
      signature: beacon(p.round).signature,
      ciphertext: p.ciphertext,
      plaintext: bytesToHex(fixturePick(p.round).plaintext),
    });
    await expect(selfTest()).resolves.toBeUndefined();
  });

  it.each([
    ['TypeError', 'undefined', TypeError],
    ['ReferenceError', 'deleted', ReferenceError],
  ] as const)(
    'a %s from decryption is rethrown, not a VOID (TextEncoder %s)',
    async (_name, how, type) => {
      const thrown = await withoutTextEncoder(how, () => classify(input));
      expect(thrown).toBeInstanceOf(type);
      expect(String(thrown)).toMatch(/TextEncoder/);
      expect(await classify(input)).toMatchObject({ valid: true });
    },
  );

  it('the self-test is what catches a runtime that decrypts wrongly without a TypeError', async () => {
    // This module already passed its self-test, so the broken IBE turns a valid pick into a VOID...
    runtime.corruptFileKey = true;
    try {
      expect(await classify(input)).toEqual({ valid: false, voidReason: 'decrypt_failed' });
    } finally {
      runtime.corruptFileKey = false;
    }
    // ...but a fresh isolate (module instance) runs the self-test first, and throws instead.
    vi.resetModules();
    const fresh = await import('../src/classify.js');
    runtime.corruptFileKey = true;
    try {
      await expect(fresh.classify(input)).rejects.toThrow(/self-test failed/);
    } finally {
      runtime.corruptFileKey = false;
    }
    // The failure is kept: that isolate never classifies, even once decryption works again.
    await expect(fresh.classify(input)).rejects.toThrow(/self-test failed/);
  });
});
