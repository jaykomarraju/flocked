// WebSocket messages the RoundDO builds from what it is told (spec "Real-time and the reveal",
// WebSocket messages). The wire shapes are packages/shared/src/ws.ts.
import type { Mode, WsRefundedMessage } from '@flocked/shared';
import type { ModeResult } from '../do/types.js';

/**
 * `refunded` for a mode result (Decision log, Oct 8: `provisional` and `finalAt`):
 *   - a Stakes refund proposal (`provisional`): final at the proposal's `claimsOpenAt`;
 *   - any other refund (Free, a final Stakes `RoundRefunded`, a void) is final already: `finalAt`
 *     is `t`, when the RoundDO learns of it (D1's `final_at` is the record).
 */
export function refundedMessage(
  roundId: string,
  mode: Mode,
  result: Extract<ModeResult, { outcome: 'refunded' }>,
  t: number,
): WsRefundedMessage {
  const provisional = mode === 'stakes' && result.provisional;
  return {
    type: 'refunded',
    roundId,
    mode,
    refundReason: result.reason,
    provisional,
    finalAt: provisional ? (result.claimsOpenAt ?? t) : t,
  };
}
