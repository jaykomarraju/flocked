// Route module `rooms`: private groups (W8-D; spec "API", "Profiles, leaderboards and rooms" ›
// Rooms). The logic is in src/rooms/: create.ts, join.ts, detail.ts, questions.ts.
//
// Every route needs a session (401 `unauthorized`). Suspended accounts sign in read-only (spec
// "Identity and personhood" › Identities): the three writes refuse `account_suspended` first, before
// anything about the request is checked; GET /rooms/:id stays readable. A room is for its members
// only: an unknown or closed room and a non-member get the same 404, and every response, errors
// included, is `private, no-store`.
import {
  CreateRoomRequestSchema,
  IdParamsSchema,
  JoinRoomRequestSchema,
  SetRoomQuestionRequestSchema,
} from '@flocked/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { limitUser } from '../auth/rate-limit.js';
import { refuseSuspended } from '../identity/accounts.js';
import { getUser, requireUser, type AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { validate } from '../lib/validate.js';
import { PRIVATE_CACHE_CONTROL } from '../read/cache.js';
import { createRoom } from '../rooms/create.js';
import { readRoomDetail } from '../rooms/detail.js';
import { joinRoom } from '../rooms/join.js';
import { setRoomQuestion } from '../rooms/questions.js';

/** `Cache-Control: private, no-store` on the response, whatever it turns out to be. */
const privateNoStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header('Cache-Control', PRIVATE_CACHE_CONTROL);
  await next();
};

/** 403 `account_suspended` for a suspended caller (after `requireUser`). */
const refuseSuspendedUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  refuseSuspended(getUser(c));
  await next();
};

export const rooms = new Hono<AppEnv>();

rooms.post(
  '/rooms',
  privateNoStore,
  requireUser,
  refuseSuspendedUser,
  limitUser('writes'),
  validate('json', CreateRoomRequestSchema),
  async (c) => {
    const body = await createRoom(c.env.DB, getUser(c).id, c.req.valid('json'), now(c.env));
    return c.json(body, 201);
  },
);

rooms.post(
  '/rooms/join',
  privateNoStore,
  requireUser,
  refuseSuspendedUser,
  limitUser('writes'),
  validate('json', JoinRoomRequestSchema),
  async (c) => {
    const body = await joinRoom(c.env.DB, getUser(c).id, c.req.valid('json'), now(c.env));
    return c.json(body, 200);
  },
);

rooms.get(
  '/rooms/:id',
  privateNoStore,
  requireUser,
  validate('param', IdParamsSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = await readRoomDetail(c.env, id, getUser(c), now(c.env));
    return c.json(body, 200);
  },
);

rooms.post(
  '/rooms/:id/questions',
  privateNoStore,
  requireUser,
  refuseSuspendedUser,
  limitUser('writes'),
  validate('param', IdParamsSchema),
  validate('json', SetRoomQuestionRequestSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = await setRoomQuestion(c, id, getUser(c).id, c.req.valid('json'));
    return c.json(body, 201);
  },
);
