// Route module `stakes`: Stakes entry tickets. Owner: W6-B. `POST /rounds/:id/entries/stakes/prepare`
// runs every eligibility check, records the ticket and has the ticket signer (apps/signer, through
// the `SIGNER` service binding) sign it; src/stakes/prepare.ts has the rules. Rate limited per user
// (`entries`, 10/min).
import { IdParamsSchema, StakesPrepareRequestSchema } from '@flocked/shared';
import { Hono } from 'hono';
import type { Address } from 'viem';
import { limitUser } from '../auth/rate-limit.js';
import { getUser, requireUser, type AppEnv } from '../lib/auth-context.js';
import { validate } from '../lib/validate.js';
import { prepareStakesTicket } from '../stakes/prepare.js';
import { stubEndpoints } from './stub.js';

const app = new Hono<AppEnv>();

app.post(
  '/rounds/:id/entries/stakes/prepare',
  requireUser,
  limitUser('entries'),
  validate('param', IdParamsSchema),
  validate('json', StakesPrepareRequestSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { wallet } = c.req.valid('json');
    // AddressSchema: a lowercase 0x address.
    const body = await prepareStakesTicket(c.env, getUser(c), id, wallet as Address, c.req.raw);
    return c.json(body);
  },
);

export const stakes = stubEndpoints(app, 'stakes');
