// The indexer's cron job (spec "Architecture": every minute, indexer kick). W4-D registers it in
// src/cron.ts as CRON_HANDLERS.indexer_kick. The IndexerDO does the work and sets its own fast-poll
// alarms; the kick also restarts them if they ever stop.
import { INDEXER_SINGLETON } from '../do/indexer-do.js';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';

export async function indexerKick(env: Env, scheduledTime: number): Promise<void> {
  const indexer = env.INDEXER.get(env.INDEXER.idFromName(INDEXER_SINGLETON));
  const r = await indexer.poll();
  log.info('indexer_kick', { scheduledTime, ...r });
}
