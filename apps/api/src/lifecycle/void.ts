// The two-phase void (spec "Round lifecycle" › Void, refund rule 4). Phase 1 is RoundDO.requestVoid:
// entries stop at once. Phase 2 runs from the RoundDO's alarm: a round with a live Stakes mode needs
// `voidRound` mined, and FlockedEscrow refuses it in any block stamped at or after closesAt, so a mined
// call is a void confirmed before close. A Free-only round has nothing onchain and confirms at once.
// A void still unconfirmed at close is abandoned once the chain is past closesAt (a pending voidRound
// can then only revert), and every mode follows the normal close path.
//
// A confirmed void is applied in D1 by applyVoid: the round is sealed (no Free entry commits after),
// every Free stake comes back as `void_refund`, and every live mode is `voided` with refund reason 4.
import type { Mode } from '@flocked/shared';
import type { Hex } from 'viem';
import { voidRound, type OperatorDeps } from '../chain/operator.js';
import { publicClient } from '../chain/client.js';
import type { LockedRound } from '../do/types.js';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { applyMovement, creditMovement, scopeForRound } from '../points/index.js';
import { listFreeEntries } from '../rounds/entry.js';

/** FlockedEscrow `RoundRefunded` reason and `round_modes.refund_reason` for a void (rule 4). */
export const VOID_REFUND_REASON = 4;

export type VoidStep =
  /** Every mode can be voided: `voidRound` is mined, or there is no live Stakes mode. */
  | { status: 'confirmed'; txHash: Hex | null }
  /** Not confirmed yet; try again (before close) or resolve it (at close). */
  | { status: 'pending'; txHash: Hex | null; detail: string };

/** Phase 2: `voidRound` for a live Stakes mode (at most once per round, src/chain/operator.ts). */
export async function pushVoid(
  env: Env,
  deps: OperatorDeps,
  locked: LockedRound,
): Promise<VoidStep> {
  if (!locked.modes.includes('stakes')) return { status: 'confirmed', txHash: null };
  const row = await env.DB.prepare(
    "SELECT status, chain_round_id FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'",
  )
    .bind(locked.roundId)
    .first<{ status: string; chain_round_id: string | null }>();
  // The guardian voided Stakes already (the indexer recorded it): nothing is left onchain to void.
  if (!row || row.status === 'voided') return { status: 'confirmed', txHash: null };
  const chainRoundId = locked.chainRoundId ?? row.chain_round_id;
  if (!chainRoundId) return { status: 'pending', txHash: null, detail: 'no chain round ID' };
  const r = await voidRound(env, deps, { roundId: locked.roundId, chainRoundId });
  switch (r.status) {
    case 'mined':
      return { status: 'confirmed', txHash: r.txHash };
    case 'pending':
      return { status: 'pending', txHash: r.txHash, detail: 'voidRound not mined yet' };
    case 'reverted':
      // Only when the escrow round is no longer Open (a guardian void the indexer hasn't seen yet,
      // which the next attempt finds in D1) or closesAt has passed onchain.
      return { status: 'pending', txHash: r.txHash, detail: 'voidRound reverted' };
    case 'refused':
      return { status: 'pending', txHash: null, detail: r.error };
  }
}

/**
 * How long past closesAt (game clock) a pending void is given up even if the chain head is still
 * stamped earlier: Base's sequencer stamps blocks at about wall time, so no block before closesAt
 * appears this late, and anvil mines no empty blocks, so its head can lag indefinitely.
 */
export const VOID_RESOLVE_GRACE_MS = 20_000;

/**
 * At close, for a void that is still pending: true once no block that could still confirm the void
 * is outstanding (FlockedEscrow reverts `voidRound` in any block stamped at or after closesAt): the
 * chain head is stamped at or after closesAt, or the grace has passed. Until then the caller retries.
 */
export async function chainPastClose(
  env: Env,
  deps: OperatorDeps,
  locked: LockedRound,
  t: number,
): Promise<boolean> {
  if (t >= locked.closesAt + VOID_RESOLVE_GRACE_MS) return true;
  const head = await publicClient(env, deps.transport).getBlock({ blockTag: 'latest' });
  return Number(head.timestamp) >= Math.floor(locked.closesAt / 1000);
}

/** Modes a confirmed void moves to `voided` (anything already terminal keeps its outcome). */
const LIVE_STATUSES = "('pending', 'revealing')";

/**
 * Applies a confirmed void in D1 (idempotent): seals the round, refunds every committed Free stake
 * (`void_refund`, once per user and round) and voids every live mode with refund reason 4.
 * Returns the modes it voided now.
 */
export async function applyVoid(env: Env, locked: LockedRound, t: number): Promise<Mode[]> {
  const db = env.DB;
  const id = locked.roundId;
  // Sealing first means the refund list below is final: no Free entry insert commits after it.
  await db.prepare("UPDATE rounds SET status = 'closed' WHERE id = ?1").bind(id).run();
  let refunded = 0;
  if (locked.modes.includes('free')) {
    const scope = scopeForRound(locked);
    for (const e of await listFreeEntries(db, id)) {
      const out = await applyMovement(
        db,
        creditMovement(db, {
          userId: e.userId,
          scope,
          amount: e.stake,
          reason: 'void_refund',
          refId: id,
          now: t,
        }),
      );
      // `duplicate`: an earlier attempt refunded this entry already.
      if (out.status === 'applied') refunded += 1;
    }
  }
  const { results } = await db
    .prepare(
      `UPDATE round_modes SET status = 'voided', refund_reason = ?2, final_at = ?3
       WHERE round_id = ?1 AND status IN ${LIVE_STATUSES} RETURNING mode`,
    )
    .bind(id, VOID_REFUND_REASON, t)
    .all<{ mode: Mode }>();
  const voided = results.map((r) => r.mode);
  log.warn('round_voided', { roundId: id, modes: voided, freeRefunds: refunded });
  return voided;
}

/**
 * The admin void's entry point (the admin routes call it, W12): phase 1 on the round's RoundDO, which
 * then drives phase 2 from its alarm. Refused once closesAt has passed.
 */
export function requestRoundVoid(env: Env, roundId: string) {
  return env.ROUND.get(env.ROUND.idFromName(roundId)).requestVoid();
}
