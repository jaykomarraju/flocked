// When IndexerDO polls fast (spec "Architecture": Chain indexer polls every few seconds via alarms from
// closesAt − 5 min until proposals confirm). Proposals are Stakes-only: a Stakes mode is in flight while
// it is `pending` or `revealing`; the indexer moves it on when it sees `OutcomeProposed` (or a refund).
// The every-minute cron keeps polling in between, and after FAST_WINDOW_MAX_MS a stuck round falls back
// to it (other alerts cover a late proposal).

/** Alarm period inside a fast window (Base makes a block every 2 s). */
export const FAST_POLL_MS = 3_000;
/** The window opens this long before `closesAt`. */
export const FAST_WINDOW_LEAD_MS = 5 * 60_000;
/** The window closes this long after `closesAt` even if the proposal hasn't confirmed. */
export const FAST_WINDOW_MAX_MS = 2 * 3_600_000;
/** The cron's period: a window opening further away than this is left to a later cron tick. */
export const CRON_PERIOD_MS = 60_000;

export interface FastPollWindow {
  /** A Stakes mode is between closesAt − 5 min and its proposal (bounded by FAST_WINDOW_MAX_MS). */
  active: boolean;
  /** The next window opening after `nowMs` (epoch ms), if any round has one ahead. */
  nextStartAt: number | null;
}

export async function fastPollWindow(db: D1Database, nowMs: number): Promise<FastPollWindow> {
  const row = await db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM rounds r JOIN round_modes m ON m.round_id = r.id
                 WHERE m.mode = 'stakes' AND m.status IN ('pending', 'revealing')
                   AND r.closes_at - ?2 <= ?1 AND r.closes_at + ?3 > ?1) AS active,
         (SELECT MIN(r.closes_at) - ?2 FROM rounds r JOIN round_modes m ON m.round_id = r.id
          WHERE m.mode = 'stakes' AND m.status = 'pending' AND r.closes_at - ?2 > ?1) AS next_start`,
    )
    .bind(nowMs, FAST_WINDOW_LEAD_MS, FAST_WINDOW_MAX_MS)
    .first<{ active: number; next_start: number | null }>();
  return { active: row?.active === 1, nextStartAt: row?.next_start ?? null };
}

/**
 * The next alarm, as a delay from now in ms, or null for none (the cron covers it): FAST_POLL_MS in a
 * window, or the opening of a window that starts before the next cron tick.
 */
export function nextAlarmDelay(w: FastPollWindow, nowMs: number): number | null {
  if (w.active) return FAST_POLL_MS;
  if (w.nextStartAt !== null && w.nextStartAt - nowMs <= CRON_PERIOD_MS) {
    return Math.max(0, w.nextStartAt - nowMs);
  }
  return null;
}
