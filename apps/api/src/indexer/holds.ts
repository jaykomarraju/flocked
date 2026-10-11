// settlement_holds: a mode whose settlement waits for the guardian. The indexer raises a hold for a
// foreign entry (entered.ts); the settlement coordinator (wave 5) checks settlementHold before it posts.
import type { Mode } from '@flocked/shared';
import type { Hex } from 'viem';

export type HoldReason = 'foreign_entry';

export interface SettlementHold {
  roundId: string;
  mode: Mode;
  reason: HoldReason;
  /** The event that raised it. */
  txHash: Hex;
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
    .first<{ reason: HoldReason; tx_hash: string; created_at: number }>();
  return row
    ? { roundId, mode, reason: row.reason, txHash: row.tx_hash as Hex, createdAt: row.created_at }
    : null;
}
