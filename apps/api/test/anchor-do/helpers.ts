// AnchorDO test helpers: a fake chain (fake-chain.ts) wired into a fresh AnchorDO per test, the
// game clock and chain clock moved together, item builders and an alert spy.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { newUlid, roundKey, type AlertCode } from '@flocked/shared';
import { beaconTime, chainFromEnv, firstRoundAtOrAfter } from '@flocked/tlock';
import { keccak256, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { vi, type MockInstance } from 'vitest';
import type { AnchorDO } from '../../src/do/anchor-do.js';
import type { AnchorCommitItem, AnchorLockItem } from '../../src/do/types.js';
import { FAKE_DEPLOYMENT, FakeChain } from './fake-chain.js';

export const drand = chainFromEnv(env as unknown as Record<string, string | undefined>);

/** 2026-10-20 21:00 America/New_York (EDT), epoch ms. */
export const T0 = Date.UTC(2026, 9, 21, 1, 0, 0);

export interface Harness {
  fake: FakeChain;
  stub: DurableObjectStub<AnchorDO>;
  anchorer: Hex;
  /** Moves the game clock and the chain clock to `ms`. */
  at(ms: number): void;
  /** Runs the DO's alarm once (false if none was set). */
  run(): Promise<boolean>;
}

/** A fresh AnchorDO (its own name) on a fresh fake chain, with a throwaway anchor key. */
export async function harness(t0 = T0): Promise<Harness> {
  const key = generatePrivateKey();
  const fake = new FakeChain({ genesis: drand.genesis, period: drand.period }, t0 / 1000);
  Object.assign(env, {
    ENVIRONMENT: 'local',
    CHAIN_ID: '31337',
    FLOCKED_TEST_CLOCK: String(t0),
    ANCHOR_KEY: key,
    LOCAL_DEPLOYMENT: FAKE_DEPLOYMENT,
  });
  const stub = env.ANCHOR.get(env.ANCHOR.idFromName(`anchor-test-${newUlid()}`));
  await runInDurableObject(stub, (inst: AnchorDO) => {
    inst.transportOverride = fake.transport;
    inst.manualAlarms = true;
  });
  return {
    fake,
    stub,
    anchorer: privateKeyToAccount(key).address.toLowerCase() as Hex,
    at(ms) {
      Object.assign(env, { FLOCKED_TEST_CLOCK: String(ms) });
      fake.time = Math.floor(ms / 1000);
    },
    run: () => runDurableObjectAlarm(stub),
  };
}

/** A D1 round (unlocked is enough for the AnchorDO) with its Free `round_modes` row. */
export async function insertRound(
  closesAtSec: number,
  kind: 'daily' | 'room' = 'room',
): Promise<string> {
  const id = newUlid();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO rounds (id, kind, room_id, opens_at, closes_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(
      id,
      kind,
      kind === 'room' ? newUlid() : null,
      (closesAtSec - 86_400) * 1000,
      closesAtSec * 1000,
      'open',
    ),
    env.DB.prepare(
      "INSERT INTO round_modes (round_id, mode, status) VALUES (?1, 'free', 'pending')",
    ).bind(id),
  ]);
  return id;
}

export function lockItem(roundId: string, closesAtSec: number, beaconDelay = 120): AnchorLockItem {
  return {
    roundKey: roundKey(roundId, 'free'),
    roundId,
    mode: 'free',
    closesAtSec,
    beaconRound: firstRoundAtOrAfter(drand, closesAtSec + beaconDelay),
    questionHash: keccak256(stringToHex(`question ${roundId}`)),
    configHash: keccak256(stringToHex(`config ${roundId}`)),
  };
}

export function commitItem(lock: AnchorLockItem, entryCount = 3): AnchorCommitItem {
  return {
    roundKey: lock.roundKey,
    roundId: lock.roundId,
    mode: 'free',
    root: keccak256(stringToHex(`root ${lock.roundId}`)),
    entryCount,
    totalStake: String(entryCount * 25),
    closesAtSec: lock.closesAtSec,
    beaconRound: lock.beaconRound,
    beaconTimeSec: beaconTime(drand, lock.beaconRound),
  };
}

/** Writes a lock leaf straight into the fake contract (as an earlier transaction would have). */
export function lockOnchain(fake: FakeChain, l: AnchorLockItem): void {
  fake.anchors.set(l.roundKey, {
    ...fake.anchorOf(l.roundKey),
    closesAt: BigInt(l.closesAtSec),
    beaconRound: BigInt(l.beaconRound),
    lockedAt: BigInt(fake.time - 3600),
    questionHash: l.questionHash,
    configHash: l.configHash,
  });
}

/** Spies on Analytics Engine writes; `codes()` lists the alert codes raised since. */
export function alertSpy(): { codes(): AlertCode[]; spy: MockInstance } {
  const spy = vi.spyOn(env.ANALYTICS, 'writeDataPoint');
  return {
    spy,
    codes: () => spy.mock.calls.map((c) => (c[0] as { indexes: [AlertCode] }).indexes[0]),
  };
}

export async function anchorsRows(): Promise<
  { kind: string; round_keys_json: string; tx_hash: string; block_timestamp: number | null }[]
> {
  const { results } = await env.DB.prepare(
    'SELECT kind, round_keys_json, tx_hash, block_timestamp FROM anchors ORDER BY created_at, id',
  ).all<{
    kind: string;
    round_keys_json: string;
    tx_hash: string;
    block_timestamp: number | null;
  }>();
  return results;
}
