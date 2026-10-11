// sent_txs: every transaction the backend broadcast (wave-4 pinned interface). chain/tx.ts (W4-A) takes
// an `onTxSent` callback, and W4-D wires it to recordSentTx. The indexer raises ALERT_FOREIGN_EVENT for
// a role-only event whose transaction is not recorded here (ALERT-8; src/indexer/policy.ts).
import type { Hex } from 'viem';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';

/** What the backend sends: FlockedEscrow operator calls and FlockedAnchor anchor-key calls. */
export type SentTxKind =
  | 'createRound'
  | 'voidRound'
  | 'propose'
  | 'finalize'
  | 'refundTooFew'
  | 'refundTimeout'
  | 'lock'
  | 'commit'
  | 'manifest';

export interface SentTx {
  chainId: number;
  txHash: Hex;
  kind: SentTxKind;
  /** The round key the transaction is about; null when it has none (or carries several). */
  roundKey: Hex | null;
}

/**
 * Records a transaction the backend sent. Idempotent. Call it as soon as the hash is known (before or
 * right after broadcast): an event indexed before its row exists raises ALERT-8.
 */
export async function recordSentTx(
  env: Pick<Env, 'DB' | 'ENVIRONMENT' | 'FLOCKED_TEST_CLOCK'>,
  tx: SentTx,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sent_txs (chain_id, tx_hash, round_key, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT DO NOTHING`,
  )
    .bind(tx.chainId, tx.txHash.toLowerCase(), tx.roundKey?.toLowerCase() ?? '', tx.kind, now(env))
    .run();
}

/** True when the backend recorded sending `txHash` on `chainId`. */
export async function isSentTx(db: D1Database, chainId: number, txHash: Hex): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM sent_txs WHERE chain_id = ?1 AND tx_hash = ?2 LIMIT 1')
    .bind(chainId, txHash.toLowerCase())
    .first<{ ok: number }>();
  return row !== null;
}
