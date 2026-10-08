// API Worker entry point (spec "Architecture"): the Hono app, cron triggers, queue consumers and
// every Durable Object class (wrangler.jsonc binds the classes by name).
import { app } from './app.js';
import { scheduled } from './cron.js';
import type { Env } from './env.js';
import { queue } from './queues/index.js';

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
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
