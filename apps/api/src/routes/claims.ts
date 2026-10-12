// Route module `claims`: unclaimed Stakes payouts and refunds (W6-D; src/read/claims.ts). Auth is
// `optional`: with `?wallet=` the claims come from public bundle data without sign-in (and are
// edge-cached like any public read); without it the caller must be signed in, and the answer is
// theirs alone (`private, no-store`).
import { ClaimsQuerySchema, type ClaimsResponse } from '@flocked/shared';
import { Hono } from 'hono';
import { getUser, type AppEnv } from '../lib/auth-context.js';
import { validate } from '../lib/validate.js';
import { cachedRead, readResponse } from '../read/cache.js';
import { claimsForUser, claimsForWallet } from '../read/claims.js';
import { stubEndpoints } from './stub.js';

const app = new Hono<AppEnv>();

app.get('/claims', validate('query', ClaimsQuerySchema), async (c) => {
  const { wallet } = c.req.valid('query');
  if (wallet) {
    const cached = await cachedRead(c);
    if (cached) return cached;
    const body: ClaimsResponse = { claims: await claimsForWallet(c.env, wallet) };
    return readResponse(c, body, { membersOnly: false });
  }
  const user = getUser(c);
  const body: ClaimsResponse = { claims: await claimsForUser(c.env, user.id) };
  return readResponse(c, body, { membersOnly: true });
});

export const claims = stubEndpoints(app, 'claims');
