// RoundDO test helpers. Each test makes its own round and users (D1 and DO storage are shared within a
// test file), drives the game clock through FLOCKED_TEST_CLOCK, and generates a throwaway receipt key.
// Mutating `env` here reaches the DOs' env too (same bindings object under @cloudflare/vitest-plugin).
import { env, runInDurableObject } from 'cloudflare:test';
import { FREE_COMMITMENT_LEAF } from '@flocked/settle';
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  newUlid,
  type LockedConfig,
  type Mode,
} from '@flocked/shared';
import {
  beaconTime,
  chainFromEnv,
  encodePlaintext,
  encryptPick,
  firstRoundAtOrAfter,
  roundRefFromUlid,
  toBase64Url,
} from '@flocked/tlock';
import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { RoundDO } from '../../src/do/round-do.js';
import type { EnterFreeResponse, LockedRound, RpcResult } from '../../src/do/types.js';

export const chain = chainFromEnv(env as unknown as Record<string, string | undefined>);

/** A FlockedAnchor address for the local chain (no real deployment in tests). */
export const ANCHOR_ADDRESS = '0xf10cced000000000000000000000000000000001';

/** Generates a receipt key and the local deployment; returns the signer address (lowercase). */
export function useTestSigner(): Hex {
  const key = generatePrivateKey();
  Object.assign(env, {
    RECEIPT_SIGNER_KEY: key,
    LOCAL_DEPLOYMENT: JSON.stringify({
      escrow: '0x00000000000000000000000000000000000e5c40',
      anchor: ANCHOR_ADDRESS,
      usdc: '0x0000000000000000000000000000000000005dc0',
      deployBlock: 0,
    }),
  });
  return privateKeyToAccount(key).address.toLowerCase() as Hex;
}

/** Sets the game clock (epoch ms) for the Worker and every DO. */
export function setClock(ms: number): void {
  Object.assign(env, { ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(ms) });
}

export const HOUR = 3_600_000;

/** A round window: opens at `opensAt`, closes 24 h later, beacon 120 s after close. */
export function windowAt(opensAt: number) {
  const closesAt = opensAt + 24 * HOUR;
  const beaconRound = firstRoundAtOrAfter(chain, closesAt / 1000 + 120);
  return { opensAt, closesAt, beaconRound, beaconTimeSec: beaconTime(chain, beaconRound) };
}

export const BASE_OPENS_AT = Date.UTC(2026, 9, 8, 1, 0, 0);

export interface TestRound {
  locked: LockedRound;
  stub: DurableObjectStub<RoundDO>;
}

/** Inserts a locked round (rounds + round_modes rows, status as given) and returns its LockedRound. */
export async function createRound(
  opts: {
    kind?: 'daily' | 'room';
    roomId?: string | null;
    opensAt?: number;
    modes?: Mode[];
    free?: Partial<LockedConfig['free']>;
    status?: 'scheduled' | 'open';
  } = {},
): Promise<TestRound> {
  const kind = opts.kind ?? 'room';
  const roomId = kind === 'room' ? (opts.roomId ?? newUlid()) : null;
  const w = windowAt(opts.opensAt ?? BASE_OPENS_AT);
  const modes = opts.modes ?? ['free'];
  const config = LockedConfigSchema.parse({
    beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
    ...(modes.includes('free')
      ? { free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null, ...opts.free } }
      : {}),
    ...(modes.includes('stakes')
      ? {
          stakes: {
            ...LOCKED_CONFIG_DEFAULTS.stakes,
            creator: '0x000000000000000000000000000000000000dead',
          },
        }
      : {}),
  });
  const roundId = newUlid();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
    ).bind(
      roundId,
      kind,
      roomId,
      newUlid(),
      w.opensAt,
      w.closesAt,
      w.beaconRound,
      opts.status ?? 'scheduled',
      w.opensAt - 6 * HOUR,
      JSON.stringify(config),
    ),
    ...modes.map((mode) =>
      env.DB.prepare(
        "INSERT INTO round_modes (round_id, mode, status, chain_round_id) VALUES (?1, ?2, 'pending', ?3)",
      ).bind(roundId, mode, mode === 'stakes' ? '1' : null),
    ),
  ]);
  const locked: LockedRound = {
    roundId,
    kind,
    roomId,
    questionId: newUlid(),
    opensAt: w.opensAt,
    closesAt: w.closesAt,
    beaconRound: w.beaconRound,
    beaconTimeSec: w.beaconTimeSec,
    config,
    modes,
    ...(modes.includes('stakes') ? { chainRoundId: '1' } : {}),
  };
  return { locked, stub: env.ROUND.get(env.ROUND.idFromName(roundId)) };
}

/** Creates an active user with `balance` points in `scope` (and a room membership for a room scope). */
export async function createUser(
  balance: number | null,
  scope = 'global',
  opts: { status?: string; member?: boolean } = {},
): Promise<string> {
  const id = newUlid();
  const stmts = [
    env.DB.prepare(
      "INSERT INTO users (id, handle, role, status, ref_code, created_at) VALUES (?1, ?2, 'user', ?3, ?4, 0)",
    ).bind(id, `u_${id.slice(-10).toLowerCase()}`, opts.status ?? 'active', `R${id.slice(-12)}`),
  ];
  if (balance !== null) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, ?3, 0)',
      ).bind(id, scope, balance),
      env.DB.prepare(
        "INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) VALUES (?1, ?2, ?3, ?4, 'admin', ?5, 0)",
      ).bind(newUlid(), id, scope, balance, `seed-${id}`),
    );
  }
  if (scope !== 'global' && opts.member !== false) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', 0)",
      ).bind(scope, id),
    );
  }
  await env.DB.batch(stmts);
  return id;
}

/** A sealed pick for the round, as the client makes it, in base64url. */
export async function sealedPick(
  round: Pick<LockedRound, 'roundId' | 'beaconRound'>,
  optionIndex: 0 | 1 = 0,
  beaconRound = round.beaconRound,
): Promise<string> {
  const pt = encodePlaintext({
    roundRef: roundRefFromUlid(round.roundId),
    optionIndex,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
  });
  return toBase64Url(await encryptPick(chain, beaconRound, pt));
}

export async function balance(userId: string, scope = 'global'): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = ?2',
  )
    .bind(userId, scope)
    .first<{ balance: number }>();
  return row?.balance ?? null;
}

export async function ledgerRows(userId: string): Promise<{ reason: string; delta: number }[]> {
  const { results } = await env.DB.prepare(
    'SELECT reason, delta FROM points_ledger WHERE user_id = ?1 ORDER BY created_at, delta DESC',
  )
    .bind(userId)
    .all<{ reason: string; delta: number }>();
  return results;
}

export async function entryCount(roundId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE round_id = ?1')
    .bind(roundId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function seqs(roundId: string): Promise<number[]> {
  const { results } = await env.DB.prepare(
    "SELECT receipt_seq FROM entries WHERE round_id = ?1 AND mode = 'free' ORDER BY receipt_seq",
  )
    .bind(roundId)
    .all<{ receipt_seq: number }>();
  return results.map((r) => r.receipt_seq);
}

/** Unwraps an ok RpcResult, failing the test otherwise. */
export function okValue(r: RpcResult<EnterFreeResponse>): EnterFreeResponse {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.value;
}

export function errCode(r: RpcResult<EnterFreeResponse>): string {
  if (r.ok) throw new Error('expected a rejection');
  return r.code;
}

/** Reads the DO's persisted meta (status, done events, close record). */
export function readMeta(stub: DurableObjectStub<RoundDO>) {
  return runInDurableObject(stub, async (_i, state) =>
    state.storage.get<{
      status: string;
      done: string[];
      retryAt: Record<string, number>;
      freeClose: {
        root: Hex | null;
        entryCount: number;
        totalStake: string;
        anchor: string;
        deadline: number;
        nextAttemptAt: number | null;
      } | null;
    }>('meta'),
  );
}

/**
 * Advances the clock and runs the DO's alarm handler. It runs twice: an automatic alarm may be
 * mid-pass on the old clock (a not-yet-due event is rescheduled on the game clock, which a fixed
 * test clock never reaches), and `alarm()` joins a running pass; the second call is a fresh pass.
 */
export async function alarmAt(stub: DurableObjectStub<RoundDO>, ms: number): Promise<void> {
  setClock(ms);
  await runInDurableObject(stub, async (instance) => {
    await instance.alarm();
    await instance.alarm();
  });
}

// ---- Merkle proof verification, independent of @openzeppelin/merkle-tree ---------------------

/** StandardMerkleTree leaf hash: keccak256(keccak256(abi.encode(values))). */
export function commitmentLeafHash(values: readonly unknown[]): Hex {
  const types = FREE_COMMITMENT_LEAF.map((type) => ({ type }));
  return keccak256(keccak256(encodeAbiParameters(types, values as never)));
}

/** OpenZeppelin MerkleProof.verify: sorted-pair keccak256 up to the root. */
export function verifyProof(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  let h = leaf;
  for (const p of proof) h = keccak256(h < p ? concat([h, p]) : concat([p, h]));
  return h === root;
}
