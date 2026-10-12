// The VOID-rate safety net (spec "Sealed picks" › Invalid entries): when a mode's VOID entries
// exceed 2 % of its entries and number at least 10, settlement holds and alerts instead of posting.
// The hold is a `settlement_holds` row (reason `void_rate`, migration 0008); only the guardian's
// admin action releases it (W11-A), as for a foreign-entry hold.
import type { Mode } from '@flocked/shared';

export const VOID_RATE_MIN_VOIDS = 10;
/** VOIDs > entries / 50 is "more than 2 %". */
export const VOID_RATE_DIVISOR = 50;

export function anomalousVoidRate(voids: number, entries: number): boolean {
  return voids >= VOID_RATE_MIN_VOIDS && voids * VOID_RATE_DIVISOR > entries;
}

/** Records the hold once; a released hold stays released (the row is kept, not re-opened). */
export async function holdForVoidRate(
  db: D1Database,
  roundId: string,
  mode: Mode,
  at: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settlement_holds (round_id, mode, reason, tx_hash, created_at)
       VALUES (?1, ?2, 'void_rate', NULL, ?3) ON CONFLICT DO NOTHING`,
    )
    .bind(roundId, mode, at)
    .run();
}
