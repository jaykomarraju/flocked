// Mounts one Hono sub-app per route module (plan P2.4). Every module registers full paths
// (relative to /api/v1), so each is mounted at '/'. Modules mount in ROUTE_MODULES order.
import { ROUTE_MODULES, type RouteModule } from '@flocked/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { admin } from './admin.js';
import { auth } from './auth.js';
import { boards } from './boards.js';
import { cards } from './cards.js';
import { claims } from './claims.js';
import { entries } from './entries.js';
import { limits } from './limits.js';
import { me } from './me.js';
import { paymaster } from './paymaster.js';
import { push } from './push.js';
import { questions } from './questions.js';
import { rooms } from './rooms.js';
import { rounds } from './rounds.js';
import { stakes } from './stakes.js';
import { users } from './users.js';

export const ROUTE_APPS: Record<RouteModule, Hono<AppEnv>> = {
  auth,
  me,
  rounds,
  entries,
  stakes,
  claims,
  questions,
  boards,
  users,
  rooms,
  cards,
  push,
  limits,
  admin,
  paymaster,
};

export const routes = new Hono<AppEnv>();
for (const module of ROUTE_MODULES) routes.route('/', ROUTE_APPS[module]);
