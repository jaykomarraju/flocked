import { describe, expect, it } from 'vitest';
import { QUICKNET, chainFromEnv, commitment, fromBase64Url, toBase64Url } from '../src/index.js';
import fixture from '../fixtures/quicknet-beacons.json' with { type: 'json' };

const LOCAL = {
  DRAND_CHAIN_HASH: 'ab'.repeat(32),
  DRAND_PUBLIC_KEY: 'cd'.repeat(96),
  DRAND_GENESIS: '1700000000',
  DRAND_PERIOD: '1',
};

describe('chain config', () => {
  it('QUICKNET matches the recorded drand info', () => {
    expect(QUICKNET).toEqual({
      chainHash: fixture.info.hash,
      publicKey: fixture.info.public_key,
      scheme: fixture.info.schemeID,
      genesis: fixture.info.genesis_time,
      period: fixture.info.period,
    });
    expect(Object.isFrozen(QUICKNET)).toBe(true);
  });

  it('chainFromEnv defaults to QUICKNET and takes a full override', () => {
    expect(chainFromEnv({})).toBe(QUICKNET);
    expect(chainFromEnv({ DRAND_CHAIN_HASH: '' })).toBe(QUICKNET);
    expect(chainFromEnv(LOCAL)).toEqual({
      chainHash: LOCAL.DRAND_CHAIN_HASH,
      publicKey: LOCAL.DRAND_PUBLIC_KEY,
      scheme: 'bls-unchained-g1-rfc9380',
      genesis: 1700000000,
      period: 1,
    });
  });

  it('chainFromEnv refuses a partial or malformed override', () => {
    expect(() => chainFromEnv({ DRAND_CHAIN_HASH: LOCAL.DRAND_CHAIN_HASH })).toThrow(/all of/);
    expect(() => chainFromEnv({ ...LOCAL, DRAND_CHAIN_HASH: 'AB'.repeat(32) })).toThrow(RangeError);
    expect(() => chainFromEnv({ ...LOCAL, DRAND_PUBLIC_KEY: 'cd'.repeat(48) })).toThrow(RangeError);
    for (const bad of ['-1', '1.5', '01', 'x', '9007199254740993']) {
      expect(() => chainFromEnv({ ...LOCAL, DRAND_GENESIS: bad })).toThrow(RangeError);
    }
    expect(() => chainFromEnv({ ...LOCAL, DRAND_PERIOD: '0' })).toThrow(RangeError);
  });
});

describe('wire format', () => {
  it('commitment is keccak256 of the bytes', () => {
    expect(commitment(new Uint8Array(0))).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    expect(commitment(new TextEncoder().encode('abc'))).toBe(
      '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    );
  });

  it('base64url is unpadded, round-trips and decodes strictly', () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, k) => (k * 37 + n) & 0xff);
      const s = toBase64Url(b);
      expect(s).not.toMatch(/[=+/]/);
      expect(fromBase64Url(s)).toEqual(b);
    }
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    for (const bad of ['-_8=', '+/8', '-_9', 'A', 'AB CD']) expect(fromBase64Url(bad)).toBeNull();
  });
});
