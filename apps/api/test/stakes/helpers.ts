// Stakes ticket test setup: a fake ticket signer that behaves as apps/signer does at its boundary
// (it signs only a hash with a stakes_tickets row, under the deployment's escrow domain), Stakes
// rounds on the fake chain, verified players with attested wallets, the Stakes config keys, and
// `/prepare` requests that carry a Cloudflare location.
import { env, runInDurableObject } from 'cloudflare:test';
import { API_BASE_PATH, ticketDigest } from '@flocked/shared';
import { custom, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { app } from '../../src/app.js';
import { deploymentOf } from '../../src/chain/client.js';
import type { RoundDO } from '../../src/do/round-do.js';
import type { Env } from '../../src/env.js';
import type { SignTicketRequest } from '../../src/stakes/signer.js';
import { FAKE_DEPLOYMENT } from '../anchor-do/fake-chain.js';
import { realSession } from '../helpers/index.js';
import { ORIGIN, TOS } from '../auth/fixtures.js';
import { linkWallet, newUser, personhoodEnv, type PersonhoodTest } from '../personhood/fixtures.js';
import { BASE_OPENS_AT, createRound, setClock, type TestRound } from '../round-do/helpers.js';

/** Throwaway PERSON_TAG_KEY (32 bytes of hex), never a deployed value. */
export const TEST_PERSON_TAG_KEY = `0x${'7a'.repeat(32)}`;

/** Mid-round game time for rounds from `round()` (they open at 01:00 UTC Oct 8 and run 24 h). */
export const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

/** A fake `SIGNER`: refuses a hash with no row or one that isn't the fields' digest, like apps/signer. */
export class FakeSigner {
  readonly key = generatePrivateKey();
  readonly address = privateKeyToAccount(this.key).address;
  readonly calls: SignTicketRequest[] = [];
  /** Make every call reject, as an unreachable or refusing signer would. */
  fail = false;

  readonly signTicket = async (req: SignTicketRequest): Promise<{ signature: Hex }> => {
    this.calls.push(req);
    if (this.fail) throw new Error('ticket_refused: internal');
    const digest = ticketDigest(
      { chainId: Number(env.CHAIN_ID), verifyingContract: deploymentOf(env).escrow },
      {
        roundId: BigInt(req.roundId),
        wallet: req.wallet,
        personTag: req.personTag,
        expiry: BigInt(req.expiry),
      },
    );
    if (digest.toLowerCase() !== req.ticketHash) throw new Error('ticket_refused: hash_mismatch');
    const row = await env.DB.prepare('SELECT 1 AS ok FROM stakes_tickets WHERE ticket_hash = ?1')
      .bind(req.ticketHash)
      .first();
    if (!row) throw new Error('ticket_refused: no_row');
    const signature = await privateKeyToAccount(this.key).sign({ hash: req.ticketHash });
    return { signature: signature.toLowerCase() as Hex };
  };
}

export interface StakesTest extends PersonhoodTest {
  env: Env;
  signer: FakeSigner;
}

/** Sets the game clock for the DOs (global env) and the request env together. */
export function clockAt(t: StakesTest, ms: number): void {
  setClock(ms);
  Object.assign(t.env, { ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(ms) });
}

/** The personhood env plus PERSON_TAG_KEY, the fake signer and the fake chain's deployment. */
export function stakesTest(vars: Partial<Env> = {}): StakesTest {
  const signer = new FakeSigner();
  const p = personhoodEnv({ PERSON_TAG_KEY: TEST_PERSON_TAG_KEY, ...vars });
  const e = p.env;
  Object.assign(e, {
    SIGNER: signer,
    CHAIN_ID: env.CHAIN_ID,
    LOCAL_DEPLOYMENT: env.LOCAL_DEPLOYMENT,
  });
  const t = { ...p, env: e, signer };
  clockAt(t, T0);
  return t;
}

/** Writes the Stakes config keys (null leaves a key unset). */
export async function setStakesConfig(opts: {
  allow?: string[] | null;
  age21?: string[] | null;
  enabled?: boolean | null;
}): Promise<void> {
  const rows: [string, unknown][] = [];
  if (opts.allow !== null) rows.push(['geo.stakes.allow', opts.allow ?? ['US']]);
  if (opts.age21 !== null && opts.age21 !== undefined) rows.push(['geo.stakes.age21', opts.age21]);
  if (opts.enabled !== null) rows.push(['mode.stakes.enabled', opts.enabled ?? true]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM config'),
    ...rows.map(([key, value]) =>
      env.DB.prepare('INSERT INTO config (key, value_json, updated_at) VALUES (?1, ?2, 0)').bind(
        key,
        JSON.stringify(value),
      ),
    ),
  ]);
}

let rounds = 0;

/**
 * A locked round with a Stakes mode (escrow round ID set), its RoundDO initialised and open. Daily
 * by default, opening `opensAt` (default: 1 minute later per call, from 21:00 New York on Oct 7, so
 * it closes on game day 2026-10-08) and running 24 h; `kind: 'room'` rounds get a new room. The
 * RoundDO's void goes nowhere (every RPC fails), so a requested void stays requested.
 */
export async function round(
  t: StakesTest,
  opts: { kind?: 'daily' | 'room'; opensAt?: number; modes?: ('free' | 'stakes')[] } = {},
): Promise<TestRound & { chainRoundId: string }> {
  const n = ++rounds;
  Object.assign(env, {
    CHAIN_ID: '31337',
    OPERATOR_KEY: (env as { OPERATOR_KEY?: string }).OPERATOR_KEY ?? generatePrivateKey(),
    LOCAL_DEPLOYMENT: FAKE_DEPLOYMENT,
  });
  Object.assign(t.env, { CHAIN_ID: env.CHAIN_ID, LOCAL_DEPLOYMENT: env.LOCAL_DEPLOYMENT });
  const r = await createRound({
    kind: opts.kind ?? 'daily',
    modes: opts.modes ?? ['free', 'stakes'],
    opensAt: opts.opensAt ?? BASE_OPENS_AT + n * 60_000,
  });
  const chainRoundId = String(1000 + n);
  await env.DB.prepare(
    "UPDATE round_modes SET chain_round_id = ?2 WHERE round_id = ?1 AND mode = 'stakes'",
  )
    .bind(r.locked.roundId, chainRoundId)
    .run();
  if (r.locked.modes.includes('stakes')) r.locked.chainRoundId = chainRoundId;
  await runInDurableObject(r.stub, (i: RoundDO) => {
    i.operatorDeps = {
      transport: custom(
        { request: () => Promise.reject(new Error('rpc down')) },
        { retryCount: 0 },
      ),
      waitMs: 0,
    };
  });
  const game = Number(t.env.FLOCKED_TEST_CLOCK);
  setClock(Math.max(game, r.locked.opensAt));
  await r.stub.init(r.locked);
  setClock(game);
  return { ...r, chainRoundId };
}

/** Makes `userId` a member of the room round `r`. */
export async function join(r: TestRound, userId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', 0)",
  )
    .bind(r.locked.roomId, userId)
    .run();
}

let seq = 0;

export interface Player {
  id: string;
  personId: string;
  wallet: Address;
  headers: Record<string, string>;
}

/**
 * A verified player who passes every check: Coinbase country `country`, ToS and 18+ current, one
 * linked wallet holding both attestations for that country (`attested: null`: none), an account a
 * week old, and a session.
 */
export async function player(
  t: StakesTest,
  opts: { country?: string; attested?: string | null; createdAt?: number } = {},
): Promise<Player> {
  const n = ++seq;
  const id = `01K7STAKES0000000000PL${String(n).padStart(4, '0')}`;
  const personId = `0x${n.toString(16).padStart(64, 'a')}`;
  const country = opts.country ?? 'US';
  await newUser(id, opts.createdAt ?? T0 - 7 * 24 * 3600 * 1000);
  await env.DB.prepare(
    'UPDATE users SET handle = ?7, tos_version = ?2, tos_accepted_at = ?6, age_attested_at = ?6, person_id = ?3, ' +
      "kyc_status = 'verified', person_verified_at = ?6, coinbase_country = ?4, coinbase_region = ?5 WHERE id = ?1",
  )
    .bind(id, TOS, personId, country, 'NJ', T0 - 3600_000, `stk_${n}`)
    .run();
  const wallet = await addWallet(t, id, opts.attested === undefined ? country : opts.attested);
  const s = await realSession(t.env, id, 'bearer');
  return { id, personId, wallet, headers: s.headers };
}

/** Links another verified wallet to `userId`, attested for `country` (null: no attestations). */
export async function addWallet(
  t: StakesTest,
  userId: string,
  country: string | null = null,
): Promise<Address> {
  const wallet = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
  await linkWallet(userId, wallet);
  if (country) t.chain.verify(wallet, country);
  return wallet;
}

let ip = 0;

/** `POST /rounds/:id/entries/stakes/prepare` from `cf` (default US-NJ). */
export async function prepare(
  t: StakesTest,
  p: Pick<Player, 'headers'>,
  roundId: string,
  wallet: Address,
  cf: Record<string, unknown> = { country: 'US', regionCode: 'NJ' },
): Promise<Response> {
  const req = new Request(`${ORIGIN}${API_BASE_PATH}/rounds/${roundId}/entries/stakes/prepare`, {
    method: 'POST',
    headers: {
      ...p.headers,
      'content-type': 'application/json',
      'CF-Connecting-IP': `198.51.100.${(++ip % 250) + 1}`,
    },
    body: JSON.stringify({ wallet }),
    cf,
  });
  return app.fetch(req, t.env);
}

/** The error code of an error-envelope response. */
export async function codeOf(res: Response): Promise<string> {
  const body: { error?: { code?: string } } = await res.json();
  return body.error?.code ?? `<no envelope: ${res.status}>`;
}

export interface TicketRow {
  ticket_hash: string;
  round_id: string;
  person_tag: string;
  user_id: string;
  wallet: string;
  expiry: number;
  issued_at: number;
  used_tx: string | null;
  game_day: string | null;
}

export async function ticketsOf(userId: string): Promise<TicketRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM stakes_tickets WHERE user_id = ?1 ORDER BY issued_at, ticket_hash',
  )
    .bind(userId)
    .all<TicketRow>();
  return results;
}
