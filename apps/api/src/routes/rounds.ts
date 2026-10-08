// Route module `rounds`: round reads, verify, WebSocket upgrade (W7-A). Owner: W6-D. Until then every endpoint of this module
// in the pinned ENDPOINTS table answers 501 `not_implemented`.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { stubEndpoints } from './stub.js';

export const rounds = stubEndpoints(new Hono<AppEnv>(), 'rounds');
