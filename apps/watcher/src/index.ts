// The watcher Worker (spec "Architecture": a separate account; Workers Cron). Its cron runs the
// tick (src/run.ts); its fetch handler serves the signed verdicts and nothing else — there is no
// route that can make it verify something, so the only thing a caller can do is read evidence.
import { getVerdict } from './db.js';
import { depsFor } from './deps.js';
import { isLocal, type Env } from './env.js';
import { tick } from './run.js';
import { VERDICT_SUBJECTS, watcherAddress, watcherKey, type VerdictSubject } from './verdict.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const notFound = () => json({ error: 'not_found' }, 404);

const isSubject = (s: string): s is VerdictSubject =>
  (VERDICT_SUBJECTS as readonly string[]).includes(s);

/** `GET /health`: whether this watcher is configured well enough to publish verdicts. */
function health(env: Env): Response {
  let signer: string | null = null;
  let error: string | null = null;
  try {
    signer = watcherAddress(watcherKey(env.WATCHER_KEY));
  } catch (e) {
    error = (e as Error).message;
  }
  return json({
    ok: error === null,
    environment: env.ENVIRONMENT,
    chainId: Number(env.CHAIN_ID),
    /** The address every verdict is signed by (OA-15 publishes it). */
    signer,
    /** True when the guardian paging channel is configured (OA-18); never the URL itself. */
    pager: Boolean(env.PAGER_WEBHOOK_URL),
    error,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && (path === '/health' || path === '/')) return health(env);

    const verdict = /^\/verdicts\/([^/]+)\/([^/]+)$/.exec(path);
    if (verdict) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const subject = decodeURIComponent(verdict[1] ?? '');
      const roundId = decodeURIComponent(verdict[2] ?? '');
      if (!isSubject(subject)) return notFound();
      const found = await getVerdict(env.DB, subject, roundId);
      return found ? json(found) : notFound();
    }

    // Local only: `wrangler dev` fires no cron triggers, so the stack drives the tick (as it does
    // the API's, e2e/stack/cron.mjs). Outside `local` this is a 404 like any other path.
    if (isLocal(env) && request.method === 'POST' && path === '/__test/tick') {
      try {
        return json(await runTick(env));
      } catch (e) {
        return json({ error: 'tick_failed', detail: (e as Error).message }, 503);
      }
    }

    return notFound();
  },

  scheduled(_controller, env, ctx): void {
    // A tick that cannot even start (a missing var, an unreadable drand chain) is logged and the
    // next minute tries again; it must never become an unhandled rejection.
    ctx.waitUntil(
      runTick(env).catch((e: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'watcher_tick_failed',
            error: e instanceof Error ? e.message.slice(0, 300) : String(e),
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>;

/** One tick, with its summary logged. Rejects only when the tick could not start at all. */
async function runTick(env: Env) {
  const summary = await tick(env, await depsFor(env), Date.now());
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'watcher_tick',
      snapshots: summary.snapshots,
      verdicts: summary.verdicts.length,
      paged: summary.paged,
      delivered: summary.delivered,
      failed: summary.failed,
      errors: summary.errors.slice(0, 5),
    }),
  );
  return summary;
}
