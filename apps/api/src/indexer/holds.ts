// settlement_holds: a mode whose settlement waits for the guardian (spec "Data model"). The indexer
// raises a hold for a foreign entry (entered.ts) and for a vetoed Stakes refund proposal
// (handlers/stakes.ts); settlement raises one for an anomalous VOID rate. The settlement coordinator
// (wave 5) checks settlementHold before it posts.
import type { Mode } from '@flocked/shared';
import type { Hex } from 'viem';

/** Every reason the `settlement_holds.reason` CHECK allows (migration 0016). */
export type HoldReason = 'foreign_entry' | 'void_rate' | 'refund_vetoed';

export interface SettlementHold {
  roundId: string;
  mode: Mode;
  reason: HoldReason;
  /** The event that raised a foreign_entry hold; null for the other reasons (W7-F1 R17). */
  txHash: Hex | null;
  createdAt: number;
}

/** The first unreleased hold on (round, mode), or null when settlement may proceed. */
export async function settlementHold(
  db: D1Database,
  roundId: string,
  mode: Mode,
): Promise<SettlementHold | null> {
  const row = await db
    .prepare(
      `SELECT reason, tx_hash, created_at FROM settlement_holds
       WHERE round_id = ?1 AND mode = ?2 AND released_at IS NULL ORDER BY created_at LIMIT 1`,
    )
    .bind(roundId, mode)
    .first<{ reason: HoldReason; tx_hash: string | null; created_at: number }>();
  return row
    ? {
        roundId,
        mode,
        reason: row.reason,
        txHash: row.tx_hash as SettlementHold['txHash'],
        createdAt: row.created_at,
      }
    : null;
}
