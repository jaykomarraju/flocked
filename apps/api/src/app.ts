// The Hono app behind `fetch` (spec "API": a JSON REST API under /api/v1). Every error and every
// unknown path answers in the `{error: {code, message}}` envelope.
import { API_BASE_PATH } from '@flocked/shared';
import { Hono } from 'hono';
import { sessionMiddleware } from './auth/session.js';
import type { AppEnv } from './lib/auth-context.js';
import { notFound, onError } from './lib/errors.js';
import { routes } from './routes/index.js';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(notFound);
  // Resolves the session cookie or Bearer token into `user` and `session` (lib/auth-context.ts).
  app.use(`${API_BASE_PATH}/*`, sessionMiddleware);
  app.route(API_BASE_PATH, routes);
  return app;
}

export const app = createApp();
