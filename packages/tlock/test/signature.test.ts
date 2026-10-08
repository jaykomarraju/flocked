import { sha256 } from '@noble/hashes/sha2';
import { describe, expect, it } from 'vitest';
import type { DrandChain } from '../src/index.js';
import { QUICKNET, classify, encodePlaintext, encryptPick, verifyBeacon } from '../src/index.js';
import { BEACONS, beacon, flipBit, hex, otherG2PublicKey, randomBytes } from './helpers.js';

describe('TL-2: beacon signatures are verified before any decryption', () => {
  it.each(BEACONS)(
    'recorded round $round verifies, and its randomness is sha256(signature)',
    (b) => {
      expect(verifyBeacon(QUICKNET, b.round, b.signature)).toBe(true);
      expect(verifyBeacon(QUICKNET, b.round, b.signature.toUpperCase())).toBe(true);
      expect(sha256(hex(b.signature))).toEqual(hex(b.randomness));
    },
  );

  it.each([0, 1, 2, 7, 100, 200, 383])('flipping signature bit %i fails verification', (bit) => {
    for (const b of BEACONS)
      expect(verifyBeacon(QUICKNET, b.round, flipBit(b.signature, bit))).toBe(false);
  });

  it('a signature verifies only for its own round and chain', () => {
    const otherKey: DrandChain = { ...QUICKNET, publicKey: otherG2PublicKey() };
    expect(verifyBeacon(QUICKNET, 10, beacon(9).signature)).toBe(false);
    expect(verifyBeacon(QUICKNET, 1_000_001, beacon(1_000_000).signature)).toBe(false);
    expect(verifyBeacon(otherKey, 9, beacon(9).signature)).toBe(false);
  });

  it('malformed input is false, not an exception', () => {
    const sig = beacon(9).signature;
    for (const s of [
      '',
      sig.slice(2),
      `${sig}00`,
      `zz${sig.slice(2)}`,
      `0x${sig.slice(2)}`,
      '00'.repeat(48),
    ]) {
      expect(verifyBeacon(QUICKNET, 9, s)).toBe(false);
    }
    for (const round of [0, -1, 1.5, Number.NaN])
      expect(verifyBeacon(QUICKNET, round, sig)).toBe(false);
  });

  it('classify throws on a corrupted signature instead of returning VOIDs', async () => {
    const { round, signature } = beacon(32_870_000);
    const roundRef = randomBytes(16);
    const ct = await encryptPick(
      QUICKNET,
      round,
      encodePlaintext({ roundRef, optionIndex: 0, nonce: randomBytes(16) }),
    );
    for (const bit of [0, 5, 191, 383]) {
      await expect(
        classify({
          ct,
          chain: QUICKNET,
          beaconRound: round,
          signature: flipBit(signature, bit),
          roundRef,
        }),
      ).rejects.toThrow(/failed verification/);
    }
    // Even a ciphertext that would be VOID never gets classified under a bad signature.
    await expect(
      classify({
        ct: new Uint8Array(3),
        chain: QUICKNET,
        beaconRound: round,
        signature: flipBit(signature, 9),
        roundRef,
      }),
    ).rejects.toThrow(/failed verification/);
    // The signature of a neighbouring round is just as bad.
    await expect(
      classify({
        ct,
        chain: QUICKNET,
        beaconRound: round,
        signature: beacon(32_870_075).signature,
        roundRef,
      }),
    ).rejects.toThrow(/failed verification/);
  });
});
