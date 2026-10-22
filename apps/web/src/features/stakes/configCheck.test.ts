// The round config check (spec "Sealed picks (timelock encryption)" › Round config check (Stakes)):
// every onchain `RoundConfig` field against the record published at lock, the beacon round against
// the published `beaconDelay`, and the locked values against the launch defaults.
import { questionHash, type RoundView, type StakesConfigWire } from '@flocked/shared';
import { beaconTime, firstRoundAtOrAfter, QUICKNET } from '@flocked/tlock';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { TEST_CHAIN, testRound } from '../../crypto/testing';
import {
  checkRoundConfig,
  LAUNCH_DEFAULTS,
  nonDefaults,
  type ConfigCheck,
  type EscrowReader,
} from './configCheck';

const TREASURY: Address = '0x00000000000000000000000000000000000c0ffe';
const BEACON_DELAY = 120;

/** A locked Stakes round at the launch defaults, with the chain agreeing field for field. */
function stakesRound(over: Partial<StakesConfigWire> = {}, roundOver: Partial<RoundView> = {}) {
  const base = testRound();
  const closesAt = base.closesAt;
  const beaconRound = firstRoundAtOrAfter(QUICKNET, closesAt + BEACON_DELAY);
  const stakes: StakesConfigWire = {
    chainRoundId: '7',
    opensAt: base.opensAt,
    closesAt,
    beaconRound,
    stake: String(LAUNCH_DEFAULTS.stake),
    feeBps: LAUNCH_DEFAULTS.feeBps,
    creatorBps: LAUNCH_DEFAULTS.creatorBps,
    capMultiple: LAUNCH_DEFAULTS.capMultiple,
    minEntrants: LAUNCH_DEFAULTS.minEntrantsDaily,
    creator: TREASURY,
    questionHash: questionHash(base.question),
    authorHandle: null,
    payoutAddress: null,
    ...over,
  };
  const round: RoundView = {
    ...base,
    beaconRound,
    beaconTime: beaconTime(QUICKNET, beaconRound),
    config: { beaconDelay: BEACON_DELAY, stakes, overrides: [] },
    modes: { stakes: { ...base.modes.free!, chainRoundId: '7' } },
    ...roundOver,
  };
  return { round, stakes };
}

/** A reader that serves exactly what the published config says, with `over` applied. */
function reader(stakes: StakesConfigWire, over: Record<string, unknown> = {}): EscrowReader {
  return {
    roundConfig: () =>
      Promise.resolve({
        opensAt: BigInt(stakes.opensAt),
        closesAt: BigInt(stakes.closesAt),
        beaconRound: BigInt(stakes.beaconRound),
        stake: BigInt(stakes.stake),
        feeBps: stakes.feeBps,
        creatorBps: stakes.creatorBps,
        capMultiple: stakes.capMultiple,
        minEntrants: stakes.minEntrants,
        creator: stakes.creator as Address,
        questionHash: stakes.questionHash as Hex,
        ...over,
      }),
  };
}

const check = (round: RoundView, r: EscrowReader) =>
  checkRoundConfig({ round, chain: TEST_CHAIN, reader: r });

/** The fields a refusal names; throws when the check passed or could not read the chain. */
function mismatchFields(result: ConfigCheck): string[] {
  if (result.ok) throw new Error('expected a refusal');
  if (result.reason !== 'mismatch') throw new Error(`expected a mismatch, got ${result.reason}`);
  return result.mismatches.map((m) => m.field);
}

describe('checkRoundConfig', () => {
  it('passes when every field agrees, and finds nothing non-default at the launch values', async () => {
    const { round, stakes } = stakesRound();
    await expect(check(round, reader(stakes))).resolves.toEqual({ ok: true, nonDefaults: [] });
  });

  // One per `RoundConfig` field: each on its own refuses the entry.
  const FIELDS: [string, Record<string, unknown>][] = [
    ['opensAt', { opensAt: 1n }],
    ['closesAt', { closesAt: 1n }],
    ['stake', { stake: 50_000_000n }],
    ['feeBps', { feeBps: 250 }],
    ['creatorBps', { creatorBps: 0 }],
    ['capMultiple', { capMultiple: 3 }],
    ['minEntrants', { minEntrants: 30 }],
    ['creator', { creator: '0x000000000000000000000000000000000000dead' }],
    ['questionHash', { questionHash: `0x${'11'.repeat(32)}` }],
  ];
  it.each(FIELDS)('refuses when the chain disagrees about %s', async (...args) => {
    const [field, over] = args;
    const { round, stakes } = stakesRound();
    expect(mismatchFields(await check(round, reader(stakes, over)))).toContain(field);
  });

  it('refuses when the beacon round does not follow from the published beaconDelay', async () => {
    const { round, stakes } = stakesRound();
    // The chain agrees with the published beaconRound, but neither matches closesAt + delay.
    const shifted = stakes.beaconRound + 10;
    const result = await check(
      { ...round, config: { ...round.config!, stakes: { ...stakes, beaconRound: shifted } } },
      reader({ ...stakes, beaconRound: shifted }),
    );
    expect(mismatchFields(result)).toEqual(['beaconRound (delay)']);
  });

  it('refuses a round that was never created onchain', async () => {
    const { round, stakes } = stakesRound();
    const result = await check(round, reader(stakes, { closesAt: 0n, stake: 0n }));
    expect(mismatchFields(result)).toEqual(['round']);
  });

  it('refuses, rather than trusting the API, when the chain cannot be read', async () => {
    const { round } = stakesRound();
    const result = await check(round, { roundConfig: () => Promise.reject(new Error('rpc')) });
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses a round with no locked Stakes config', async () => {
    const { round, stakes } = stakesRound();
    const result = await check({ ...round, config: null }, reader(stakes));
    expect(result.ok).toBe(false);
  });

  it('reports the non-default values with the audit rows that set them', async () => {
    const { round, stakes } = stakesRound(
      { stake: '10000000', minEntrants: 30 },
      {
        config: {
          beaconDelay: BEACON_DELAY,
          overrides: [
            { field: 'stakes.stake', value: '10000000', auditId: 'A1F3' },
            { field: 'stakes.minEntrants', value: 30, auditId: 'A1F4' },
          ],
          stakes: undefined,
        },
      },
    );
    const withOverrides: RoundView = {
      ...round,
      config: { ...round.config!, stakes },
    };
    const result = await check(withOverrides, reader(stakes));
    expect(result).toEqual({
      ok: true,
      nonDefaults: [
        { field: 'stake', value: '10.00 USDC', usual: '5.00 USDC', auditId: 'A1F3' },
        { field: 'minEntrants', value: '30', usual: '20', auditId: 'A1F4' },
      ],
    });
  });

  it('measures a room round against the room minimum', () => {
    const { round, stakes } = stakesRound(
      { minEntrants: 3 },
      { roomId: '01JA0000000000000000000ROO' },
    );
    expect(nonDefaults(round, stakes)).toEqual([]);
    expect(nonDefaults({ ...round, roomId: null }, stakes)).toEqual([
      { field: 'minEntrants', value: '3', usual: '20', auditId: null },
    ]);
  });
});
