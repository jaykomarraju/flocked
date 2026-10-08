import { describe, expect, it } from 'vitest';

import { ALERT_CODES, ALERTS, isAlertCode } from '../src/alerts';

// Pinned by plan P2.4; triggers from Product_Spec.md ("Non-functional requirements" › Alerts).
describe('alerts', () => {
  it('pins the alert codes', () => {
    expect(ALERT_CODES).toEqual([
      'ALERT_SETTLEMENT_FAILED',
      'ALERT_COMMIT_LATE',
      'ALERT_SAFE_HEAD_LAG',
      'ALERT_INDEXER_LAG',
      'ALERT_VOID_RATE',
      'ALERT_DO_ERROR',
      'ALERT_SCHEDULE_GAP',
      'ALERT_WATCHER',
      'ALERT_FOREIGN_EVENT',
    ]);
  });

  it('describes every code and nothing else', () => {
    expect(Object.keys(ALERTS).sort()).toEqual([...ALERT_CODES].sort());
    for (const code of ALERT_CODES) {
      expect(['page', 'warn']).toContain(ALERTS[code].severity);
      expect(ALERTS[code].trigger.length).toBeGreaterThan(0);
    }
  });

  it('carries the spec thresholds', () => {
    expect(ALERTS.ALERT_COMMIT_LATE.threshold).toBe('min(closesAt + 90 s, beaconTime − 30 s)');
    expect(ALERTS.ALERT_SAFE_HEAD_LAG.threshold).toBe('beaconTime + 60 s');
    expect(ALERTS.ALERT_INDEXER_LAG.threshold).toBe('150 s');
  });

  it('isAlertCode', () => {
    expect(isAlertCode('ALERT_WATCHER')).toBe(true);
    expect(isAlertCode('ALERT_BEACON_LATE')).toBe(false);
    expect(isAlertCode(1)).toBe(false);
  });
});
