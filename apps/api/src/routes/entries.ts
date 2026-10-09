// Route module `entries`: Free entries and the caller's entries. POST /rounds/:id/entries is W3-B's
// (the RoundDO commit protocol answers it); GET /rounds/:id/me is still a 501 stub (W6).
import { CreateEntryRequestSchema, ERROR_STATUS, IdParamsSchema } from '@flocked/shared';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { limitUser } from '../auth/rate-limit.js';
import { getUser, requireUser, type AppEnv } from '../lib/auth-context.js';
import { HttpError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { stubEndpoints } from './stub.js';

const app = new Hono<AppEnv>();

/**
 * POST /rounds/:id/entries: a sealed Free entry. The round's RoundDO checks, commits and signs it;
 * the response is the committed entry and its receipt. Rate limited per user (`entries`, 10/min).
 * Registered before the module's stubs, so it answers instead of the 501.
 */
app.post(
  '/rounds/:id/entries',
  requireUser,
  limitUser('entries'),
  validate('param', IdParamsSchema),
  validate('json', CreateEntryRequestSchema),
  async (c) => {
    const user = getUser(c);
    const { id: roundId } = c.req.valid('param');
    const body = c.req.valid('json');
    const round = c.env.ROUND.get(c.env.ROUND.idFromName(roundId));
    const result = await round.enterFree({ roundId, userId: user.id, body });
    if (!result.ok) {
      throw new HttpError(
        result.code,
        result.message,
        ERROR_STATUS[result.code] as ContentfulStatusCode,
      );
    }
    return c.json(result.value, 201);
  },
);

export const entries = stubEndpoints(app, 'entries');
