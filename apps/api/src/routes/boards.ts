// Route module `boards`: leaderboards. Owner: W8-B. Until then every endpoint of this module
// in the pinned ENDPOINTS table answers 501 `not_implemented`.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { stubEndpoints } from './stub.js';

export const boards = stubEndpoints(new Hono<AppEnv>(), 'boards');
