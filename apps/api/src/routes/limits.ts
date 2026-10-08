// Route module `limits`: responsible-play limits. Owner: W7-B. Until then every endpoint of this module
// in the pinned ENDPOINTS table answers 501 `not_implemented`.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { stubEndpoints } from './stub.js';

export const limits = stubEndpoints(new Hono<AppEnv>(), 'limits');
