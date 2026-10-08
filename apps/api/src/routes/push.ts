// Route module `push`: web push subscriptions. Owner: W9-A. Until then every endpoint of this module
// in the pinned ENDPOINTS table answers 501 `not_implemented`.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { stubEndpoints } from './stub.js';

export const push = stubEndpoints(new Hono<AppEnv>(), 'push');
