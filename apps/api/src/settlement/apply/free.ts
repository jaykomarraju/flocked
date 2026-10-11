// The Free apply hook (wave-5 pinned interface). W5-A ships stubs; W5-D implements the bodies:
// D1 writes (settlement record, payouts, ledger, entries), `revealed`, RoundDO.onModeResult, the
// manifest anchor and archival. Refund rules 7 and 8 come here too (`refundFree`).
import type { Env } from '../../env.js';
import { NotImplementedError } from '../../lib/errors.js';
import type { TallyResult } from '../types.js';

/** Applies a Free mode's settlement. Must be idempotent: SettlementDO calls it again on a retry. */
export function applyFree(_env: Env, _result: TallyResult): Promise<void> {
  return Promise.reject(new NotImplementedError('applyFree'));
}

/**
 * Refunds a Free mode that cannot settle: rule 7 (the commitment was not anchored before the
 * beacon; SettlementDO calls this at beacon time) or rule 8 (the beacon is still unavailable 24 h
 * after its round time; the settle consumer calls this for the RoundDO's rule-8 job). A
 * conditional update that applies only while the mode is still pending.
 */
export function refundFree(_env: Env, _roundId: string, _reason: 7 | 8): Promise<void> {
  return Promise.reject(new NotImplementedError('refundFree'));
}
