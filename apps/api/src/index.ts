// API Worker entry point (spec "Architecture"): the Hono app, cron triggers, queue consumers and
// every Durable Object class (wrangler.jsonc binds the classes by name). `/__test/*` goes to the
// local-only test seam, which answers 404 everywhere else (src/local/seam.ts).
import { app } from './app.js';
import { scheduled } from './cron.js';
import type { Env } from './env.js';
import { SEAM_PREFIX, testSeam } from './local/seam.js';
import { queue } from './queues/index.js';

export default {
  fetch: (request, env, ctx) =>
    new URL(request.url).pathname.startsWith(`${SEAM_PREFIX}/`)
      ? testSeam.fetch(request, env, ctx)
      : app.fetch(request, env, ctx),
  scheduled,
  queue: (batch, env, ctx) => queue(batch, env, ctx),
} satisfies ExportedHandler<Env>;

export {
  AnchorDO,
  AuthDO,
  IndexerDO,
  RateLimitDO,
  RoundDO,
  RoundViewerDO,
  SettlementDO,
} from './do/index.js';
