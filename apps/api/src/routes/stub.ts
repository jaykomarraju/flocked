// 501 stubs for route modules whose owner session hasn't landed yet (plan P2.4). The endpoints come
// from the pinned table in @flocked/shared (`ENDPOINTS`), so every spec route answers 501 in the
// error envelope rather than 404. Owners replace `stubEndpoints(...)` with real handlers.
import { ENDPOINTS, type EndpointDef, type RouteModule } from '@flocked/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { errorResponse } from '../lib/errors.js';

/** The endpoints of one module, in table order (order matters: '/rounds/today' before '/rounds/:id'). */
export function endpointsOf(module: RouteModule): EndpointDef[] {
  return ENDPOINTS.filter((e) => e.module === module);
}

/** Registers a 501 `not_implemented` handler for every endpoint of `module` on `app`. */
export function stubEndpoints(app: Hono<AppEnv>, module: RouteModule): Hono<AppEnv> {
  for (const ep of endpointsOf(module)) {
    app.on(ep.method, ep.path, (c) =>
      errorResponse(c, 'not_implemented', `${ep.method} ${ep.path} is not implemented yet`),
    );
  }
  return app;
}
