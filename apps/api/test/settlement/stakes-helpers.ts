// Stakes settlement test helpers (W6-A): a round seeded both in D1 (as the indexer stores it) and on
// the fake escrow chain (as the stream reads it), from the same entries, and a SettlementDO harness
// whose chain calls go to the fake. Ciphertexts are real tlock ciphertexts for the recorded quicknet
// beacon (helpers.ts), sealed to the onchain round reference.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  newUlid,
  type LockedConfig,
} from '@flocked/shared';
import { QUICKNET, encodePlaintext, encryptPick, roundRefFromChainId } from '@flocked/tlock';
import { bytesToHex, keccak256, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import type { SettlementDO } from '../../src/do/settlement-do.js';
import type { SettlementStatus } from '../../src/do/types.js';
import type { TallyResult } from '../../src/settlement/types.js';
import { BEACON, BEACON_TIME_MS, fakeRelays, recordDecryptQueues, settlement } from './helpers.js';
import { decryptHandler } from '../../src/queues/decrypt.js';
import { FAKE_DEPLOYMENT, FakeEscrowChain } from './stakes-chain.js';

const randomHex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

/** A pick: an option, or a VOID (a ciphertext that opens to no valid plaintext). */
export type Pick = 0 | 1 | 'void';

export interface SeededStakesEntry {
  id: string;
  /** null: a foreign entry (no ticket). */
  userId: string | null;
  wallet: Hex;
  personTag: Hex;
  txHash: Hex;
  block: number;
  ct: Uint8Array;
  pick: Pick;
}

export interface SeededStakes {
  roundId: string;
  chainRoundId: bigint;
  closesAt: number;
  config: LockedConfig;
  stake: bigint;
  entries: SeededStakesEntry[];
  chain: FakeEscrowChain;
}

let seeded = 0;

/** The chain's env: the fake escrow, an operator key, no real provider. */
export function stakesEnv(): void {
  Object.assign(env, {
    ENVIRONMENT: 'local',
    CHAIN_ID: '31337',
    LOCAL_DEPLOYMENT: FAKE_DEPLOYMENT,
    OPERATOR_KEY: generatePrivateKey(),
    BASE_RPC_URL: 'https://primary.invalid',
  });
  delete (env as { BASE_RPC_URL_FALLBACK?: string }).BASE_RPC_URL_FALLBACK;
}

async function sealed(chainRoundId: bigint, pick: Pick): Promise<Uint8Array> {
  const pt = encodePlaintext({
    roundRef: roundRefFromChainId(chainRoundId),
    optionIndex: pick === 'void' ? 0 : pick,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
  });
  // A VOID: an option index the plaintext rules refuse (`bad_option`).
  if (pick === 'void') pt[17] = 2;
  return encryptPick(QUICKNET, BEACON.round, pt);
}

/**
 * A locked daily Stakes round targeting BEACON.round, pending, closed in D1, with one entry per
 * pick: each is an `Entered` on `chain` (one block each, before close) and an `entries` row with its
 * ciphertext. `foreign` entries (by index) have no user. `d1: false` leaves D1 without entries.
 */
export async function seedStakes(
  picks: readonly Pick[],
  opts: {
    chain?: FakeEscrowChain;
    stakes?: Partial<NonNullable<LockedConfig['stakes']>>;
    foreign?: number[];
    d1?: boolean;
  } = {},
): Promise<SeededStakes> {
  const roundId = newUlid();
  const chainRoundId = BigInt(100 + seeded);
  const closesAt = BEACON_TIME_MS - 120_000 - 1000 * seeded++;
  const closesAtSec = closesAt / 1000;
  const config = LockedConfigSchema.parse({
    beaconDelay: 120,
    stakes: {
      ...LOCKED_CONFIG_DEFAULTS.stakes,
      minEntrants: 3,
      creator: `0x${'de'.repeat(20)}`,
      ...opts.stakes,
    },
  });
  const s = config.stakes as NonNullable<LockedConfig['stakes']>;
  const stake = BigInt(s.stake);
  // Block n is stamped t0 + 2n: the head starts 200 s before close.
  const chain = opts.chain ?? new FakeEscrowChain(closesAtSec - 200 - 2 * 1000, 1000);
  chain.addRound(chainRoundId, {
    stake,
    minEntrants: s.minEntrants,
    feeBps: s.feeBps,
    creatorBps: s.creatorBps,
    capMultiple: s.capMultiple,
    closesAt: closesAtSec,
  });
  const entries: SeededStakesEntry[] = [];
  for (const [i, pick] of picks.entries()) {
    const ct = await sealed(chainRoundId, pick);
    const e = chain.enter(chainRoundId, {
      txHash: randomHex(32),
      player: randomHex(20),
      personTag: randomHex(32),
      ticketHash: randomHex(32),
      ciphertext: bytesToHex(ct),
    });
    entries.push({
      id: newUlid(),
      userId: opts.foreign?.includes(i) ? null : newUlid(),
      wallet: e.player.toLowerCase() as Hex,
      personTag: e.personTag,
      txHash: e.txHash,
      block: e.block,
      ct,
      pick,
    });
  }
  if (chain.timeOf(chain.head) >= closesAtSec) throw new Error('seedStakes: entries past close');
  const db = env.DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json)
         VALUES (?1, 'daily', NULL, ?2, ?3, ?4, ?5, 'closed', ?6, ?7)`,
      )
      .bind(
        roundId,
        newUlid(),
        closesAt - 86_400_000,
        closesAt,
        BEACON.round,
        1,
        JSON.stringify(config),
      ),
    db
      .prepare(
        "INSERT INTO round_modes (round_id, mode, status, chain_round_id) VALUES (?1, 'stakes', 'pending', ?2)",
      )
      .bind(roundId, chainRoundId.toString()),
    ...(opts.d1 === false ? [] : entries.map((e) => entryRow(roundId, stake, e))),
  ]);
  return { roundId, chainRoundId, closesAt, config, stake, entries, chain };
}

/** The `entries` row the indexer stores for a seeded entry. */
export function entryRow(
  roundId: string,
  stake: bigint,
  e: SeededStakesEntry,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO entries (id, round_id, mode, user_id, foreign_entry, wallet, person_tag, stake, ciphertext,
       commitment, tx_hash, block_number, log_index, created_at)
     VALUES (?1, ?2, 'stakes', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 1)`,
  ).bind(
    e.id,
    roundId,
    e.userId,
    e.userId === null ? 1 : 0,
    e.wallet,
    e.personTag,
    Number(stake),
    e.ct,
    keccak256(e.ct),
    e.txHash,
    e.block,
  );
}

export function setGameClock(ms: number): void {
  Object.assign(env, { FLOCKED_TEST_CLOCK: String(ms) });
}

export interface StakesHarness {
  stub: DurableObjectStub<SettlementDO>;
  applied: TallyResult[];
  start(): Promise<SettlementStatus>;
  alarm(): Promise<SettlementStatus>;
  /** Delivers every decrypt message sent so far to the real consumer. */
  deliver(): Promise<void>;
}

/**
 * The round's Stakes SettlementDO with manual alarms, the fake relays, small chunks, the real hooks
 * (applyStakes included, recorded), and every chain call on `r.chain` (`fallback`: a second
 * provider on the same chain).
 */
export async function stakesHarness(
  r: SeededStakes,
  opts: { fallback?: boolean } = {},
): Promise<StakesHarness> {
  const stub = settlement(r.roundId, 'stakes');
  const sent = recordDecryptQueues();
  const relays = fakeRelays(() => 'ok');
  const applied: TallyResult[] = [];
  await runInDurableObject(stub, (o: SettlementDO) => {
    o.manualAlarms = true;
    o.relayFetch = relays.fetch;
    o.chunkSizes = { decrypt: 4, bundle: 8 };
    o.stakesDeps = {
      operator: { transport: r.chain.transport(), waitMs: 0 },
      escrow: {
        transports: {
          primary: r.chain.transport('primary'),
          ...(opts.fallback ? { fallback: r.chain.transport('fallback') } : {}),
        },
      },
    };
    const apply = o.hooks.applyStakes;
    o.hooks = {
      ...o.hooks,
      applyStakes: (e, result, deps) => {
        applied.push(result);
        return apply(e, result, deps);
      },
    };
  });
  let delivered = 0;
  return {
    stub,
    applied,
    start: async () =>
      (
        await stub.start({
          roundId: r.roundId,
          mode: 'stakes',
          idempotencyKey: `${r.roundId}:stakes`,
        })
      ).status,
    alarm: async () => {
      await runDurableObjectAlarm(stub);
      return stub.status();
    },
    deliver: async () => {
      for (const m of sent.slice(delivered)) await decryptHandler(m, env);
      delivered = sent.length;
    },
  };
}

/** The round's Stakes mode row. */
export async function stakesMode(roundId: string) {
  return env.DB.prepare(
    `SELECT status, refund_reason, bundle_hash, revealed_at, claims_open_at, final_at
     FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'`,
  )
    .bind(roundId)
    .first<{
      status: string;
      refund_reason: number | null;
      bundle_hash: string | null;
      revealed_at: number | null;
      claims_open_at: number | null;
      final_at: number | null;
    }>();
}
