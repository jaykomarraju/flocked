// Scheduler test helpers: the game clock, questions, a fake chain wired into the operator and the
// AnchorDO singleton, and Stakes creator authors (a fake attestation chain and a notify recorder).
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import { custom, keccak256, toHex, type Address, type Hex, type Transport } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { vi } from 'vitest';
import { ANCHOR_SINGLETON, type AnchorDO } from '../../src/do/anchor-do.js';
import type { Env } from '../../src/env.js';
import { withPersonhoodDeps } from '../../src/personhood/deps.js';
import type { RoundRow } from '../../src/scheduler/lock.js';
import { FAKE_DEPLOYMENT, FakeChain } from '../anchor-do/fake-chain.js';
import { drand } from '../anchor-do/helpers.js';
import { MemoryQueue } from '../auth/fixtures.js';
import { FakeAttestations } from '../personhood/fixtures.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function setClock(ms: number): void {
  Object.assign(env, { ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(ms) });
}

/** A question; house questions have no author. A rejected one has its reason and time (0017). */
export async function insertQuestion(
  o: { author?: string | null; status?: string; score?: number; prompt?: string } = {},
): Promise<string> {
  const id = newUlid();
  const rejected = o.status === 'rejected';
  await env.DB.prepare(
    'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, score, created_at, rejected_at, rejection_reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
  )
    .bind(
      id,
      o.author ?? null,
      o.prompt ?? `Sheep or goats? ${id}`,
      JSON.stringify([
        { label: 'Sheep', emoji: '🐑' },
        { label: 'Goats', emoji: '🐐' },
      ]),
      'other',
      o.status ?? 'queued',
      o.score ?? 0,
      0,
      rejected ? 0 : null,
      rejected ? 'Rejected' : null,
    )
    .run();
  return id;
}

export async function roundRow(id: string): Promise<RoundRow> {
  const r = await env.DB.prepare('SELECT * FROM rounds WHERE id = ?1').bind(id).first<RoundRow>();
  if (!r) throw new Error(`no round ${id}`);
  return r;
}

export async function modeRows(roundId: string) {
  const { results } = await env.DB.prepare(
    'SELECT mode, status, chain_round_id, lock_tx FROM round_modes WHERE round_id = ?1 ORDER BY mode',
  )
    .bind(roundId)
    .all<{ mode: string; status: string; chain_round_id: string | null; lock_tx: string | null }>();
  return results;
}

/** A fake chain behind the operator key and the AnchorDO singleton (alarms run by hand). */
export async function chainHarness(t: number) {
  const fake = new FakeChain({ genesis: drand.genesis, period: drand.period }, t / 1000);
  Object.assign(env, {
    CHAIN_ID: '31337',
    ANCHOR_KEY: generatePrivateKey(),
    OPERATOR_KEY: generatePrivateKey(),
    LOCAL_DEPLOYMENT: FAKE_DEPLOYMENT,
  });
  const anchor = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
  await runInDurableObject(anchor, (inst: AnchorDO) => {
    inst.transportOverride = fake.transport;
    inst.manualAlarms = true;
  });
  return {
    fake,
    anchor,
    deps: { operator: { transport: fake.transport, waitMs: 0 } },
    runAnchor: () => runDurableObjectAlarm(anchor),
  };
}

/**
 * The first write that marks `purpose` abandoned in operator_txs throws, as a D1 outage would, so
 * that cancellation fails before anything is sent (W5-F1 C4). Returns the spy (mockRestore it).
 */
export function failFirstMark(purpose: string) {
  const prepare = env.DB.prepare.bind(env.DB);
  let armed = true;
  return vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
    const stmt = prepare(sql);
    if (!armed || !sql.startsWith('UPDATE operator_txs SET tx_json')) return stmt;
    return {
      bind: (...args: unknown[]) => {
        if (args[0] === purpose && String(args[1]).includes('"abandoned":true')) {
          armed = false;
          throw new Error('D1_ERROR: unavailable');
        }
        return stmt.bind(...args);
      },
    } as unknown as D1PreparedStatement;
  });
}

/**
 * The fake chain behind a node whose `pending` nonce is its latest block's, as if it saw none of the
 * account's pooled transactions: it answers the same stale value until something is mined (W6-A).
 * The first `together` pending reads are held until all of them have arrived, so that many
 * concurrent sends read it before any of them can store a transaction.
 */
export function stalePendingNonce(fake: FakeChain, together = 0): Transport {
  const inner = fake.transport({}).request as unknown as (a: {
    method: string;
    params: unknown[];
  }) => Promise<unknown>;
  let arrived = 0;
  let release = () => {};
  const all = new Promise<void>((resolve) => (release = resolve));
  return custom(
    {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        const p = (params ?? []) as unknown[];
        if (method !== 'eth_getTransactionCount' || p[1] !== 'pending') {
          return inner({ method, params: p });
        }
        if (arrived < together) {
          arrived += 1;
          if (arrived === together) release();
          await all;
        }
        return inner({ method, params: [p[0], 'latest'] });
      },
    },
    { retryCount: 0 },
  );
}

/** The `reason` of each ALERT_SCHEDULE_GAP written through `spy` (`alertSpy().spy`), in order. */
export function gapReasons(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((c) => c[0] as { indexes: string[]; blobs: string[] })
    .filter((p) => p.indexes[0] === 'ALERT_SCHEDULE_GAP')
    .map((p) => (JSON.parse(p.blobs[3] ?? '{}') as { reason?: string }).reason ?? '');
}

// Stakes creators (decision C5) -------------------------------------------------------------------

/** The draft's Stakes creator in these tests: a stand-in for the treasury. */
export const TREASURY = '0x000000000000000000000000000000000000beef';

/** Sets `geo.stakes.allow` (a JSON array of `"GB"` or `"US-NJ"`). */
export async function setGeoAllow(rules: string[]): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO config (key, value_json, updated_at) VALUES ('geo.stakes.allow', ?1, 0) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
  )
    .bind(JSON.stringify(rules))
    .run();
}

export interface CreatorHarness {
  /** The test env with the fake attestation chain and the notify recorder: pass it to lockRound. */
  env: Env;
  chain: FakeAttestations;
  notify: MemoryQueue;
}

/** An env copy whose attestation reads go to a fake chain and whose notify queue records. */
export function creatorHarness(): CreatorHarness {
  const chain = new FakeAttestations();
  const notify = new MemoryQueue();
  const e = withPersonhoodDeps(
    { ...(env as Env), QUEUE_NOTIFY: notify as unknown as Env['QUEUE_NOTIFY'] },
    { attestationRpc: chain.client },
  );
  return { env: e, chain, notify };
}

export interface TestAuthor {
  id: string;
  wallet: Address;
  accountUid: Hex;
  countryUid: Hex;
}

let authors = 0;

/**
 * An author who passes every creator check at lock: verified (Coinbase country `country`), active,
 * not self-excluded, with a payout wallet and a location pass in prefs; the wallet is linked and
 * verified, and Coinbase attests it (Verified Account, and Verified Country `country`).
 */
export async function passingAuthor(chain: FakeAttestations, country = 'US'): Promise<TestAuthor> {
  const n = ++authors;
  const id = newUlid();
  const wallet: Address = `0x${(0xc0ffee000000 + n).toString(16).padStart(40, '0')}`;
  const prefs = { creator_payout_wallet: wallet, creator_payout_location_ok_at: 1 };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, handle, ref_code, status, person_id, kyc_status, person_verified_at,
         coinbase_country, prefs_json, created_at)
       VALUES (?1, ?2, ?3, 'active', ?4, 'verified', 0, ?5, ?6, 0)`,
    ).bind(
      id,
      `author${n}_${id.slice(-6).toLowerCase()}`,
      `RA${id.slice(-12)}`,
      keccak256(toHex(`person-${id}`)),
      country,
      JSON.stringify(prefs),
    ),
    env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'wallet', ?3, 0)",
    ).bind(newUlid(), id, wallet),
  ]);
  const accountUid = chain.attest(wallet, 'account');
  const countryUid = chain.attest(wallet, 'country', { country });
  return { id, wallet, accountUid, countryUid };
}
