// Route module `users`: public profiles (W8-B; the read is in src/stats/profile.ts). Public and
// cached for 5 s at the edge for anonymous reads. Deleted and merged accounts answer 404.
import { UserProfileParamsSchema } from '@flocked/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { cachedRead, readResponse } from '../read/cache.js';
import { readProfile } from '../stats/profile.js';

export const users = new Hono<AppEnv>();

users.get('/users/:handle', validate('param', UserProfileParamsSchema), async (c) => {
  const cached = await cachedRead(c);
  if (cached) return cached;
  const profile = await readProfile(c.env, c.req.valid('param').handle, now(c.env));
  if (!profile) throw new HttpError('not_found', 'No such user');
  return readResponse(c, profile, { membersOnly: false });
});
