// Route module `admin`: admin API. Owner: W11-A. Until then every endpoint of this module
// in the pinned ENDPOINTS table answers 501 `not_implemented`.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { stubEndpoints } from './stub.js';

export const admin = stubEndpoints(new Hono<AppEnv>(), 'admin');
