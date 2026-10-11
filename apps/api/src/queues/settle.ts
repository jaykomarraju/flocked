// The `settle` consumer (spec "Architecture": Settlement coordinator). The RoundDO enqueues one
// message per mode at beacon time (key `${roundId}:${mode}`) and the Free rule-8 job at beacon time
// + 24 h (key `${roundId}:free:rule8`). The first starts that mode's SettlementDO, which is
// idempotent, so a redelivered message settles once. A message for a round or mode D1 doesn't know
// throws, so it ends in the DLQ for inspection instead of being dropped.
import type { SettleMessage } from '@flocked/shared';
import { settlementName } from '../do/settlement-do.js';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { rule8Key, settleKey } from '../rounds/schedule.js';
import { refundFree } from '../settlement/apply/free.js';

export async function settleHandler(body: SettleMessage, env: Env): Promise<void> {
  const { roundId, mode, idempotencyKey } = body;
  if (mode === 'free' && idempotencyKey === rule8Key(roundId)) {
    // Rule 8: the conditional pending → refunded update (W5-D). A SettlementDO still waiting for
    // the beacon sees the mode refunded on its next attempt and stops.
    await refundFree(env, roundId, 8);
    return;
  }
  if (idempotencyKey !== settleKey(roundId, mode)) {
    throw new Error(`settle: unknown idempotency key ${idempotencyKey}`);
  }
  const row = await env.DB.prepare(
    'SELECT 1 AS ok FROM round_modes WHERE round_id = ?1 AND mode = ?2',
  )
    .bind(roundId, mode)
    .first<{ ok: number }>();
  if (!row) throw new Error(`settle: round ${roundId} has no ${mode} mode`);
  const stub = env.SETTLEMENT.get(env.SETTLEMENT.idFromName(settlementName(roundId, mode)));
  const { started, status } = await stub.start({ roundId, mode, idempotencyKey });
  log.info('settle_received', { roundId, mode, started, phase: status.phase });
}
