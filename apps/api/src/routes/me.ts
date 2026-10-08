// Route module `me`: the caller's account. Owner: W3-A (profile, ToS), W5-B (personhood), W7-B (identities, merges, deletion), W8-B (referrals). Until then every endpoint of this module
// in the pinned ENDPOINTS table answers 501 `not_implemented`.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { stubEndpoints } from './stub.js';

export const me = stubEndpoints(new Hono<AppEnv>(), 'me');
