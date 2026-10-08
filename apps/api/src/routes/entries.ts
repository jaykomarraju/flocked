// Route module `entries`: Free entries and the caller's entries. Owner: W3-B. Until then every endpoint of this module
// in the pinned ENDPOINTS table answers 501 `not_implemented`.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { stubEndpoints } from './stub.js';

export const entries = stubEndpoints(new Hono<AppEnv>(), 'entries');
