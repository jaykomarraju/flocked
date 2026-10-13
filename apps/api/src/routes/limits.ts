// Route module `limits`: responsible-play limits (spec "Compliance and responsible play"). Owner:
// W7-B; the rules are in src/limits/. Registered in ENDPOINTS order.
import {
  SetLimitsRequestSchema,
  type ExclusionLiftResponse,
  type SetLimitsResponse,
} from '@flocked/shared';
import { Hono } from 'hono';
import { limitUser } from '../auth/rate-limit.js';
import { loadCaller, refuseSuspended } from '../identity/accounts.js';
import { getUser, requireUser, type AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { validate } from '../lib/validate.js';
import { requestExclusionLift, setLimits } from '../limits/index.js';

export const limits = new Hono<AppEnv>();

// A suspended account may still lower its cap and exclude itself; setLimits refuses a raise.
limits.put(
  '/me/limits',
  requireUser,
  limitUser('writes'),
  validate('json', SetLimitsRequestSchema),
  async (c) => {
    const caller = await loadCaller(c.env.DB, getUser(c).id);
    const state = await setLimits(
      c.env,
      caller.id,
      c.req.valid('json'),
      { suspended: caller.status === 'suspended' },
      now(c.env),
    );
    return c.json({ limits: state } satisfies SetLimitsResponse);
  },
);

limits.post('/me/limits/exclusion-lift', requireUser, limitUser('writes'), async (c) => {
  const caller = await loadCaller(c.env.DB, getUser(c).id);
  refuseSuspended(caller);
  const state = await requestExclusionLift(c.env, caller.id, now(c.env));
  return c.json({ limits: state } satisfies ExclusionLiftResponse);
});
