// The Stakes apply hook (wave-5 pinned interface). W5-A ships a stub; W6-A implements it (the
// proposal, then D1 at finalize). SettlementDO never calls it while settlementHold is open.
import type { Env } from '../../env.js';
import { NotImplementedError } from '../../lib/errors.js';
import type { TallyResult } from '../types.js';

/** Posts a Stakes mode's proposal. Must be idempotent: SettlementDO calls it again on a retry. */
export function applyStakes(_env: Env, _result: TallyResult): Promise<void> {
  return Promise.reject(new NotImplementedError('applyStakes'));
}
