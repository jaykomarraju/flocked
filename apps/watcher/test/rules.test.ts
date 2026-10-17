// The `RoundCreated` check (spec "Smart contract" › Challenge window, watcher and guardian). A
// mismatch here is what pages the guardian to `voidRound` before close, so each rule is checked on
// its own: the published config, the creator, the launch defaults and the beacon round.
import { QUICKNET, firstRoundAtOrAfter } from '@flocked/tlock';
import { describe, expect, it } from 'vitest';
import type { PublishedConfig, PublishedStakesConfig } from '../src/api.js';
import type { WalletAttestations } from '../src/attest.js';
import type { RoundCreatedLog } from '../src/chain.js';
import type { RoundSnapshot } from '../src/db.js';
import { decide } from '../src/decide.js';
import { LAUNCH_DEFAULTS, checkRoundCreated } from '../src/rules.js';
import { BEACON_DELAY, CLOSES_AT, OPENS_AT, ROUND_ID, TREASURY } from './fixture.js';
import type { Address, Hex } from 'viem';

const AUTHOR: Address = '0x000000000000000000000000000000000000a070';
const QUESTION_HASH: Hex = `0x${'11'.repeat(32)}`;
const BEACON_ROUND = firstRoundAtOrAfter(QUICKNET, CLOSES_AT + BEACON_DELAY);

function stakesConfig(over: Partial<PublishedStakesConfig> = {}): PublishedStakesConfig {
  return {
    chainRoundId: '7',
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
    beaconRound: BEACON_ROUND,
    stake: String(LAUNCH_DEFAULTS.stake),
    feeBps: LAUNCH_DEFAULTS.feeBps,
    creatorBps: LAUNCH_DEFAULTS.creatorBps,
    capMultiple: LAUNCH_DEFAULTS.capMultiple,
    minEntrants: LAUNCH_DEFAULTS.minEntrants.daily,
    creator: TREASURY,
    questionHash: QUESTION_HASH,
    authorHandle: null,
    payoutAddress: null,
    ...over,
  };
}

function published(stakes: PublishedStakesConfig, overrides: PublishedConfig['overrides'] = []) {
  return { beaconDelay: BEACON_DELAY, stakes, overrides } satisfies PublishedConfig;
}

function snapshot(config: PublishedConfig, over: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    roundId: ROUND_ID,
    gameDay: '2026-10-17',
    kind: 'daily',
    roomId: null,
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
    beaconRound: BEACON_ROUND,
    beaconDelay: BEACON_DELAY,
    chainRoundId: '7',
    isHouse: config.stakes?.authorHandle === null,
    config,
    // Snapshotted at open: before close, as the API first shows a locked round.
    snapshotAt: OPENS_AT * 1000,
    ...over,
  };
}

function createdFrom(
  s: PublishedStakesConfig,
  over: Record<string, unknown> = {},
): RoundCreatedLog {
  return {
    cfg: {
      opensAt: BigInt(s.opensAt),
      closesAt: BigInt(s.closesAt),
      beaconRound: BigInt(s.beaconRound),
      stake: BigInt(s.stake),
      feeBps: s.feeBps,
      creatorBps: s.creatorBps,
      capMultiple: s.capMultiple,
      minEntrants: s.minEntrants,
      creator: s.creator as Address,
      questionHash: s.questionHash as Hex,
      ...over,
    },
    txHash: `0x${'22'.repeat(32)}`,
    blockNumber: 10n,
  };
}

const ATTESTED: WalletAttestations = { verifiedAccount: true, country: 'US' };

async function run(i: {
  stakes?: PublishedStakesConfig;
  overrides?: PublishedConfig['overrides'];
  created?: RoundCreatedLog | null;
  snapshotOver?: Partial<RoundSnapshot>;
  countryAllow?: string[];
  attestations?: WalletAttestations | Error;
}) {
  const stakes = i.stakes ?? stakesConfig();
  const cfg = published(stakes, i.overrides);
  const checks = await checkRoundCreated({
    snapshot: snapshot(cfg, i.snapshotOver),
    published: cfg,
    stakes,
    created: i.created === undefined ? createdFrom(stakes) : i.created,
    treasury: TREASURY,
    drand: QUICKNET,
    countryAllow: i.countryAllow ?? ['US'],
    attestations: () =>
      i.attestations instanceof Error
        ? Promise.reject(i.attestations)
        : Promise.resolve(i.attestations ?? ATTESTED),
    nowSec: BigInt(OPENS_AT),
  });
  const { verdict, reasons } = decide(checks);
  return {
    verdict,
    reasons,
    failed: checks.list.filter((c) => c.status === 'fail').map((c) => c.id),
    errored: checks.list.filter((c) => c.status === 'error').map((c) => c.id),
  };
}

describe('RoundCreated against the config published at lock', () => {
  it('a house round created exactly as published is a match', async () => {
    const r = await run({});
    expect(r.failed).toEqual([]);
    expect(r.errored).toEqual([]);
    expect(r.verdict).toBe('match');
  });

  it('an onchain field the published config does not name is a mismatch', async () => {
    const stakes = stakesConfig();
    const r = await run({ stakes, created: createdFrom(stakes, { stake: 50_000_000n }) });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toContain('created.stake');
  });

  it('a question hash the published config does not name is a mismatch', async () => {
    const stakes = stakesConfig();
    const r = await run({
      stakes,
      created: createdFrom(stakes, { questionHash: `0x${'33'.repeat(32)}` }),
    });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toContain('created.questionHash');
  });

  it('a round the chain has no RoundCreated log for is unable, not a match', async () => {
    const r = await run({ created: null });
    expect(r.verdict).toBe('unable');
    expect(r.errored).toContain('created.log');
  });

  it('a config first seen after close cannot be compared independently', async () => {
    const r = await run({ snapshotOver: { snapshotAt: (CLOSES_AT + 60) * 1000 } });
    expect(r.verdict).toBe('unable');
    expect(r.errored).toContain('snapshot.independent');
  });
});

describe('the rules that do not depend on the backend', () => {
  it('a house question whose creator is not the treasury is a mismatch', async () => {
    const stakes = stakesConfig({ creator: AUTHOR });
    const r = await run({ stakes });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toContain('created.creator');
  });

  it('a creator that is the treasury although an author payout is published is a mismatch', async () => {
    const stakes = stakesConfig({ authorHandle: 'sheep', payoutAddress: AUTHOR });
    const r = await run({ stakes });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toContain('created.creator');
  });

  it("an author's round is a match when the creator is the published payout wallet and it is attested", async () => {
    const stakes = stakesConfig({
      authorHandle: 'sheep',
      creator: AUTHOR,
      payoutAddress: AUTHOR,
    });
    const r = await run({ stakes });
    expect(r.failed).toEqual([]);
    expect(r.verdict).toBe('match');
  });

  it('a creator with no Verified Account attestation is a mismatch', async () => {
    const stakes = stakesConfig({ authorHandle: 'sheep', creator: AUTHOR, payoutAddress: AUTHOR });
    const r = await run({ stakes, attestations: { verifiedAccount: false, country: 'US' } });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toContain('created.attestations');
  });

  it('a creator whose Verified Country is not allowed is a mismatch', async () => {
    const stakes = stakesConfig({ authorHandle: 'sheep', creator: AUTHOR, payoutAddress: AUTHOR });
    const r = await run({ stakes, attestations: { verifiedAccount: true, country: 'FR' } });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toContain('created.country');
  });

  it('a creator with no Verified Country attestation is a mismatch', async () => {
    const stakes = stakesConfig({ authorHandle: 'sheep', creator: AUTHOR, payoutAddress: AUTHOR });
    const r = await run({ stakes, attestations: { verifiedAccount: true, country: null } });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toContain('created.country');
  });

  it('without an allowed-country list the watcher says unable, never match', async () => {
    const stakes = stakesConfig({ authorHandle: 'sheep', creator: AUTHOR, payoutAddress: AUTHOR });
    const r = await run({ stakes, countryAllow: [] });
    expect(r.verdict).toBe('unable');
    expect(r.errored).toContain('created.country');
  });

  it('an attestation read that fails is unable, never match', async () => {
    const stakes = stakesConfig({ authorHandle: 'sheep', creator: AUTHOR, payoutAddress: AUTHOR });
    const r = await run({ stakes, attestations: new Error('rpc down') });
    expect(r.verdict).toBe('unable');
    expect(r.errored).toContain('created.attestations');
  });
});

describe('the launch defaults', () => {
  it('a non-default value with no published override is a mismatch', async () => {
    const stakes = stakesConfig({ minEntrants: 3 });
    const r = await run({ stakes });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toEqual(['created.default.minEntrants']);
  });

  it('a non-default value published as an override before lock is a match', async () => {
    const stakes = stakesConfig({ minEntrants: 3 });
    const r = await run({
      stakes,
      overrides: [{ field: 'stakes.minEntrants', value: 3, auditId: 'audit-1' }],
    });
    expect(r.failed).toEqual([]);
    expect(r.verdict).toBe('match');
    expect(r.reasons.join('\n')).toContain('audit-1');
  });

  it('an override that names another value does not cover the one used', async () => {
    const stakes = stakesConfig({ minEntrants: 3 });
    const r = await run({
      stakes,
      overrides: [{ field: 'stakes.minEntrants', value: 5, auditId: 'audit-1' }],
    });
    expect(r.failed).toEqual(['created.default.minEntrants']);
  });

  it('a room round is held to minEntrants 3, not 20', async () => {
    const stakes = stakesConfig({ minEntrants: LAUNCH_DEFAULTS.minEntrants.room });
    const cfg = published(stakes);
    const checks = await checkRoundCreated({
      snapshot: snapshot(cfg, { kind: 'room', roomId: '01K8V3R4N5P6Q7S8T9VWXYZABD' }),
      published: cfg,
      stakes,
      created: createdFrom(stakes),
      treasury: TREASURY,
      drand: QUICKNET,
      countryAllow: ['US'],
      attestations: () => Promise.resolve(ATTESTED),
      nowSec: BigInt(OPENS_AT),
    });
    expect(decide(checks).verdict).toBe('match');
  });
});

describe('the beacon round', () => {
  it('a beaconRound that is not the first at or after closesAt + beaconDelay is a mismatch', async () => {
    const stakes = stakesConfig({ beaconRound: BEACON_ROUND + 2 });
    const r = await run({ stakes });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toContain('created.beaconRound');
  });

  it('a beacon time outside the contract window is a mismatch', async () => {
    const stakes = stakesConfig({ beaconRound: BEACON_ROUND + 1000 });
    const r = await run({ stakes });
    expect(r.verdict).toBe('mismatch');
    expect(r.failed).toContain('created.beaconWindow');
  });
});
