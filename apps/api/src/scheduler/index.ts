// The scheduler's cron jobs (spec "Architecture": Scheduler), for src/cron.ts's `CRON_HANDLERS`:
// `scheduler_tick` every minute (gap check, question lock, Stakes createRound, Free lock leaves,
// RoundDO.init) and `create_rounds_ahead` hourly (daily rounds 48 h ahead). W4-D registers them.
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';
import { createRoundsAhead } from './create.js';
import { schedulerTick } from './tick.js';

export { CREATE_AHEAD_MS, createRoundsAhead, dailySlot, slotsAhead } from './create.js';
export { LOCK_LEAD_MS, lockRound, lockedRoundOf, recordGap } from './lock.js';
export { schedulerTick, type SchedulerDeps, type TickReport } from './tick.js';

/** Cron handlers with src/cron.ts's `CronJobHandler` shape. The game clock, not `scheduledTime`. */
export const SCHEDULER_JOBS = {
  scheduler_tick: async (env: Env, _scheduledTime: number): Promise<void> => {
    const report = await schedulerTick(env);
    log.info('scheduler_tick', {
      createdForGap: report.createdForGap.length,
      locks: Object.keys(report.locks).length,
      lockLeaves: report.lockLeaves.length,
      initialized: report.initialized.length,
    });
  },
  create_rounds_ahead: async (env: Env, _scheduledTime: number): Promise<void> => {
    const created = await createRoundsAhead(env, now(env));
    log.info('rounds_created_ahead', { created: created.length });
  },
} as const;
