// Test-only seam for the local stack (W3-D; e2e/stack/README.md). It stands in for what `wrangler dev`
// and later waves don't provide: it creates and locks a Free round (D1 rows plus RoundDO.init), or
// creates an unlocked one for the real scheduler to lock (W4-D); moves the game clock; runs a cron
// expression's jobs (the stack's cron driver, e2e/stack/cron.mjs, calls it in place of Cloudflare's
// cron triggers, which `wrangler dev` doesn't fire); opens a round's entries with a beacon
// signature inside the Worker, so the e2e smoke test runs tlock in the `wrangler dev` bundle; and
// shows a round's settlement and serves its R2 bundle objects (W5-D, e2e/tests/free-settle.test.ts);
// and, for Stakes (W6-A, e2e/tests/stakes-settle.test.ts), schedules rounds with a Stakes mode, records
// the test's entry tickets, and shows the Stakes mode, its proposals, payouts and entries; and it
// releases a settlement hold as the guardian's admin action would (W6-F1 O1, for E2E-6).
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
  roundKey,
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
import { CRON_JOBS, runCron } from '../cron.js';
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

/** The app's own 404 (src/lib/errors.ts `notFound`), so the seam can't be told from an unknown path. */
const notFound = () => Response.json(errorEnvelope('not_found', 'Not found'), { status: 404 });

const guard: MiddlewareHandler<SeamEnv> = async (c, next) => {
  const key = c.env.FLOCKED_TEST_SEAM_KEY;
  const given = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (!seamEnabled(c.env) || !key || !timingSafeEqual(given, key)) return notFound();
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

/** A Stakes mode for a scheduled round: the launch defaults, any of them overridden (W6-A). */
const StakesOptionsSchema = z.strictObject({
  stake: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .optional(),
  feeBps: z.int().optional(),
  creatorBps: z.int().optional(),
  capMultiple: z.int().optional(),
  minEntrants: z.int().optional(),
  creator: z
    .string()
    .regex(/^0x[0-9a-f]{40}$/)
    .optional(),
});

const ScheduledRoundSchema = z
  .strictObject({
    opensAt: WholeSecondMs,
    closesAt: WholeSecondMs,
    beaconDelay: z.int().min(MIN_BEACON_DELAY).max(MAX_BEACON_DELAY).default(MIN_BEACON_DELAY),
    prompt: z.string().min(1).max(200).default('Sheep or goats?'),
    /** False: no Free mode (a Stakes-only round). */
    free: z.boolean().default(true),
    stakes: StakesOptionsSchema.optional(),
  })
  .refine((r) => r.closesAt > r.opensAt, 'closesAt must be after opensAt')
  .refine((r) => r.free || r.stakes !== undefined, 'at least one mode');

/** A Stakes round's creator when the test names none (any nonzero address). */
const TEST_CREATOR = `0x${'c0'.repeat(20)}`;

const TicketSchema = z.strictObject({
  roundId: UlidSchema,
  /** The ticket's user; a new one when absent. */
  userId: UlidSchema.optional(),
  wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  personTag: z.string().regex(/^0x[0-9a-f]{64}$/),
  /** Unix seconds, as signed. */
  expiry: z.int().positive(),
  ticketHash: z.string().regex(/^0x[0-9a-f]{64}$/),
});

const CronSchema = z.strictObject({
  cron: z.string().refine((c) => c in CRON_JOBS, 'not a configured cron expression'),
});

const HoldReleaseSchema = z.strictObject({
  roundId: UlidSchema,
  mode: z.enum(['free', 'stakes']),
  reason: z.enum(['foreign_entry', 'void_rate', 'refund_vetoed']),
});

/** `settlement_holds.released_by` for a release through the seam (no admin user exists locally). */
export const SEAM_HOLD_RELEASER = 'test-seam';

const RoundParamsSchema = z.strictObject({ id: UlidSchema });
const BundleParamsSchema = z.strictObject({
  id: UlidSchema,
  mode: z.enum(['free', 'stakes']),
  file: z.string().regex(/^(manifest|chunk-[0-9]{4,})\.json$/),
});
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

/**
 * POST /__test/rounds/scheduled: a daily-shaped round and its question, unlocked, as the scheduler's
 * hourly job creates them but with any open and close time (minutes apart, say). A Free mode by
 * default; `stakes` adds a Stakes mode (W6-A) and `free: false` drops Free. The scheduler's tick
 * locks it once opensAt − 6 h has passed (Stakes: `createRound` onchain; Free: its lock leaf) and
 * inits its RoundDO; nothing else is done here.
 */
app.post('/rounds/scheduled', validate('json', ScheduledRoundSchema), async (c) => {
  const body = c.req.valid('json');
  const config = LockedConfigSchema.parse({
    beaconDelay: body.beaconDelay,
    ...(body.free ? { free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null } } : {}),
    ...(body.stakes
      ? {
          stakes: {
            ...LOCKED_CONFIG_DEFAULTS.stakes,
            creator: TEST_CREATOR,
            ...body.stakes,
          },
        }
      : {}),
  });
  const t = now(c.env);
  const roundId = newUlid();
  const questionId = newUlid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at) ' +
        "VALUES (?1, NULL, ?2, ?3, 'test', 'scheduled', ?4)",
    ).bind(
      questionId,
      body.prompt,
      JSON.stringify([
        { label: 'Sheep', emoji: '🐑' },
        { label: 'Goats', emoji: '🐐' },
      ]),
      t,
    ),
    c.env.DB.prepare(
      'INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, status, config_json) ' +
        "VALUES (?1, 'daily', NULL, ?2, ?3, ?4, 'scheduled', ?5)",
    ).bind(roundId, questionId, body.opensAt, body.closesAt, JSON.stringify(config)),
  ]);
  log.warn('test_round_scheduled', { roundId, opensAt: body.opensAt, closesAt: body.closesAt });
  return c.json({ roundId, questionId }, 201);
});

/**
 * POST /__test/stakes/tickets: records an entry ticket the test signed itself (with the stack's
 * ticket-signer key, which the API never holds), as the signer path stores it before signing (W6-B).
 * The indexer maps the round's `Entered` to its user through it; without it the entry is foreign.
 */
app.post('/stakes/tickets', validate('json', TicketSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = body.userId ?? newUlid();
  await c.env.DB.prepare(
    `INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      body.ticketHash,
      body.roundId,
      body.personTag,
      userId,
      body.wallet,
      body.expiry,
      now(c.env),
    )
    .run();
  return c.json({ userId }, 201);
});

/**
 * POST /__test/holds/release {roundId, mode, reason}: releases an open settlement hold as the
 * guardian's admin action does (W11-A builds it for staging and production): `released_at` (the game
 * clock), `released_by` SEAM_HOLD_RELEASER and an `audit_log` row (actor admin, action
 * `settlement_hold_released`), in one batch. 404 when no such hold is open. The coordinator sees the
 * release on its next hold poll (HOLD_POLL_MS).
 */
app.post('/holds/release', validate('json', HoldReleaseSchema), async (c) => {
  const { roundId, mode, reason } = c.req.valid('json');
  const t = now(c.env);
  const db = c.env.DB;
  const [released] = await db.batch([
    db
      .prepare(
        `UPDATE settlement_holds SET released_at = ?4, released_by = ?5
         WHERE round_id = ?1 AND mode = ?2 AND reason = ?3 AND released_at IS NULL`,
      )
      .bind(roundId, mode, reason, t, SEAM_HOLD_RELEASER),
    // Only when the update released the hold (changes() is the batch's previous statement's).
    db
      .prepare(
        `INSERT INTO audit_log (id, actor, actor_user_id, action, target, data_json, created_at)
         SELECT ?1, 'admin', NULL, 'settlement_hold_released', ?2, ?3, ?4 WHERE changes() > 0`,
      )
      .bind(
        newUlid(t),
        roundId,
        JSON.stringify({ mode, reason, releasedBy: SEAM_HOLD_RELEASER }),
        t,
      ),
  ]);
  if (!released?.meta.changes) throw new HttpError('not_found', 'no such open hold');
  log.warn('test_hold_released', { roundId, mode, reason });
  return c.json({ roundId, mode, reason, releasedAt: t, releasedBy: SEAM_HOLD_RELEASER });
});

/** POST /__test/cron {cron}: runs that cron expression's jobs (src/cron.ts), as its trigger would. */
app.post('/cron', validate('json', CronSchema), async (c) => {
  const { cron } = c.req.valid('json');
  const jobs = await runCron(cron, c.env, Date.now());
  return c.json({ cron, jobs });
});

/**
 * GET /__test/rounds/:id: the RoundDO state, what D1 holds for the round's Free mode (null without
 * one), the Free round key's anchor events the indexer mirrored, and the Stakes mode (W6-A).
 */
app.get('/rounds/:id', validate('param', RoundParamsSchema), async (c) => {
  const { id } = c.req.valid('param');
  const round = await c.env.DB.prepare(
    'SELECT r.status, m.status AS free_status, m.commitment_root, m.lock_tx, m.commit_tx, ' +
      'm.refund_reason, m.bundle_hash, m.revealed_at FROM rounds r ' +
      "LEFT JOIN round_modes m ON m.round_id = r.id AND m.mode = 'free' WHERE r.id = ?1 " +
      // Unlocked rounds have no modes yet.
      'AND EXISTS (SELECT 1 FROM round_modes x WHERE x.round_id = r.id)',
  )
    .bind(id)
    .first<{
      status: string;
      free_status: string | null;
      commitment_root: string | null;
      lock_tx: string | null;
      commit_tx: string | null;
      refund_reason: number | null;
      bundle_hash: string | null;
      revealed_at: number | null;
    }>();
  if (!round) throw new HttpError('not_found', 'no such round');
  const { results: anchorEvents } = await c.env.DB.prepare(
    "SELECT event, tx_hash, removed FROM chain_events WHERE json_extract(args_json, '$.roundKey') = ?1 " +
      'ORDER BY block_number, log_index',
  )
    .bind(roundKey(id, 'free'))
    .all<{ event: string; tx_hash: string; removed: number }>();
  const { results } = await c.env.DB.prepare(
    'SELECT id, user_id, stake, commitment, receipt_seq, option_index, valid, void_reason, ' +
      "ciphertext IS NULL AS archived FROM entries WHERE round_id = ?1 AND mode = 'free' ORDER BY receipt_seq",
  )
    .bind(id)
    .all<{
      id: string;
      user_id: string;
      stake: number;
      commitment: string;
      receipt_seq: number;
      option_index: number | null;
      valid: number | null;
      void_reason: string | null;
      archived: number;
    }>();
  const settlement = await c.env.DB.prepare(
    'SELECT outcome, bundle_hash, manifest_r2_key, tx_hash, dust, winners_json FROM settlements ' +
      "WHERE round_id = ?1 AND mode = 'free' AND superseded_at IS NULL",
  )
    .bind(id)
    .first<{
      outcome: string;
      bundle_hash: string | null;
      manifest_r2_key: string | null;
      tx_hash: string | null;
      dust: number;
      winners_json: string | null;
    }>();
  const { results: payouts } = await c.env.DB.prepare(
    "SELECT user_id, kind, amount FROM payouts WHERE round_id = ?1 AND mode = 'free' ORDER BY user_id",
  )
    .bind(id)
    .all<{ user_id: string; kind: string; amount: number }>();
  return c.json({
    state: await roundStub(c.env, id).getState(),
    status: round.status,
    free: round.free_status && {
      status: round.free_status,
      commitmentRoot: round.commitment_root,
      lockTx: round.lock_tx,
      commitTx: round.commit_tx,
      refundReason: round.refund_reason,
      bundleHash: round.bundle_hash,
      revealedAt: round.revealed_at,
    },
    stakes: await stakesOf(c.env.DB, id),
    settlement: settlement && {
      outcome: settlement.outcome,
      bundleHash: settlement.bundle_hash,
      manifestKey: settlement.manifest_r2_key,
      txHash: settlement.tx_hash,
      dust: settlement.dust,
      winners:
        settlement.winners_json === null ? null : (JSON.parse(settlement.winners_json) as unknown),
    },
    payouts: payouts.map((p) => ({ userId: p.user_id, kind: p.kind, amount: p.amount })),
    anchorEvents: anchorEvents.map((e) => ({
      event: e.event,
      txHash: e.tx_hash,
      removed: e.removed === 1,
    })),
    entries: results.map((e) => ({
      id: e.id,
      userId: e.user_id,
      stake: e.stake,
      commitment: e.commitment,
      seq: e.receipt_seq,
      optionIndex: e.option_index,
      valid: e.valid === null ? null : e.valid === 1,
      voidReason: e.void_reason,
      archived: e.archived === 1,
    })),
  });
});

/** The Stakes mode as D1 holds it: status, proposals, payouts and entries (W6-A); null without one. */
async function stakesOf(db: D1Database, id: string) {
  const mode = await db
    .prepare(
      `SELECT status, chain_round_id, lock_tx, refund_reason, bundle_hash, revealed_at, claims_open_at,
         final_at FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'`,
    )
    .bind(id)
    .first<{
      status: string;
      chain_round_id: string | null;
      lock_tx: string | null;
      refund_reason: number | null;
      bundle_hash: string | null;
      revealed_at: number | null;
      claims_open_at: number | null;
      final_at: number | null;
    }>();
  if (!mode) return null;
  const [settlements, payouts, entries] = await db.batch([
    db
      .prepare(
        `SELECT proposal_seq, outcome, bundle_hash, tx_hash, payout_root, settled_at, superseded_at,
           winners_json FROM settlements WHERE round_id = ?1 AND mode = 'stakes' ORDER BY proposal_seq`,
      )
      .bind(id),
    db
      .prepare(
        "SELECT user_id, wallet, kind, amount FROM payouts WHERE round_id = ?1 AND mode = 'stakes' ORDER BY wallet, kind",
      )
      .bind(id),
    db
      .prepare(
        `SELECT id, user_id, wallet, tx_hash, block_number, log_index, option_index, valid, void_reason,
           foreign_entry, ciphertext IS NULL AS archived FROM entries
         WHERE round_id = ?1 AND mode = 'stakes' ORDER BY block_number, log_index`,
      )
      .bind(id),
  ]);
  type Row = Record<string, string | number | null>;
  const rows = (r: D1Result | undefined) => (r?.results ?? []) as Row[];
  return {
    status: mode.status,
    chainRoundId: mode.chain_round_id,
    lockTx: mode.lock_tx,
    refundReason: mode.refund_reason,
    bundleHash: mode.bundle_hash,
    revealedAt: mode.revealed_at,
    claimsOpenAt: mode.claims_open_at,
    finalAt: mode.final_at,
    settlements: rows(settlements).map((r) => ({
      seq: r.proposal_seq,
      outcome: r.outcome,
      bundleHash: r.bundle_hash,
      txHash: r.tx_hash,
      payoutRoot: r.payout_root,
      settledAt: r.settled_at,
      supersededAt: r.superseded_at,
      winners: r.winners_json === null ? null : (JSON.parse(String(r.winners_json)) as unknown),
    })),
    payouts: rows(payouts).map((r) => ({
      userId: r.user_id,
      wallet: r.wallet,
      kind: r.kind,
      amount: r.amount,
    })),
    entries: rows(entries).map((r) => ({
      id: r.id,
      userId: r.user_id,
      wallet: r.wallet,
      txHash: r.tx_hash,
      blockNumber: r.block_number,
      logIndex: r.log_index,
      optionIndex: r.option_index,
      valid: r.valid === null ? null : r.valid === 1,
      voidReason: r.void_reason,
      foreign: r.foreign_entry === 1,
      archived: r.archived === 1,
    })),
  };
}

/** GET /__test/bundles/:id/:mode/:file: a settlement bundle object from R2, byte for byte. */
app.get('/bundles/:id/:mode/:file', validate('param', BundleParamsSchema), async (c) => {
  const { id, mode, file } = c.req.valid('param');
  const obj = await c.env.BUCKET.get(`bundles/${id}/${mode}/${file}`);
  if (!obj) throw new HttpError('not_found', 'no such bundle object');
  return new Response(obj.body, { headers: { 'content-type': 'application/json' } });
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

app.notFound(() => notFound());

/** The seam's fetch handler; `src/index.ts` sends `/__test/*` here. */
export const testSeam = app;
