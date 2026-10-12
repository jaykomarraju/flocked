// Claims seen onchain (wave-4 pinned handler interface; W6-A's notes left `Claimed` / `RefundClaimed`
// to W6-D): FlockedEscrow `Claimed(roundId, player, kind, amount)` and `RefundClaimed(roundId,
// player, amount)` mark the wallet's `payouts` row claimed (`claimed_at` = the block's time,
// `claim_tx`), so GET /claims and GET /rounds/:id/me stop listing it. A wallet claims a round at most
// once (`hasClaimed`). A removed log (a reorg) clears the mark it set; the re-mined log sets it again.
// A claim with no payouts row (a foreign entry, which has none) changes nothing.
//
// Runs in Node too (e2e/tests/indexer-reorg.test.ts imports src/indexer/**): no `cloudflare:workers`.
import type { PayoutKind } from '@flocked/shared';
import { log } from '../lib/log.js';
import type { HandlerRegistry } from '../indexer/registry.js';
import type { EventHandler } from '../indexer/types.js';

/** FlockedEscrow `Kind` → payouts.kind. */
const KINDS: readonly PayoutKind[] = ['win', 'rebate', 'void_refund'];

export const claimedHandler: EventHandler = async (evt, env) => {
  if (evt.contractKind !== 'escrow') return;
  const db = env.DB;
  const mode = await db
    .prepare("SELECT round_id FROM round_modes WHERE mode = 'stakes' AND chain_round_id = ?1")
    .bind(String(evt.args.roundId))
    .first<{ round_id: string }>();
  if (!mode) return;
  const wallet = String(evt.args.player).toLowerCase();
  const kind = evt.event === 'RefundClaimed' ? 'refund' : KINDS[Number(evt.args.kind)];
  if (!kind) {
    log.warn('stakes_claim_unknown_kind', { roundId: mode.round_id, txHash: evt.txHash });
    return;
  }
  if (evt.removed) {
    return [
      db
        .prepare(
          `UPDATE payouts SET claimed_at = NULL, claim_tx = NULL
           WHERE round_id = ?1 AND mode = 'stakes' AND wallet = ?2 AND kind = ?3 AND claim_tx = ?4`,
        )
        .bind(mode.round_id, wallet, kind, evt.txHash),
    ];
  }
  return [
    db
      .prepare(
        `UPDATE payouts SET claimed_at = ?5, claim_tx = ?4
         WHERE round_id = ?1 AND mode = 'stakes' AND wallet = ?2 AND kind = ?3
           AND (claimed_at IS NULL OR claim_tx = ?4)`,
      )
      .bind(mode.round_id, wallet, kind, evt.txHash, evt.blockTimestampSec * 1000),
  ];
};

/** Registers the claim handlers on `registry`. Names are stable (chain_event_handled). */
export function registerClaimHandlers(registry: HandlerRegistry): HandlerRegistry {
  registry.register('Claimed', 'stakes-claimed', claimedHandler);
  registry.register('RefundClaimed', 'stakes-refund-claimed', claimedHandler);
  return registry;
}
