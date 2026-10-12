// Route module `rounds`: round reads and verification (W6-D; the WebSocket upgrade is W7-A's).
// The reads live in src/read/; this file wires them to the pinned ENDPOINTS table.
//
// Reveal gating (spec "API"): no response carries per-option data for a mode before its
// `revealed_at` (src/read/), and room rounds are for their members only on every route here, the
// WebSocket stub and the round card (src/read/access.ts). Room-round responses are `private,
// no-store` and never enter the edge cache; public reads are cached for 5 s (src/read/cache.ts).
//
// The verification bundle's objects are served at GET /rounds/:id/bundles/:mode/:file (not in the
// pinned table yet; see docs/sessions/W6-D.md), behind the same gate.
import { IdParamsSchema, ModeSchema, RoundsArchiveQuerySchema } from '@flocked/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { validate } from '../lib/validate.js';
import { accessFor, requireRoundAccess } from '../read/access.js';
import { PRIVATE_CACHE_CONTROL, cachedRead, readResponse } from '../read/cache.js';
import { openDailyRound, readArchive, readRound, readToday } from '../read/rounds.js';
import { BUNDLE_FILE_RE, readBundleObject, readVerify } from '../read/verify.js';
import { applyDailyGrant, recordPriorTransactions } from '../rounds/grant.js';
import { stubEndpoints } from './stub.js';

const app = new Hono<AppEnv>();

/**
 * The first-visit daily grant (spec "Modes: Free and Stakes"): a signed-in visit to the open daily
 * round decides the grant, through `applyDailyGrant` so a grant skipped earlier that game day stays
 * skipped, after `recordPriorTransactions` so a wallet-only account's onchain history counts. A
 * failure is logged and never fails the read.
 */
async function firstVisitGrant(env: Env, userId: string, t: number): Promise<void> {
  try {
    const open = await openDailyRound(env.DB, t);
    if (!open) return;
    const i = { userId, roundId: open.id, now: t };
    await recordPriorTransactions(env, i);
    await applyDailyGrant(env.DB, i);
  } catch (err) {
    log.error('daily_grant_visit_failed', { error: String(err) });
  }
}

app.get('/rounds/today', async (c) => {
  const user = c.get('user');
  const t = now(c.env);
  if (user?.status === 'active') await firstVisitGrant(c.env, user.id, t);
  const cached = await cachedRead(c);
  if (cached) return cached;
  return readResponse(c, await readToday(c.env, t), { membersOnly: false });
});

app.get('/rounds', validate('query', RoundsArchiveQuerySchema), async (c) => {
  const cached = await cachedRead(c);
  if (cached) return cached;
  const body = await readArchive(c.env, c.req.valid('query'));
  return readResponse(c, body, { membersOnly: false });
});

app.get('/rounds/:id', validate('param', IdParamsSchema), async (c) => {
  const { id } = c.req.valid('param');
  const access = await accessFor(c, id);
  if (!access.membersOnly) {
    const cached = await cachedRead(c);
    if (cached) return cached;
  }
  const round = await readRound(c.env, id);
  if (!round) throw new HttpError('not_found', 'No such round');
  return readResponse(c, { round }, access);
});

app.get('/rounds/:id/verify', validate('param', IdParamsSchema), async (c) => {
  const { id } = c.req.valid('param');
  const access = await accessFor(c, id);
  if (!access.membersOnly) {
    const cached = await cachedRead(c);
    if (cached) return cached;
  }
  return readResponse(c, await readVerify(c.env, id), access);
});

const BundleParamsSchema = z.object({
  id: IdParamsSchema.shape.id,
  mode: ModeSchema,
  file: z.string().regex(BUNDLE_FILE_RE),
});

app.get('/rounds/:id/bundles/:mode/:file', validate('param', BundleParamsSchema), async (c) => {
  const { id, mode, file } = c.req.valid('param');
  const access = await accessFor(c, id);
  const obj = await readBundleObject(c.env, id, mode, file);
  if (!obj) throw new HttpError('not_found', 'No such bundle object');
  // Bundle objects are write-once (docs/bundle-format.md), so a public one never changes.
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': access.membersOnly
        ? PRIVATE_CACHE_CONTROL
        : 'public, max-age=31536000, immutable',
    },
  });
});

// The WebSocket (W7-A) and the round card (W10-A, module `cards`, mounted after this one) are still
// stubs; their room rounds are gated here already.
app.use('/rounds/:id/ws', requireRoundAccess);
app.use('/rounds/:id/card/*', requireRoundAccess);

export const rounds = stubEndpoints(app, 'rounds');
