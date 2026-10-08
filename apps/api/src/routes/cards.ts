// Route module `cards`: share pages and card images. Owner: W10-A. Until then every endpoint of this module
// in the pinned ENDPOINTS table answers 501 `not_implemented`.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { stubEndpoints } from './stub.js';

export const cards = stubEndpoints(new Hono<AppEnv>(), 'cards');
