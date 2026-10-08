// Operator alerts (spec "Non-functional requirements" › Alerts). Each alert is one structured log
// line (level error, event `alert`) plus one Analytics Engine data point, so paging (W13-A) can key
// off either. Alert data goes through the same pre-beacon redaction as every log line.
import { ALERTS, type AlertCode } from '@flocked/shared';
import type { Env } from '../env.js';
import { log, redact, type LogOptions } from './log.js';

/** Analytics Engine blob size cap is 16 KB in total; keep the data blob well under it. */
const MAX_DATA_CHARS = 4096;

export type AlertEnv = Pick<Env, 'ANALYTICS' | 'ENVIRONMENT'>;

/**
 * Raises an alert. Never throws: alerting must not break the path that detected the problem.
 * Data point layout: index = code; blobs = [code, severity, environment, data JSON]; doubles = [1].
 */
export function raiseAlert(
  env: AlertEnv,
  code: AlertCode,
  data: Record<string, unknown> = {},
  opts: LogOptions = {},
): void {
  const severity = ALERTS[code].severity;
  log.error('alert', { ...data, code, severity }, opts);
  try {
    let json = JSON.stringify(redact(data, opts));
    if (json.length > MAX_DATA_CHARS) json = `${json.slice(0, MAX_DATA_CHARS)}…`;
    env.ANALYTICS.writeDataPoint({
      indexes: [code],
      blobs: [code, severity, env.ENVIRONMENT, json],
      doubles: [1],
    });
  } catch (err) {
    log.error('alert_write_failed', {
      code,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
