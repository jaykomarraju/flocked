// Runs inside workerd (the `workers` Vitest project): the settlement path works in the Workers runtime.
import { describe, expect, it } from 'vitest';
import {
  QUICKNET,
  checkTargetRound,
  classify,
  decryptWithSignature,
  encodePlaintext,
  encryptPick,
  fromBase64Url,
  verifyBeacon,
} from '../src/index.js';
import { BEACONS, PICKS, beacon, flipBit, hex, randomBytes } from './helpers.js';

function pickCiphertext(p: (typeof PICKS)[number]): Uint8Array {
  const ct = fromBase64Url(p.ciphertext);
  if (!ct) throw new Error('bad fixture');
  return ct;
}

/** workerd's clock only moves across I/O, so read it after yielding to a timer. */
async function clock(): Promise<number> {
  await new Promise((r) => setTimeout(r, 0));
  return performance.now();
}

describe('TL-1 (Workers): decrypt and verifyBeacon in workerd', () => {
  it('runs in workerd', () => {
    const { navigator } = globalThis as { navigator?: { userAgent?: string } };
    expect(navigator?.userAgent).toBe('Cloudflare-Workers');
  });

  it.each(BEACONS)('verifyBeacon accepts recorded round $round and rejects a flipped bit', (b) => {
    expect(verifyBeacon(QUICKNET, b.round, b.signature)).toBe(true);
    expect(verifyBeacon(QUICKNET, b.round, flipBit(b.signature, 200))).toBe(false);
  });

  it('decrypts and classifies ciphertexts made in Node with the recorded signatures', async () => {
    for (const p of PICKS) {
      const { signature } = beacon(p.round);
      const ct = pickCiphertext(p);
      const expected = encodePlaintext({
        roundRef: hex(p.roundRef),
        optionIndex: p.optionIndex as 0 | 1,
        nonce: hex(p.nonce),
      });
      expect(await decryptWithSignature(QUICKNET, ct, signature)).toEqual(expected);
      expect(
        await classify({
          ct,
          chain: QUICKNET,
          beaconRound: p.round,
          signature,
          roundRef: hex(p.roundRef),
        }),
      ).toEqual({ valid: true, optionIndex: p.optionIndex, nonce: hex(p.nonce) });
      await expect(
        classify({
          ct,
          chain: QUICKNET,
          beaconRound: p.round,
          signature: flipBit(signature, 3),
          roundRef: hex(p.roundRef),
        }),
      ).rejects.toThrow(/failed verification/);
    }
  });

  it('round-trips a pick encrypted inside workerd', async () => {
    const { round, signature } = beacon(32_870_075);
    const pt = encodePlaintext({
      roundRef: randomBytes(16),
      optionIndex: 1,
      nonce: randomBytes(16),
    });
    const ct = await encryptPick(QUICKNET, round, pt);
    expect(await decryptWithSignature(QUICKNET, ct, signature)).toEqual(pt);
  });

  it('the 21:00 New York check has time-zone data in workerd', () => {
    const closesAt = Date.UTC(2026, 11, 2, 2) / 1000; // 2026-12-01 21:00 EST
    const beaconRound = 1 + Math.ceil((closesAt + 120 - QUICKNET.genesis) / QUICKNET.period);
    const base = { chain: QUICKNET, closesAt, beaconDelay: 120, beaconRound, now: closesAt - 60 };
    expect(checkTargetRound({ ...base, dailyClose: { gameDay: '2026-12-01' } })).toEqual({
      ok: true,
    });
    expect(checkTargetRound({ ...base, dailyClose: { gameDay: '2026-12-02' } })).toEqual({
      ok: false,
      reason: 'wrong_daily_close',
    });
  });

  it('timing: ms per decrypt and per verifyBeacon (input to the load test)', async () => {
    const p = PICKS[PICKS.length - 1];
    if (!p) throw new Error('no fixture');
    const { signature } = beacon(p.round);
    const ct = pickCiphertext(p);
    const N = 20;
    let t0 = await clock();
    for (let k = 0; k < N; k++) await decryptWithSignature(QUICKNET, ct, signature);
    const decryptMs = ((await clock()) - t0) / N;
    t0 = await clock();
    for (let k = 0; k < N; k++) verifyBeacon(QUICKNET, p.round, signature);
    const verifyMs = ((await clock()) - t0) / N;
    console.log(
      `[tlock timing] workerd: ${decryptMs.toFixed(1)} ms per decrypt, ${verifyMs.toFixed(1)} ms per verifyBeacon (N=${N})`,
    );
    expect(decryptMs).toBeGreaterThan(0);
  });
});
