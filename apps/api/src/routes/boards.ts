// Route module `boards`: leaderboards (W8-B; the reads are in src/boards/). Public: an anonymous
// read is cached for 5 s at the edge; a signed-in one carries the caller's own row (`me`) and is
// `private, no-store`.
import { LeaderboardParamsSchema, LeaderboardQuerySchema } from '@flocked/shared';
import { Hono } from 'hono';
import { readBoard } from '../boards/read.js';
import type { AppEnv } from '../lib/auth-context.js';
import { validate } from '../lib/validate.js';
import { cachedRead, readResponse } from '../read/cache.js';

export const boards = new Hono<AppEnv>();

boards.get(
  '/leaderboards/:board',
  validate('param', LeaderboardParamsSchema),
  validate('query', LeaderboardQuerySchema),
  async (c) => {
    const cached = await cachedRead(c);
    if (cached) return cached;
    const { board } = c.req.valid('param');
    const { mode = 'free', period } = c.req.valid('query');
    const viewer = c.get('user');
    const body = await readBoard(c.env, board, {
      mode,
      ...(period !== undefined ? { period } : {}),
      ...(viewer ? { viewerId: viewer.id } : {}),
    });
    return readResponse(c, body, { membersOnly: viewer !== undefined });
  },
);
