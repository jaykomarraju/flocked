import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MAX_BEACON_DELAY, MIN_BEACON_DELAY } from '@flocked/tlock';
import { keccak256, stringToBytes } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  freeConfigCanonicalJson,
  freeConfigHash,
  LOCKED_CONFIG_BOUNDS,
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  questionHash,
  type LockedConfig,
} from '../src/config';

const CREATOR = '0x00000000000000000000000000000000000a11ce';
const AUTHOR = '01JAB2C3D4E5F6G7H8J9K0M1N2';

function defaults(): LockedConfig {
  const d = LOCKED_CONFIG_DEFAULTS;
  return {
    beaconDelay: d.beaconDelay,
    free: { ...d.free, presets: [...d.free.presets], awardRecipient: AUTHOR },
    stakes: { ...d.stakes, creator: CREATOR },
  };
}

type Patch = { free?: Record<string, unknown>; stakes?: Record<string, unknown> } & Record<
  string,
  unknown
>;
function patched(p: Patch): unknown {
  const c = defaults();
  const { free, stakes, ...top } = p;
  return { ...c, ...top, free: { ...c.free, ...free }, stakes: { ...c.stakes, ...stakes } };
}

describe('LockedConfigSchema', () => {
  it('accepts the launch defaults, and either mode alone', () => {
    const c = defaults();
    expect(LockedConfigSchema.parse(c)).toEqual(c);
    expect(LockedConfigSchema.safeParse({ beaconDelay: 120, free: c.free }).success).toBe(true);
    expect(LockedConfigSchema.safeParse({ beaconDelay: 120, stakes: c.stakes }).success).toBe(true);
    expect(
      LockedConfigSchema.safeParse(patched({ free: { awardRecipient: null, creatorAwardBps: 0 } }))
        .success,
    ).toBe(true);
  });

  it('accepts the edges of every bound', () => {
    for (const p of [
      { beaconDelay: 60 },
      { beaconDelay: 600 },
      { free: { capMultiple: 1, minEntrants: 1 } },
      { free: { stakeMin: '1', stakeMax: '1', presets: ['1'] } },
      { free: { stakeMax: '18446744073709551615', creatorAwardBps: 10_000 } },
      { stakes: { stake: '1000000' } },
      { stakes: { stake: '100000000', feeBps: 0, creatorBps: 0 } },
      { stakes: { capMultiple: 1, minEntrants: 1, feeBps: 500, creatorBps: 100 } },
      { stakes: { capMultiple: 10, minEntrants: 4294967295 } },
    ] satisfies Patch[]) {
      expect(LockedConfigSchema.safeParse(patched(p)).error).toBeUndefined();
    }
  });

  it.each<[string, Patch]>([
    ['beaconDelay below 60 s', { beaconDelay: 59 }],
    ['beaconDelay above 10 min', { beaconDelay: 601 }],
    ['fractional beaconDelay', { beaconDelay: 120.5 }],
    ['unknown top-level key', { timezone: 'America/New_York' }],
    ['Free capMultiple 0', { free: { capMultiple: 0 } }],
    ['Free minEntrants 0', { free: { minEntrants: 0 } }],
    ['Free feeBps', { free: { feeBps: 1 } }],
    ['Free creatorBps', { free: { creatorBps: 1 } }],
    ['Free creatorAwardBps over 10000', { free: { creatorAwardBps: 10_001 } }],
    ['Free stakeMin above stakeMax', { free: { stakeMin: '101', presets: ['101'] } }],
    ['Free stake 0', { free: { stakeMin: '0' } }],
    ['Free stake over uint64', { free: { stakeMax: '18446744073709551616' } }],
    ['Free stake as a number', { free: { stakeMin: 10 } }],
    ['Free stake with a leading zero', { free: { stakeMin: '010' } }],
    ['Free stake with decimals', { free: { stakeMin: '10.0' } }],
    ['Free preset outside the range', { free: { presets: ['10', '200'] } }],
    ['Free presets not ascending', { free: { presets: ['50', '10'] } }],
    ['Free presets repeated', { free: { presets: ['10', '10'] } }],
    ['Free presets empty', { free: { presets: [] } }],
    ['Free award recipient not a ULID', { free: { awardRecipient: 'user_1' } }],
    ['Free unknown key', { free: { stakeStep: '5' } }],
    ['Stakes capMultiple 0', { stakes: { capMultiple: 0 } }],
    ['Stakes capMultiple 11', { stakes: { capMultiple: 11 } }],
    ['Stakes minEntrants 0', { stakes: { minEntrants: 0 } }],
    ['Stakes feeBps 501', { stakes: { feeBps: 501 } }],
    ['Stakes creatorBps 101', { stakes: { creatorBps: 101 } }],
    ['Stakes stake under 1 USDC', { stakes: { stake: '999999' } }],
    ['Stakes stake over 100 USDC', { stakes: { stake: '100000001' } }],
    ['Stakes zero creator', { stakes: { creator: '0x0000000000000000000000000000000000000000' } }],
    [
      'Stakes upper-case creator',
      { stakes: { creator: '0x00000000000000000000000000000000000A11CE' } },
    ],
    [
      'Stakes checksummed creator',
      { stakes: { creator: '0x00000000000000000000000000000000000A11cE' } },
    ],
    ['Stakes short address', { stakes: { creator: '0x1234' } }],
  ])('rejects %s', (_name, p) => {
    expect(LockedConfigSchema.safeParse(patched(p)).success).toBe(false);
  });

  it('rejects a config with no mode', () => {
    expect(LockedConfigSchema.safeParse({ beaconDelay: 120 }).success).toBe(false);
  });

  it('matches the beacon-delay bounds of @flocked/tlock and the escrow constants', () => {
    expect(LOCKED_CONFIG_BOUNDS.beaconDelay).toEqual({
      min: MIN_BEACON_DELAY,
      max: MAX_BEACON_DELAY,
    });
    const sol = readFileSync(
      resolve(import.meta.dirname, '../../../contracts/src/FlockedEscrow.sol'),
      'utf8',
    );
    const constant = (name: string): bigint => {
      const m = new RegExp(`constant ${name} = ([0-9e]+)(?: (seconds|minutes))?;`).exec(sol);
      if (!m?.[1]) throw new Error(`${name} not found`);
      const [mant, exp] = m[1].split('e');
      const v = BigInt(mant ?? '0') * 10n ** BigInt(exp ?? '0');
      return m[2] === 'minutes' ? v * 60n : v;
    };
    const S = LOCKED_CONFIG_BOUNDS.stakes;
    expect(S.stake.min).toBe(constant('MIN_STAKE'));
    expect(S.stake.max).toBe(constant('MAX_STAKE'));
    expect(BigInt(S.feeBps.max)).toBe(constant('MAX_FEE_BPS'));
    expect(BigInt(S.creatorBps.max)).toBe(constant('MAX_CREATOR_BPS'));
    expect(BigInt(S.capMultiple.min)).toBe(constant('MIN_CAP_MULTIPLE'));
    expect(BigInt(S.capMultiple.max)).toBe(constant('MAX_CAP_MULTIPLE'));
    expect(BigInt(LOCKED_CONFIG_BOUNDS.beaconDelay.min)).toBe(constant('MIN_BEACON_DELAY'));
    expect(BigInt(LOCKED_CONFIG_BOUNDS.beaconDelay.max)).toBe(constant('MAX_BEACON_DELAY'));
  });
});

describe('freeConfigHash', () => {
  const PINNED_JSON =
    '{"beaconDelay":120,"free":{"awardRecipient":"01JAB2C3D4E5F6G7H8J9K0M1N2","capMultiple":10,' +
    '"creatorAwardBps":100,"creatorBps":0,"feeBps":0,"minEntrants":1,"presets":["10","25","50","100"],' +
    '"stakeMax":"100","stakeMin":"10"}}';

  it('is keccak256 of the canonical JSON of {beaconDelay, free}', () => {
    expect(freeConfigCanonicalJson(defaults())).toBe(PINNED_JSON);
    expect(freeConfigHash(defaults())).toBe(keccak256(stringToBytes(PINNED_JSON)));
    expect(freeConfigHash(defaults())).toBe(
      '0xd3357372b9791fc71cc2b8746f5e6db6f7b11613a8d4c7726f31278e4f2f7ef8',
    );
  });

  it('ignores the Stakes section and key order', () => {
    const c = defaults();
    const reverse = (o: object) => Object.fromEntries(Object.entries(o).reverse());
    const reordered = reverse({ ...c, free: reverse(c.free ?? {}) }) as LockedConfig;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(c));
    const freeOnly = { beaconDelay: c.beaconDelay, free: c.free };
    expect(freeConfigHash(freeOnly)).toBe(freeConfigHash(c));
    expect(freeConfigHash(reordered)).toBe(freeConfigHash(c));
    expect(freeConfigHash(patched({ stakes: { stake: '6000000' } }) as LockedConfig)).toBe(
      freeConfigHash(c),
    );
  });

  it.each<[string, Patch]>([
    ['beaconDelay', { beaconDelay: 121 }],
    ['stakeMin', { free: { stakeMin: '5', presets: ['5', '25', '50', '100'] } }],
    ['stakeMax', { free: { stakeMax: '101' } }],
    ['presets', { free: { presets: ['10', '20', '50', '100'] } }],
    ['capMultiple', { free: { capMultiple: 9 } }],
    ['minEntrants', { free: { minEntrants: 2 } }],
    ['creatorAwardBps', { free: { creatorAwardBps: 50 } }],
    ['awardRecipient', { free: { awardRecipient: null } }],
  ])('changes with %s', (_name, p) => {
    expect(freeConfigHash(patched(p) as LockedConfig)).not.toBe(freeConfigHash(defaults()));
  });

  it('throws without a Free mode or on an invalid config', () => {
    const stakesOnly = { beaconDelay: 120, stakes: defaults().stakes };
    expect(() => freeConfigHash(stakesOnly)).toThrow(RangeError);
    expect(() => freeConfigHash(patched({ beaconDelay: 1 }) as LockedConfig)).toThrow();
  });
});

describe('questionHash', () => {
  it('matches values computed with `cast abi-encode` + `cast keccak`', () => {
    // cast keccak $(cast abi-encode "f(string,string,string,string,string)" "Pineapple on pizza?" "Yes" "🍍" "No" "")
    expect(
      questionHash({
        prompt: 'Pineapple on pizza?',
        options: [{ label: 'Yes', emoji: '🍍' }, { label: 'No' }],
      }),
    ).toBe('0xad64b5ecb473bad69ef89e7f4755673406dc5b8060387a89fc03e51cc6ab7cf0');
    expect(
      questionHash({
        prompt: 'Café or tea?',
        options: [
          { label: 'Café', emoji: '☕' },
          { label: 'Tea', emoji: '🍵' },
        ],
      }),
    ).toBe('0xbdb1fd0461e740b6bf228e58ce11b3fd3f32963cade9c5046c54645943d8eefa');
  });

  it('NFC-normalizes: composed and decomposed é hash the same', () => {
    const composed = questionHash({
      prompt: 'Café or tea?',
      options: [
        { label: 'Café', emoji: '☕' },
        { label: 'Tea', emoji: '🍵' },
      ],
    });
    const decomposed = questionHash({
      prompt: 'Café or tea?',
      options: [
        { label: 'Café', emoji: '☕' },
        { label: 'Tea', emoji: '🍵' },
      ],
    });
    expect(decomposed).toBe(composed);
  });

  it('trims, and treats a missing, null or empty emoji alike', () => {
    const base = questionHash({ prompt: 'Q?', options: [{ label: 'A' }, { label: 'B' }] });
    expect(
      questionHash({
        prompt: '  Q?\n',
        options: [
          { label: '\tA ', emoji: null },
          { label: ' B', emoji: '  ' },
        ],
      }),
    ).toBe(base);
    expect(
      questionHash({
        prompt: 'Q?',
        options: [
          { label: 'A', emoji: '' },
          { label: 'B', emoji: undefined },
        ],
      }),
    ).toBe(base);
  });

  it('distinguishes option order and field boundaries', () => {
    const q = (prompt: string, a: string, ea: string, b: string) =>
      questionHash({ prompt, options: [{ label: a, emoji: ea }, { label: b }] });
    expect(q('Q?', 'A', '', 'B')).not.toBe(q('Q?', 'B', '', 'A'));
    expect(q('Q?', 'AB', '', 'C')).not.toBe(q('Q?', 'A', 'B', 'C'));
    expect(q('Q?A', 'B', '', 'C')).not.toBe(q('Q?', 'AB', '', 'C'));
  });

  it('throws on an empty prompt or label', () => {
    expect(() => questionHash({ prompt: ' ', options: [{ label: 'A' }, { label: 'B' }] })).toThrow(
      RangeError,
    );
    expect(() => questionHash({ prompt: 'Q?', options: [{ label: 'A' }, { label: '' }] })).toThrow(
      RangeError,
    );
  });
});
