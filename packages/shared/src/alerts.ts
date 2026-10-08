// Operator alert codes. Spec: "Non-functional requirements" › Alerts, with thresholds from "Round
// lifecycle", "Sealed picks" and "Smart contract" › Challenge window, watcher and guardian.
// `raiseAlert(code, data)` in apps/api takes one of these codes.

/** Every alert code, in the spec's list order. */
export const ALERT_CODES = [
  'ALERT_SETTLEMENT_FAILED',
  'ALERT_COMMIT_LATE',
  'ALERT_SAFE_HEAD_LAG',
  'ALERT_INDEXER_LAG',
  'ALERT_VOID_RATE',
  'ALERT_DO_ERROR',
  'ALERT_SCHEDULE_GAP',
  'ALERT_WATCHER',
  'ALERT_FOREIGN_EVENT',
] as const;
export type AlertCode = (typeof ALERT_CODES)[number];

/**
 * `page`: integrity or funds may be at risk, or a deadline-bound step is late; someone acts now.
 * `warn`: degraded but self-healing or bounded by a backstop; look within the hour. The spec does not
 * assign severities; these are the defaults until it does.
 */
export type AlertSeverity = 'page' | 'warn';

export interface AlertInfo {
  severity: AlertSeverity;
  /** What fires it, in the spec's words. */
  trigger: string;
  /** The numeric threshold, when the spec gives one. */
  threshold?: string;
}

export const ALERTS = {
  ALERT_SETTLEMENT_FAILED: {
    severity: 'page',
    trigger:
      'Settlement failure or reconciliation mismatch (Stakes: Entered log count or stake sum differs from entryCount or roundBalance at the close block, on two RPC providers)',
  },
  ALERT_COMMIT_LATE: {
    severity: 'page',
    trigger: 'A Free commitment not confirmed onchain by its deadline',
    threshold: 'min(closesAt + 90 s, beaconTime − 30 s)',
  },
  ALERT_SAFE_HEAD_LAG: {
    severity: 'page',
    trigger: "Base's safe head not past the close block by beacon time + 60 s",
    threshold: 'beaconTime + 60 s',
  },
  ALERT_INDEXER_LAG: {
    severity: 'warn',
    trigger: 'Chain indexer lag over 150 s',
    threshold: '150 s',
  },
  ALERT_VOID_RATE: {
    severity: 'page',
    trigger: "An anomalous VOID rate in a round's tally; settlement holds instead of posting",
  },
  ALERT_DO_ERROR: {
    severity: 'warn',
    trigger: 'Durable Object errors',
  },
  ALERT_SCHEDULE_GAP: {
    severity: 'page',
    trigger:
      'A schedule gap: no round or no question in place when one is due (at question lock the scheduler falls back to the top house question and alerts)',
  },
  ALERT_WATCHER: {
    severity: 'page',
    trigger: 'A watcher mismatch or unable-to-verify verdict, or a missing verdict',
    threshold: 'verdict missing 30 min after a proposal',
  },
  ALERT_FOREIGN_EVENT: {
    severity: 'page',
    trigger:
      'Any FlockedEscrow or FlockedAnchor event the backend did not send (for example a guardian void or veto)',
  },
} as const satisfies Record<AlertCode, AlertInfo>;

/** True for a known alert code. */
export function isAlertCode(value: unknown): value is AlertCode {
  return typeof value === 'string' && (ALERT_CODES as readonly string[]).includes(value);
}
