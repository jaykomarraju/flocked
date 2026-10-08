// Route module `auth`: sign-in (SIWE, Farcaster, email), logout. Owner: W3-A. Until then every endpoint of this module
// in the pinned ENDPOINTS table answers 501 `not_implemented`.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { stubEndpoints } from './stub.js';

export const auth = stubEndpoints(new Hono<AppEnv>(), 'auth');
