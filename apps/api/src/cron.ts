// Cron triggers (wrangler.jsonc `triggers.crons`; spec "Architecture": Scheduler and Chain indexer,
// "Data model": nightly reconciliation). Times are UTC. The jobs are stubs that only log until
// their owners land: scheduler and question lock (W4-A), indexer kick (W4-B), reconciliation
// (W5-D, src/jobs/reconcile.ts, using src/points findBalanceMismatches).
import type { Env } from './env.js';
import { log } from './lib/log.js';

export const CRONS = {
  /** Indexer kick + scheduler tick (question lock, house-question fill, daily cast). */
  everyMinute: '* * * * *',
  /** Create rounds 48 h ahead (idempotent). */
  hourly: '0 * * * *',
  /** Reconcile point_balances against points_ledger. */
  nightly: '15 8 * * *',
} as const;

export type CronJob =
  'scheduler_tick' | 'indexer_kick' | 'create_rounds_ahead' | 'reconcile_points';

/** The jobs each cron expression runs. Must cover every entry of wrangler.jsonc. */
export const CRON_JOBS: Record<string, readonly CronJob[]> = {
  [CRONS.everyMinute]: ['scheduler_tick', 'indexer_kick'],
  [CRONS.hourly]: ['create_rounds_ahead'],
  [CRONS.nightly]: ['reconcile_points'],
};

export type CronJobHandler = (env: Env, scheduledTime: number) => Promise<void>;

const pending =
  (job: CronJob): CronJobHandler =>
  (_env, scheduledTime) => {
    log.info('cron_job_not_implemented', { job, scheduledTime });
    return Promise.resolve();
  };

export const CRON_HANDLERS: Record<CronJob, CronJobHandler> = {
  scheduler_tick: pending('scheduler_tick'),
  indexer_kick: pending('indexer_kick'),
  create_rounds_ahead: pending('create_rounds_ahead'),
  reconcile_points: pending('reconcile_points'),
};

/** Runs one cron expression's jobs; one failing job doesn't stop the rest. Returns the jobs run. */
export async function runCron(cron: string, env: Env, scheduledTime: number): Promise<CronJob[]> {
  const jobs = CRON_JOBS[cron] ?? [];
  log.info('cron', { cron, scheduledTime, jobs });
  if (jobs.length === 0) log.warn('cron_unknown', { cron });
  const results = await Promise.allSettled(
    jobs.map((job) => CRON_HANDLERS[job](env, scheduledTime)),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      log.error('cron_job_failed', {
        job: jobs[i],
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });
  return [...jobs];
}

/** The Worker's `scheduled` export. */
export async function scheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  await runCron(controller.cron, env, controller.scheduledTime);
}
