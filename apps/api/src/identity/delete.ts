// Account deletion, `DELETE /me` (spec "Identity and personhood" › Identities › Account deletion).
// Refused while the user is suspended or self-excluded, and while any of the user's rounds is still
// waiting to become final (an entry in a mode that isn't settled, refunded or voided, or a live
// Stakes ticket an entry may still come from).
//
// One D1 batch: the person ID moves into a `person_tombstones` row with the daily cap state and the
// account's ID (so the same person's next verification inherits the cap and the day's stakes; see
// src/personhood/verify.ts); the profile is anonymized (handle, display name, avatar, prefs, and the
// verification data) and `status = deleted`; every account merged into it is anonymized too;
// identities, sessions, notification prefs and push subscriptions are removed; pending merges
// expire; an `audit_log` row records it. Ledger, entries, payouts and stats stay under the opaque
// user ID. Afterwards the user's share cards are queued for a re-render without handle and avatar.
import { CARD_VARIANTS, type CardsMessage } from '@flocked/shared';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { excludedSql } from '../limits/rules.js';
import { loadCaller } from './accounts.js';
import { expireMergesStatement } from './merge.js';
import { abortIf, auditStatement, hasLiveTicketSql, hasOpenEntrySql, isGuardAbort } from './sql.js';

/** Cards messages per `sendBatch` (the Queues limit is 100). */
const CARDS_BATCH = 100;

/** Accounts merged into `userId`, directly or through another merged account. */
async function mergedInto(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      'WITH RECURSIVE m(id) AS (SELECT id FROM users WHERE merged_into = ?1 ' +
        'UNION SELECT u.id FROM users u JOIN m ON u.merged_into = m.id) SELECT id FROM m',
    )
    .bind(userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function deleteAccount(env: Env, userId: string, t: number): Promise<void> {
  const db = env.DB;
  const me = await loadCaller(db, userId);
  if (me.status === 'suspended') {
    throw new HttpError('account_suspended', 'A suspended account cannot be deleted');
  }
  if (me.status !== 'active')
    throw new HttpError('account_deleted', 'This account no longer exists');
  const merged = await mergedInto(db, userId);
  const ids = JSON.stringify([userId, ...merged]);
  const inIds = 'IN (SELECT value FROM json_each(?1))';
  const nowSec = Math.floor(t / 1000);

  const blocked = await db
    .prepare(
      `SELECT ${excludedSql('?2', '?3')} AS excluded, ` +
        `EXISTS (SELECT 1 FROM json_each(?1) j WHERE ${hasOpenEntrySql('j.value')} OR ` +
        `${hasLiveTicketSql('j.value', '?4')}) AS open`,
    )
    .bind(ids, userId, t, nowSec)
    .first<{ excluded: number; open: number }>();
  if (blocked?.excluded === 1) {
    throw new HttpError('self_excluded', 'A self-excluded account cannot be deleted');
  }
  if (blocked?.open === 1) {
    throw new HttpError(
      'deletion_blocked',
      'You have entries in a round that is not final yet; delete your account once it is',
    );
  }

  const statements: D1PreparedStatement[] = [
    // The checks again, inside the transaction.
    abortIf(db, "NOT EXISTS (SELECT 1 FROM users WHERE id = ?1 AND status = 'active')", userId),
    abortIf(
      db,
      `${excludedSql('?2', '?3')} OR EXISTS (SELECT 1 FROM json_each(?1) j WHERE ` +
        `${hasOpenEntrySql('j.value')} OR ${hasLiveTicketSql('j.value', '?4')})`,
      ids,
      userId,
      t,
      nowSec,
    ),
  ];
  if (me.person_id !== null) {
    // The cap state for the same person's next verification; a stricter earlier tombstone wins.
    statements.push(
      db
        .prepare(
          'INSERT INTO person_tombstones (person_id, daily_stake_cap, pending_cap, pending_cap_effective_at, created_at, user_id) ' +
            'SELECT ?1, l.daily_stake_cap, l.pending_cap, l.pending_cap_effective_at, ?3, ?2 ' +
            'FROM (SELECT 1) LEFT JOIN limits l ON l.user_id = ?2 WHERE true ' +
            'ON CONFLICT (person_id) DO UPDATE SET daily_stake_cap = CASE ' +
            'WHEN person_tombstones.daily_stake_cap IS NULL THEN excluded.daily_stake_cap ' +
            'WHEN excluded.daily_stake_cap IS NULL THEN person_tombstones.daily_stake_cap ' +
            'ELSE min(person_tombstones.daily_stake_cap, excluded.daily_stake_cap) END, ' +
            'pending_cap = excluded.pending_cap, pending_cap_effective_at = excluded.pending_cap_effective_at, ' +
            'created_at = excluded.created_at, user_id = excluded.user_id',
        )
        .bind(me.person_id, userId, t),
    );
  }
  statements.push(
    db
      .prepare(
        "UPDATE users SET status = 'deleted', handle = NULL, display_name = NULL, avatar_url = NULL, " +
          "prefs_json = '{}', person_id = NULL, kyc_status = NULL, person_verified_at = NULL, " +
          'coinbase_country = NULL, coinbase_region = NULL WHERE id = ?1',
      )
      .bind(userId),
    db
      .prepare(
        "UPDATE users SET handle = NULL, display_name = NULL, avatar_url = NULL, prefs_json = '{}' " +
          `WHERE id ${inIds}`,
      )
      .bind(ids),
    db.prepare(`DELETE FROM identities WHERE user_id ${inIds}`).bind(ids),
    db.prepare(`DELETE FROM sessions WHERE user_id ${inIds}`).bind(ids),
    db.prepare(`DELETE FROM notification_prefs WHERE user_id ${inIds}`).bind(ids),
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id ${inIds}`).bind(ids),
    ...[userId, ...merged].map((id) => expireMergesStatement(db, id)),
    auditStatement(db, {
      actor: 'user',
      actorUserId: userId,
      action: 'account_deleted',
      target: userId,
      data: { mergedAccounts: merged, tombstone: me.person_id !== null },
      now: t,
    }),
  );
  try {
    await db.batch(statements);
  } catch (err) {
    if (isGuardAbort(err)) {
      throw new HttpError('conflict', 'Your account changed while deleting it; try again');
    }
    throw err;
  }
  log.info('account_deleted', { userId, merged: merged.length });
  await requeueCards(env, ids);
}

/** Queues every share card of the deleted accounts for a re-render without handle and avatar. */
async function requeueCards(env: Env, ids: string): Promise<void> {
  const { results } = await env.DB.prepare(
    'SELECT round_id, mode, user_id, kind FROM share_cards WHERE user_id IN (SELECT value FROM json_each(?1))',
  )
    .bind(ids)
    .all<{
      round_id: string;
      mode: CardsMessage['mode'];
      user_id: string;
      kind: 'result' | 'teaser';
    }>();
  const messages = results.map((r) => ({
    body: {
      roundId: r.round_id,
      mode: r.mode,
      userId: r.user_id,
      kind: r.kind,
      variants: [...CARD_VARIANTS],
    } satisfies CardsMessage,
  }));
  try {
    for (let i = 0; i < messages.length; i += CARDS_BATCH) {
      await env.QUEUE_CARDS.sendBatch(messages.slice(i, i + CARDS_BATCH));
    }
  } catch (err) {
    // The account is deleted either way; the log names how many re-renders were not queued.
    log.error('card_rerender_enqueue_failed', {
      cards: messages.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
