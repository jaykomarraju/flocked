// Test-only seam for the local stack (W3-D; e2e/stack/README.md). It stands in for the scheduler and
// the settlement pipeline that later waves build: it creates and locks a Free round (D1 rows plus
// RoundDO.init), moves the game clock, and opens a round's entries with a beacon signature inside
// the Worker, so the e2e smoke test runs tlock in the `wrangler dev` bundle.
//
// It answers 404, exactly like an unknown path, unless ENVIRONMENT is 'local', FLOCKED_TEST_SEAM_KEY
// is set (only `pnpm stack:up` sets it, per run) and the request carries that key as a Bearer token,
// so a page open in the developer's browser cannot drive it.
import {
  EpochMsSchema,
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  QuestionOptionSchema,
  UlidSchema,
  errorEnvelope,
  newUlid,
} from '@flocked/shared';
import {
  MAX_BEACON_DELAY,
  MIN_BEACON_DELAY,
  beaconTime,
  chainFromEnv,
  classify,
  decodePlaintext,
  decryptWithSignature,
  firstRoundAtOrAfter,
  roundRefFromUlid,
  verifyBeacon,
  type DrandChain,
} from '@flocked/tlock';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { timingSafeEqual } from '../auth/crypto.js';
import type { LockedRound } from '../do/types.js';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { HttpError, onError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { validate } from '../lib/validate.js';

export const SEAM_PREFIX = '/__test';

type SeamEnv = { Bindings: Env };

/** True when the seam may run at all: the local environment with a per-run key. */
export function seamEnabled(env: Pick<Env, 'ENVIRONMENT' | 'FLOCKED_TEST_SEAM_KEY'>): boolean {
  return env.ENVIRONMENT === 'local' && Boolean(env.FLOCKED_TEST_SEAM_KEY);
}

const notFound = (path: string) =>
  Response.json(errorEnvelope('not_found', `no route for ${path}`), { status: 404 });

const guard: MiddlewareHandler<SeamEnv> = async (c, next) => {
  const key = c.env.FLOCKED_TEST_SEAM_KEY;
  const given = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (!seamEnabled(c.env) || !key || !timingSafeEqual(given, key)) return notFound(c.req.path);
  await next();
};

/** Whole seconds in epoch ms, so beacon math matches what a client computes. */
const WholeSecondMs = EpochMsSchema.refine((ms) => ms % 1000 === 0, 'whole seconds only');

const ClockSchema = z.strictObject({ nowMs: WholeSecondMs.nullable() });

const CreateRoundSchema = z
  .strictObject({
    opensAt: WholeSecondMs,
    closesAt: WholeSecondMs,
    beaconDelay: z.int().min(MIN_BEACON_DELAY).max(MAX_BEACON_DELAY).default(MIN_BEACON_DELAY),
    prompt: z.string().min(1).max(200).default('Sheep or goats?'),
    options: z.tuple([QuestionOptionSchema, QuestionOptionSchema]).default([
      { label: 'Sheep', emoji: '🐑' },
      { label: 'Goats', emoji: '🐐' },
    ]),
  })
  .refine((r) => r.closesAt > r.opensAt, 'closesAt must be after opensAt');

const RoundParamsSchema = z.strictObject({ id: UlidSchema });
const RevealSchema = z.strictObject({ signature: z.string().regex(/^[0-9a-f]{96}$/) });

function chainOf(env: Env): DrandChain {
  return chainFromEnv({
    DRAND_CHAIN_HASH: env.DRAND_CHAIN_HASH,
    DRAND_PUBLIC_KEY: env.DRAND_PUBLIC_KEY,
    DRAND_GENESIS: env.DRAND_GENESIS,
    DRAND_PERIOD: env.DRAND_PERIOD,
  });
}

function roundStub(env: Env, roundId: string) {
  return env.ROUND.get(env.ROUND.idFromName(roundId));
}

const app = new Hono<SeamEnv>().basePath(SEAM_PREFIX);
app.onError(onError);
app.use('*', guard);

/**
 * POST /__test/clock: pins the game clock (src/lib/clock.ts) to `nowMs`, or back to wall time with
 * null. workerd hands the Worker and its Durable Objects one env object per isolate, and `wrangler
 * dev` runs them all in one isolate, so this reaches every RoundDO. A wrangler restart forgets it.
 */
app.post('/clock', validate('json', ClockSchema), (c) => {
  const { nowMs } = c.req.valid('json');
  if (nowMs === null) delete c.env.FLOCKED_TEST_CLOCK;
  else c.env.FLOCKED_TEST_CLOCK = String(nowMs);
  log.warn('test_clock_set', { nowMs });
  return c.json({ nowMs: now(c.env) });
});

/**
 * POST /__test/rounds: a daily Free round, locked now: the question, `rounds` and `round_modes`
 * rows, then RoundDO.init (which opens it when `opensAt` has passed). The beacon round is the first
 * at or after `closesAt + beaconDelay` on the configured chain. The FlockedAnchor lock leaf is not
 * written (AnchorDO, W4-A).
 */
app.post('/rounds', validate('json', CreateRoundSchema), async (c) => {
  const body = c.req.valid('json');
  const chain = chainOf(c.env);
  const beaconRound = firstRoundAtOrAfter(chain, body.closesAt / 1000 + body.beaconDelay);
  const config = LockedConfigSchema.parse({
    beaconDelay: body.beaconDelay,
    free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
  });
  const t = now(c.env);
  const roundId = newUlid();
  const questionId = newUlid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at) ' +
        "VALUES (?1, NULL, ?2, ?3, 'test', 'scheduled', ?4)",
    ).bind(questionId, body.prompt, JSON.stringify(body.options), t),
    c.env.DB.prepare(
      'INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json) ' +
        "VALUES (?1, 'daily', NULL, ?2, ?3, ?4, ?5, 'scheduled', ?6, ?7)",
    ).bind(
      roundId,
      questionId,
      body.opensAt,
      body.closesAt,
      beaconRound,
      t,
      JSON.stringify(config),
    ),
    c.env.DB.prepare(
      "INSERT INTO round_modes (round_id, mode, status) VALUES (?1, 'free', 'pending')",
    ).bind(roundId),
  ]);
  const locked: LockedRound = {
    roundId,
    kind: 'daily',
    roomId: null,
    questionId,
    opensAt: body.opensAt,
    closesAt: body.closesAt,
    beaconRound,
    beaconTimeSec: beaconTime(chain, beaconRound),
    config,
    modes: ['free'],
  };
  const state = await roundStub(c.env, roundId).init(locked);
  log.warn('test_round_created', { roundId, beaconRound });
  return c.json({ locked, state }, 201);
});

/** GET /__test/rounds/:id: the RoundDO state and what D1 holds for the round's Free mode. */
app.get('/rounds/:id', validate('param', RoundParamsSchema), async (c) => {
  const { id } = c.req.valid('param');
  const round = await c.env.DB.prepare(
    'SELECT r.status, m.status AS free_status, m.commitment_root FROM rounds r ' +
      "JOIN round_modes m ON m.round_id = r.id AND m.mode = 'free' WHERE r.id = ?1",
  )
    .bind(id)
    .first<{ status: string; free_status: string; commitment_root: string | null }>();
  if (!round) throw new HttpError('not_found', 'no such round');
  const { results } = await c.env.DB.prepare(
    "SELECT id, user_id, stake, commitment, receipt_seq FROM entries WHERE round_id = ?1 AND mode = 'free' ORDER BY receipt_seq",
  )
    .bind(id)
    .all<{ id: string; user_id: string; stake: number; commitment: string; receipt_seq: number }>();
  return c.json({
    state: await roundStub(c.env, id).getState(),
    status: round.status,
    free: { status: round.free_status, commitmentRoot: round.commitment_root },
    entries: results.map((e) => ({
      id: e.id,
      userId: e.user_id,
      stake: e.stake,
      commitment: e.commitment,
      seq: e.receipt_seq,
    })),
  });
});

/**
 * POST /__test/rounds/:id/reveal: checks `signature` for the round's beacon and opens every Free
 * entry with it in this Worker: `decryptWithSignature` on each ciphertext, then `classify` (whose
 * first call runs tlock's self-test). Writes nothing; settlement is W5-A's.
 */
app.post(
  '/rounds/:id/reveal',
  validate('param', RoundParamsSchema),
  validate('json', RevealSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { signature } = c.req.valid('json');
    const row = await c.env.DB.prepare('SELECT beacon_round FROM rounds WHERE id = ?1')
      .bind(id)
      .first<{ beacon_round: number }>();
    if (!row) throw new HttpError('not_found', 'no such round');
    const chain = chainOf(c.env);
    if (!verifyBeacon(chain, row.beacon_round, signature)) {
      throw new HttpError('bad_request', `not the beacon signature for round ${row.beacon_round}`);
    }
    const { results } = await c.env.DB.prepare(
      "SELECT id, ciphertext FROM entries WHERE round_id = ?1 AND mode = 'free' ORDER BY receipt_seq",
    )
      .bind(id)
      .all<{ id: string; ciphertext: ArrayBuffer }>();
    const roundRef = roundRefFromUlid(id);
    const entries = [];
    for (const e of results) {
      const ct = new Uint8Array(e.ciphertext);
      // decryptWithSignature throws on a ciphertext that does not open; classify says why.
      const opened = await decryptWithSignature(chain, ct, signature).catch(() => null);
      const plaintext = opened ? decodePlaintext(opened) : null;
      const result = await classify({
        ct,
        chain,
        beaconRound: row.beacon_round,
        signature,
        roundRef,
      });
      entries.push({
        id: e.id,
        decryptedOption: plaintext?.optionIndex ?? null,
        ...(result.valid
          ? { valid: true, optionIndex: result.optionIndex }
          : { valid: false, voidReason: result.voidReason }),
      });
    }
    return c.json({ beaconRound: row.beacon_round, entries });
  },
);

app.notFound((c) => notFound(c.req.path));

/** The seam's fetch handler; `src/index.ts` sends `/__test/*` here. */
export const testSeam = app;
