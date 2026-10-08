// The Hono app behind `fetch` (spec "API": a JSON REST API under /api/v1). Every error and every
// unknown path answers in the `{error: {code, message}}` envelope.
import { API_BASE_PATH } from '@flocked/shared';
import { Hono } from 'hono';
import type { AppEnv } from './lib/auth-context.js';
import { notFound, onError } from './lib/errors.js';
import { routes } from './routes/index.js';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(notFound);
  // W3-A adds the session middleware here (it sets `user` and `session`; see lib/auth-context.ts).
  app.route(API_BASE_PATH, routes);
  return app;
}

export const app = createApp();
