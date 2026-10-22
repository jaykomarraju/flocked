// The `RoundCreated` check (spec "Smart contract" › Challenge window, watcher and guardian): the
// onchain config against the config published at lock, and against the rules that do not depend on
// the backend —
//   - for house questions, creator = treasury;
//   - otherwise, creator holds unrevoked Verified Account and allowed Verified Country attestations;
//   - the stake, fees, cap and minEntrants are the launch defaults unless a matching override was
//     published before lock.
// A mismatch pages the guardian to `voidRound` before close.
import { Checks } from '@flocked/verify';
import {
  MAX_BEACON_DELAY,
  MIN_BEACON_DELAY,
  firstRoundAtOrAfter,
  type DrandChain,
} from '@flocked/tlock';
import { isAddressEqual, type Address } from 'viem';
import type { PublishedConfig, PublishedOverride, PublishedStakesConfig } from './api.js';
import type { AttestationReader } from './attest.js';
import type { OnchainRoundConfig, RoundCreatedLog } from './chain.js';
import type { RoundSnapshot } from './db.js';

/**
 * The launch defaults a Stakes round is held to (spec "Modes: Free and Stakes" and "Sealed picks" ›
 * Round config check: stake 5 USDC, 500/100 bps, cap 10, `minEntrants` 20 daily and 3 for rooms).
 * They are repeated here, not imported from `@flocked/shared`, so the backend cannot move the bar
 * the watcher holds it to.
 */
export const LAUNCH_DEFAULTS = {
  stake: 5_000_000n,
  feeBps: 500,
  creatorBps: 100,
  capMultiple: 10,
  minEntrants: { daily: 20, room: 3 },
} as const;

/** The `overrides` field name for each value the defaults cover. */
const OVERRIDE_FIELD: Record<DefaultedField, string> = {
  stake: 'stakes.stake',
  feeBps: 'stakes.feeBps',
  creatorBps: 'stakes.creatorBps',
  capMultiple: 'stakes.capMultiple',
  minEntrants: 'stakes.minEntrants',
};

type DefaultedField = 'stake' | 'feeBps' | 'creatorBps' | 'capMultiple' | 'minEntrants';

/** An override counts only when it names the field and carries the value that was used. */
function overrideFor(
  overrides: readonly PublishedOverride[],
  field: DefaultedField,
  actual: string,
): PublishedOverride | undefined {
  return overrides.find((o) => o.field === OVERRIDE_FIELD[field] && String(o.value) === actual);
}

export interface RoundCreatedCheckInput {
  snapshot: RoundSnapshot;
  published: PublishedConfig;
  stakes: PublishedStakesConfig;
  created: RoundCreatedLog | null;
  treasury: Address;
  drand: DrandChain;
  /** Verified Country codes legal approved, as the owner set them (empty: the check cannot run). */
  countryAllow: readonly string[];
  attestations: AttestationReader;
  nowSec: bigint;
}

/** Compares one onchain field with the published one. */
function field(checks: Checks, name: string, onchain: unknown, published: unknown): void {
  checks.equal(`created.${name}`, `onchain ${name}`, String(published), String(onchain));
}

function checkDefaults(
  checks: Checks,
  cfg: OnchainRoundConfig,
  overrides: readonly PublishedOverride[],
  kind: 'daily' | 'room',
): void {
  const actual: Record<DefaultedField, string> = {
    stake: String(cfg.stake),
    feeBps: String(cfg.feeBps),
    creatorBps: String(cfg.creatorBps),
    capMultiple: String(cfg.capMultiple),
    minEntrants: String(cfg.minEntrants),
  };
  const wanted: Record<DefaultedField, string> = {
    stake: String(LAUNCH_DEFAULTS.stake),
    feeBps: String(LAUNCH_DEFAULTS.feeBps),
    creatorBps: String(LAUNCH_DEFAULTS.creatorBps),
    capMultiple: String(LAUNCH_DEFAULTS.capMultiple),
    minEntrants: String(LAUNCH_DEFAULTS.minEntrants[kind]),
  };
  for (const name of Object.keys(actual) as DefaultedField[]) {
    if (actual[name] === wanted[name]) {
      checks.pass(`created.default.${name}`, `${name} is the launch default (${wanted[name]})`);
      continue;
    }
    const o = overrideFor(overrides, name, actual[name]);
    if (o) {
      checks.pass(
        `created.default.${name}`,
        `${name} is ${actual[name]}, published as an override before lock (audit ${o.auditId})`,
      );
    } else {
      checks.fail(
        `created.default.${name}`,
        `${name} is not the launch default and no matching override was published before lock`,
        wanted[name],
        actual[name],
      );
    }
  }
}

async function checkCreator(
  checks: Checks,
  i: RoundCreatedCheckInput,
  cfg: OnchainRoundConfig,
): Promise<void> {
  const { stakes, treasury } = i;
  const toTreasury = isAddressEqual(cfg.creator, treasury);
  if (toTreasury) {
    // The treasury takes the creator fee for house questions, and for an author who did not resolve
    // to a payout wallet at lock. Either way the published config must name no payout address.
    if (stakes.payoutAddress === null) {
      checks.pass(
        'created.creator',
        'creator is the escrow treasury and no payout address is published',
      );
    } else {
      checks.fail(
        'created.creator',
        'creator is the treasury although the published config names an author payout address',
        stakes.payoutAddress,
        cfg.creator,
      );
    }
    checks.skip('created.attestations', 'the creator is the treasury, not an author wallet');
    checks.skip('created.country', 'the creator is the treasury, not an author wallet');
    return;
  }

  if (stakes.payoutAddress === null) {
    checks.fail(
      'created.creator',
      'creator is neither the treasury nor a published author payout address',
      `${treasury} or a published payoutAddress`,
      cfg.creator,
    );
  } else if (!isAddressEqual(cfg.creator, stakes.payoutAddress as Address)) {
    checks.fail(
      'created.creator',
      'creator is not the author payout address published at lock',
      stakes.payoutAddress,
      cfg.creator,
    );
  } else {
    checks.pass('created.creator', 'creator is the author payout address published at lock');
  }

  let country: string | null;
  try {
    const a = await i.attestations(cfg.creator, i.nowSec);
    country = a.country;
    if (a.verifiedAccount) {
      checks.pass(
        'created.attestations',
        'the creator holds an unrevoked Verified Account attestation',
      );
    } else {
      checks.fail(
        'created.attestations',
        'the creator holds no unrevoked Verified Account attestation from Coinbase',
      );
    }
  } catch (e) {
    checks.error('created.attestations', `the attestation read failed: ${(e as Error).message}`);
    checks.error('created.country', 'the attestation read failed, so the country is unknown');
    return;
  }
  if (country === null) {
    checks.fail(
      'created.country',
      'the creator holds no unrevoked Verified Country attestation from Coinbase',
    );
  } else if (i.countryAllow.length === 0) {
    checks.error(
      'created.country',
      `COUNTRY_ALLOW is not configured, so the watcher cannot judge the creator's country (${country})`,
    );
  } else if (i.countryAllow.includes(country)) {
    checks.pass('created.country', `the creator's Verified Country ${country} is allowed`);
  } else {
    checks.fail(
      'created.country',
      "the creator's Verified Country is not on the watcher's allowed list",
      i.countryAllow.join(','),
      country,
    );
  }
}

function checkBeaconRound(
  checks: Checks,
  i: RoundCreatedCheckInput,
  cfg: OnchainRoundConfig,
): void {
  const closesAt = Number(cfg.closesAt);
  const delay = i.published.beaconDelay;
  const want = firstRoundAtOrAfter(i.drand, closesAt + delay);
  const t = i.drand.genesis + (Number(cfg.beaconRound) - 1) * i.drand.period;
  if (t < closesAt + MIN_BEACON_DELAY || t > closesAt + MAX_BEACON_DELAY) {
    checks.fail(
      'created.beaconWindow',
      `the beacon time is outside [closesAt + ${MIN_BEACON_DELAY}, closesAt + ${MAX_BEACON_DELAY}]`,
      `${closesAt + MIN_BEACON_DELAY}..${closesAt + MAX_BEACON_DELAY}`,
      String(t),
    );
  } else {
    checks.pass('created.beaconWindow', 'the beacon time is inside the contract window');
  }
  checks.equal(
    'created.beaconRound',
    `beaconRound is the first drand round at or after closesAt + ${delay}s`,
    String(want),
    String(cfg.beaconRound),
  );
}

/** Runs every `RoundCreated` check. The caller turns the collected checks into a verdict. */
export async function checkRoundCreated(i: RoundCreatedCheckInput): Promise<Checks> {
  const checks = new Checks();

  // The snapshot is the watcher's own copy of what was published at lock. One taken after the round
  // closed proves nothing about what entrants were shown, so the verdict is `unable`, not `match`.
  if (i.snapshot.snapshotAt >= i.snapshot.closesAt * 1000) {
    checks.error(
      'snapshot.independent',
      'the published config was first seen at or after close, so it cannot be compared independently',
    );
  } else {
    checks.pass(
      'snapshot.independent',
      `the published config was snapshotted at ${new Date(i.snapshot.snapshotAt).toISOString()}, before close`,
    );
  }

  if (!i.created) {
    checks.error(
      'created.log',
      `no RoundCreated log for escrow round ${i.stakes.chainRoundId} on this RPC`,
    );
    return checks;
  }
  checks.pass('created.log', `RoundCreated in ${i.created.txHash}`);

  const cfg = i.created.cfg;
  const s = i.stakes;
  field(checks, 'opensAt', cfg.opensAt, s.opensAt);
  field(checks, 'closesAt', cfg.closesAt, s.closesAt);
  field(checks, 'beaconRoundPublished', cfg.beaconRound, s.beaconRound);
  field(checks, 'stake', cfg.stake, s.stake);
  field(checks, 'feeBps', cfg.feeBps, s.feeBps);
  field(checks, 'creatorBps', cfg.creatorBps, s.creatorBps);
  field(checks, 'capMultiple', cfg.capMultiple, s.capMultiple);
  field(checks, 'minEntrants', cfg.minEntrants, s.minEntrants);
  field(checks, 'creatorPublished', cfg.creator, s.creator);
  field(checks, 'questionHash', cfg.questionHash, s.questionHash);

  await checkCreator(checks, i, cfg);
  checkDefaults(checks, cfg, i.published.overrides, i.snapshot.kind);
  checkBeaconRound(checks, i, cfg);
  return checks;
}
