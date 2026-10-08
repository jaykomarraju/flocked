import { describe, expect, it } from 'vitest';
import {
  QUICKNET,
  classify,
  commitment,
  decryptWithSignature,
  encodePlaintext,
  encryptPick,
  fromBase64Url,
  isCanonicalHeader,
  roundRefFromChainId,
  roundRefFromUlid,
} from '../src/index.js';
import { BEACONS, PICKS, beacon, hex, randomBytes } from './helpers.js';

describe('TL-1 (Node): encrypt to a recorded round, decrypt with its recorded signature', () => {
  it.each(BEACONS)('round $round', async ({ round, signature }) => {
    const roundRef = roundRefFromUlid('01J9ZQ3V4K8M2N5P6R7S8T9V0W');
    const nonce = randomBytes(16);
    for (const optionIndex of [0, 1] as const) {
      const pt = encodePlaintext({ roundRef, optionIndex, nonce });
      const ct = await encryptPick(QUICKNET, round, pt);
      expect(isCanonicalHeader(ct, QUICKNET, round)).toBe(true);
      expect(await decryptWithSignature(QUICKNET, ct, signature)).toEqual(pt);
      expect(
        await classify({ ct, chain: QUICKNET, beaconRound: round, signature, roundRef }),
      ).toEqual({
        valid: true,
        optionIndex,
        nonce,
      });
    }
  });

  it('is binary age (not armored) and its length does not depend on the pick', async () => {
    const roundRef = roundRefFromChainId(7n);
    const [a, b] = await Promise.all(
      ([0, 1] as const).map((optionIndex) =>
        encryptPick(
          QUICKNET,
          12_345_678,
          encodePlaintext({ roundRef, optionIndex, nonce: randomBytes(16) }),
        ),
      ),
    );
    expect(new TextDecoder().decode(a?.subarray(0, 22))).toBe('age-encryption.org/v1\n');
    expect(a?.length).toBe(b?.length);
  });

  it('decrypts the committed ciphertexts and matches their commitments', async () => {
    for (const p of PICKS) {
      const ct = fromBase64Url(p.ciphertext);
      if (!ct) throw new Error('bad fixture');
      expect(commitment(ct)).toBe(p.commitment);
      const pt = await decryptWithSignature(QUICKNET, ct, beacon(p.round).signature);
      expect(pt).toEqual(
        encodePlaintext({
          roundRef: hex(p.roundRef),
          optionIndex: p.optionIndex as 0 | 1,
          nonce: hex(p.nonce),
        }),
      );
    }
  });

  it('a signature for another round does not open the ciphertext', async () => {
    const ct = await encryptPick(
      QUICKNET,
      9,
      encodePlaintext({ roundRef: randomBytes(16), optionIndex: 1, nonce: randomBytes(16) }),
    );
    await expect(decryptWithSignature(QUICKNET, ct, beacon(10).signature)).rejects.toThrow();
  });

  it('encryptPick refuses anything but a 34-byte plaintext and rounds below 1', async () => {
    await expect(encryptPick(QUICKNET, 9, new Uint8Array(33))).rejects.toThrow(RangeError);
    await expect(encryptPick(QUICKNET, 0, new Uint8Array(34))).rejects.toThrow(RangeError);
  });
});
