// Dedupe and delivery state per dedupe key (`notification_log`, migration 0021). The queue delivers at
// least once and producers may enqueue the same notice again (a retried handler, a RoundDO alarm that
// fires twice after an eviction), so the consumer claims each key before sending:
//   * the first claim inserts the row and holds a lease while it delivers;
//   * a redelivery finds the row done and sends nothing, or a live lease and retries later;
//   * a delivery that failed part-way keeps the channels it reached, so the retry sends the rest;
//   * a different `source` on the same key is reported as `taken` (the day's `outcome` was claimed
//     by another mode or round).
//
// Every claim is fenced by its lease (W9-F1 R3). The lease is the `claimed_until` the claim stored,
// and `markDelivered`, `finishKey` and `releaseKey` apply only while the row still holds it, so a
// batch stalled past its lease can't record a channel, finish the key or release the lease of the
// delivery that reclaimed it meanwhile: it has lost the key, and the new holder is responsible for
// it. Two live claims never share a lease, because a takeover needs `claimed_until <= t` and stores
// its own, later `t + LEASE_MS`, and a released lease is NULL until someone claims the key again.

/** How long a consumer holds a key while it delivers. */
export const LEASE_MS = 60_000;

/** A claim's fence: the `claimed_until` it stored, passed back to every write on the key. */
export type Lease = number;

export type Claim =
  | { kind: 'claimed'; lease: Lease; delivered: readonly string[] }
  | { kind: 'done' }
  | { kind: 'busy' }
  | { kind: 'taken'; source: string };

export interface ClaimRequest {
  key: string;
  userId: string | null;
  event: string;
  source: string;
}

/** Claims `key` for `source` at `t`. */
export async function claimKey(db: D1Database, req: ClaimRequest, t: number): Promise<Claim> {
  const lease = t + LEASE_MS;
  const inserted = await db
    .prepare(
      `INSERT INTO notification_log (dedupe_key, user_id, event, source, claimed_until, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(req.key, req.userId, req.event, req.source, lease, t)
    .run();
  if (inserted.meta.changes === 1) return { kind: 'claimed', lease, delivered: [] };
  // A lease that ran out (a consumer that died mid-delivery) or was released can be taken over. The
  // stored lease is read back, so the fence is what the row holds, not what this call meant to set.
  const taken = await db
    .prepare(
      `UPDATE notification_log SET claimed_until = ?3
       WHERE dedupe_key = ?1 AND source = ?2 AND done_at IS NULL
         AND (claimed_until IS NULL OR claimed_until <= ?4)
       RETURNING channels, claimed_until`,
    )
    .bind(req.key, req.source, lease, t)
    .first<{ channels: string; claimed_until: number }>();
  if (taken) {
    return {
      kind: 'claimed',
      lease: taken.claimed_until,
      delivered: JSON.parse(taken.channels) as string[],
    };
  }
  const row = await db
    .prepare('SELECT source, done_at FROM notification_log WHERE dedupe_key = ?1')
    .bind(req.key)
    .first<{ source: string; done_at: number | null }>();
  if (!row) return { kind: 'busy' };
  if (row.source !== req.source) return { kind: 'taken', source: row.source };
  return row.done_at !== null ? { kind: 'done' } : { kind: 'busy' };
}

/** Records that `channel` was delivered for `key`. False when the lease is no longer this one's. */
export async function markDelivered(
  db: D1Database,
  key: string,
  channel: string,
  lease: Lease,
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE notification_log SET channels = json_insert(channels, '$[#]', ?2)
       WHERE dedupe_key = ?1 AND claimed_until = ?3
         AND NOT EXISTS (SELECT 1 FROM json_each(notification_log.channels) WHERE value = ?2)`,
    )
    .bind(key, channel, lease)
    .run();
  if (updated.meta.changes === 1) return true;
  // Nothing changed: either the channel is listed already (a repeat) or the lease is gone.
  const row = await db
    .prepare('SELECT claimed_until FROM notification_log WHERE dedupe_key = ?1')
    .bind(key)
    .first<{ claimed_until: number | null }>();
  return row?.claimed_until === lease;
}

/** Marks `key` done: delivered, or nothing to deliver. False when the lease is no longer this one's. */
export async function finishKey(
  db: D1Database,
  key: string,
  t: number,
  lease: Lease,
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE notification_log SET done_at = ?2, claimed_until = NULL
       WHERE dedupe_key = ?1 AND claimed_until = ?3`,
    )
    .bind(key, t, lease)
    .run();
  return updated.meta.changes === 1;
}

/** Gives up the lease, so the queue's retry can claim the key at once. */
export async function releaseKey(db: D1Database, key: string, lease: Lease): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE notification_log SET claimed_until = NULL
       WHERE dedupe_key = ?1 AND done_at IS NULL AND claimed_until = ?2`,
    )
    .bind(key, lease)
    .run();
  return updated.meta.changes === 1;
}
