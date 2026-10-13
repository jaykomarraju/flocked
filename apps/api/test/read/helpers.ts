// Shared setup for the read-endpoint tests (W6-D): requests through the real app as a signed-in user
// (the session injected, as test/round-do/route.test.ts does) or anonymously, and D1 rows written
// the way the scheduler, the lock and the indexer leave them. D1, R2 and DO storage are per test
// file, so each file seeds its own rounds.
import { env } from 'cloudflare:test';
import {
  API_BASE_PATH,
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  newUlid,
  type LockedConfig,
  type Mode,
  type ModeStatus,
} from '@flocked/shared';
import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem';
import { app } from '../../src/app.js';
import { withAuthDeps } from '../../src/auth/deps.js';
import type { Env } from '../../src/env.js';
import { fakeUser, withSession } from '../helpers/index.js';

export const ORIGIN = 'https://flocked.test';

/** A request through the real app (routes, error envelope), signed in as `userId` or anonymous. */
export function request(
  path: string,
  opts: { userId?: string; env?: Env; method?: string; body?: unknown } = {},
): Promise<Response> {
  const client = withSession(app, opts.userId ? fakeUser({ id: opts.userId }) : undefined);
  const init: RequestInit = { method: opts.method ?? 'GET' };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'content-type': 'application/json' };
  }
  return Promise.resolve(
    client.request(`${ORIGIN}${API_BASE_PATH}${path}`, init, opts.env ?? (env as Env)),
  );
}

/** The current env with Turnstile passing (the first Free entry of the game day needs it). */
export function passTurnstile(): Env {
  return withAuthDeps(env as Env, {
    turnstileFetch: () => Promise.resolve(Response.json({ success: true })),
  });
}

/** POST /rounds/:id/entries as `userId`; `ciphertext` is base64url. */
export function postEntry(
  userId: string,
  roundId: string,
  stake: string,
  ciphertext: string,
): Promise<Response> {
  return request(`/rounds/${roundId}/entries`, {
    userId,
    env: passTurnstile(),
    method: 'POST',
    body: { stake, ciphertext, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
}

let users = 0;

/** An active user (or merged into `mergedInto`) with `balance` global points. */
export async function insertUser(
  o: {
    id?: string;
    handle?: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    prefs?: Record<string, unknown>;
    createdAt?: number;
    balance?: number | null;
    mergedInto?: string;
  } = {},
): Promise<string> {
  const id = o.id ?? newUlid();
  users += 1;
  const stmts = [
    env.DB.prepare(
      `INSERT INTO users (id, handle, display_name, avatar_url, prefs_json, role, status, merged_into,
         ref_code, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'user', ?6, ?7, ?8, ?9)`,
    ).bind(
      id,
      o.handle ?? `r${users}_${id.slice(-8).toLowerCase()}`,
      o.displayName ?? null,
      o.avatarUrl ?? null,
      JSON.stringify(o.prefs ?? {}),
      o.mergedInto ? 'merged' : 'active',
      o.mergedInto ?? null,
      `RD${id.slice(-12)}`,
      o.createdAt ?? 0,
    ),
  ];
  if (o.balance !== null) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, 'global', ?2, 0)",
      ).bind(id, o.balance ?? 500),
    );
  }
  await env.DB.batch(stmts);
  return id;
}

/** A verified identity for `userId`. */
export async function linkIdentity(
  userId: string,
  provider: 'farcaster' | 'wallet',
  externalId: string,
  verifiedAt = 0,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(newUlid(), userId, provider, externalId, verifiedAt)
    .run();
}

export const OPTIONS = [
  { label: 'Cats', emoji: '🐈' },
  { label: 'Dogs', emoji: '🐕' },
] as const;

/** A question row (house when `authorId` is null). */
export async function insertQuestion(
  o: { id?: string; authorId?: string | null; prompt?: string } = {},
): Promise<string> {
  const id = o.id ?? newUlid();
  await env.DB.prepare(
    `INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'food', 'used', 0)`,
  )
    .bind(
      id,
      o.authorId ?? null,
      o.prompt ?? `Cats or dogs? (${id.slice(-6)})`,
      JSON.stringify(OPTIONS),
    )
    .run();
  return id;
}

/** The question row a seeded round (test/settlement helpers) points at, which they don't insert. */
export async function questionFor(
  roundId: string,
  authorId: string | null = null,
): Promise<string> {
  const row = await env.DB.prepare('SELECT question_id FROM rounds WHERE id = ?1')
    .bind(roundId)
    .first<{ question_id: string }>();
  if (!row) throw new Error(`questionFor: no round ${roundId}`);
  return insertQuestion({ id: row.question_id, authorId });
}

/**
 * A locked config with the launch defaults for `modes`. `payoutAddress` is the Stakes payout wallet
 * the lock froze (left out unless given, as in a config locked before O4).
 */
export function lockedConfig(
  modes: readonly Mode[],
  o: { creator?: string; awardRecipient?: string | null; payoutAddress?: string | null } = {},
): LockedConfig {
  return LockedConfigSchema.parse({
    beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
    ...(modes.includes('free')
      ? { free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: o.awardRecipient ?? null } }
      : {}),
    ...(modes.includes('stakes')
      ? {
          stakes: {
            ...LOCKED_CONFIG_DEFAULTS.stakes,
            creator: o.creator ?? '0x000000000000000000000000000000000000dead',
            ...(o.payoutAddress !== undefined ? { payoutAddress: o.payoutAddress } : {}),
          },
        }
      : {}),
  });
}

export interface InsertedRound {
  id: string;
  questionId: string;
  opensAt: number;
  closesAt: number;
  beaconRound: number;
  config: LockedConfig;
}

/**
 * A round as the lock leaves it: `rounds` (locked unless `locked: false`) and one `round_modes` row
 * per mode with the given status (final modes get `final_at`, revealed ones `revealed_at`).
 */
export async function insertRound(o: {
  kind?: 'daily' | 'room';
  roomId?: string | null;
  questionId?: string;
  opensAt: number;
  closesAt: number;
  beaconRound?: number;
  status?: 'scheduled' | 'open' | 'closed';
  locked?: boolean;
  config?: LockedConfig;
  modes?: Partial<
    Record<
      Mode,
      {
        status?: ModeStatus;
        refundReason?: number | null;
        chainRoundId?: string;
        revealedAt?: number | null;
      }
    >
  >;
}): Promise<InsertedRound> {
  const id = newUlid();
  const kind = o.kind ?? 'daily';
  const modes = o.modes ?? { free: {} };
  const config = o.config ?? lockedConfig(Object.keys(modes) as Mode[]);
  const questionId = o.questionId ?? (await insertQuestion());
  const beaconRound = o.beaconRound ?? 1_000;
  const locked = o.locked ?? true;
  const FINAL = ['settled', 'refunded', 'voided'];
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status,
         locked_at, config_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      id,
      kind,
      kind === 'room' ? (o.roomId ?? newUlid()) : null,
      questionId,
      o.opensAt,
      o.closesAt,
      beaconRound,
      o.status ?? 'closed',
      locked ? o.opensAt - 6 * 3_600_000 : null,
      locked ? JSON.stringify(config) : null,
    ),
    ...(Object.entries(modes) as [Mode, NonNullable<(typeof modes)[Mode]>][]).map(([mode, m]) => {
      const status = m.status ?? 'pending';
      return env.DB.prepare(
        `INSERT INTO round_modes (round_id, mode, status, refund_reason, chain_round_id, revealed_at,
           final_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        id,
        mode,
        status,
        m.refundReason ?? null,
        mode === 'stakes' ? (m.chainRoundId ?? '1') : null,
        m.revealedAt ?? null,
        FINAL.includes(status) ? o.closesAt + 60_000 : null,
      );
    }),
  ]);
  return { id, questionId, opensAt: o.opensAt, closesAt: o.closesAt, beaconRound, config };
}

/** Sets the game clock (epoch ms) for the Worker and every DO (the local environment only). */
export function setClock(ms: number): void {
  Object.assign(env, { ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(ms) });
}

// Merkle proofs, checked independently of @openzeppelin/merkle-tree and of src/read/proofs.ts ----

/** StandardMerkleTree leaf: keccak256(keccak256(abi.encode(values))). */
export function leafHash(types: readonly string[], values: readonly unknown[]): Hex {
  return keccak256(
    keccak256(
      encodeAbiParameters(
        types.map((type) => ({ type })),
        values as never,
      ),
    ),
  );
}

/** The Stakes payout leaf `(uint256 chainRoundId, address account, uint8 kind)` (FlockedEscrow). */
export function stakesLeaf(chainRoundId: bigint | string, account: string, kind: 0 | 1 | 2): Hex {
  return leafHash(['uint256', 'address', 'uint8'], [BigInt(chainRoundId), account, kind]);
}

/** OpenZeppelin MerkleProof.verify: sorted-pair keccak256 up to `root`. */
export function verifyProof(root: string, leaf: Hex, proof: readonly string[]): boolean {
  let h = leaf;
  for (const p of proof as Hex[]) h = keccak256(h < p ? concat([h, p]) : concat([p, h]));
  return h === root;
}

/** FlockedEscrow `Kind` of a payout kind with a proof. */
export const LEAF_KIND = { win: 0, rebate: 1, void_refund: 2 } as const;
