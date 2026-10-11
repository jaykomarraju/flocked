// Lifecycle handlers for the chain indexer (wave-4 pinned interfaces: registered through
// src/indexer/handlers.ts, called once per event revision in chain order). W4-D:
//   - ticketed `Entered` → RoundDO.ingestStakesEntry (the counters; W6-A builds the rest of Stakes
//     ingestion, including undoing a reorged entry);
//   - `Locked` / `Committed` → `round_modes.lock_tx` / `commit_tx` for the Free mode (the AnchorDO sets
//     them from its receipts too; this is the canonical-chain confirmation). A reorged-out write is
//     cleared and handed back to the AnchorDO, which checks the chain again and resends it if it is
//     gone (W4-F1 N2);
//   - `RoundRefunded` reason 4 → the Stakes mode is voided. From a transaction the backend didn't send
//     it is a guardian void ("Round lifecycle": Stakes voided, Free continues; ALERT-8 already fired
//     in src/indexer/policy.ts), and the RoundDO is told through onModeResult. From the backend's own
//     voidRound it confirms the admin void, which the RoundDO applies to every mode itself, unless the
//     RoundDO had abandoned that void: then Free goes on unvoided, which alerts (W4-F1 V1).
// Handlers never throw for a permanent condition (they alert and return; W4-F1 V3): dispatch stops
// at the first failure.
import { roundKey } from '@flocked/shared';
import { beaconTime, chainFromEnv } from '@flocked/tlock';
import { keccak256, type Hex } from 'viem';
import { ANCHOR_SINGLETON } from '../chain/client.js';
import type { AnchorCommitItem, AnchorLockItem } from '../do/types.js';
import type { Env } from '../env.js';
import { resolveEntered } from '../indexer/entered.js';
import type { HandlerRegistry } from '../indexer/registry.js';
import { isSentTx } from '../indexer/sent.js';
import type { ChainEvent, EventHandler } from '../indexer/types.js';
import { raiseAlert } from '../lib/alert.js';
import { log } from '../lib/log.js';
import { VOID_REFUND_REASON } from './void.js';
import type { RoundDO } from '../do/round-do.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isNotFound = (err: unknown) => message(err).startsWith('not_found');
/** RoundDO's RangeErrors (another round, a missing mode, a bad argument): retrying can't help. */
const isPermanent = (err: unknown) =>
  err instanceof RangeError || /^(ingestStakesEntry|onModeResult):/.test(message(err));

/** Ticketed `Entered` → the RoundDO's Stakes counters. Foreign entries are entered.ts's. */
export const stakesIngestHandler: EventHandler = async (evt, env) => {
  if (evt.contractKind !== 'escrow') return;
  if (evt.removed) {
    // Undoing a counted entry is W6-A's (with the chunk files); the count is only a display value.
    log.warn('stakes_entry_removed', { txHash: evt.txHash, logIndex: evt.logIndex });
    return;
  }
  const m = await resolveEntered(env.DB, evt);
  if (m.roundId === null || m.userId === null || m.stake === null) return;
  try {
    await env.ROUND.get(env.ROUND.idFromName(m.roundId)).ingestStakesEntry({
      roundId: m.roundId,
      chainRoundId: m.args.chainRoundId,
      player: m.args.player,
      personTag: m.args.personTag,
      ticketHash: m.args.ticketHash,
      stake: m.stake,
      commitment: keccak256(m.args.ciphertext),
      userId: m.userId,
      txHash: evt.txHash,
      blockNumber: evt.blockNumber,
      logIndex: evt.logIndex,
      blockTimestampSec: evt.blockTimestampSec,
    });
  } catch (err) {
    if (!isNotFound(err) && !isPermanent(err)) throw err;
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId: m.roundId,
      step: 'ingest_stakes_entry',
      error: message(err),
      txHash: evt.txHash,
    });
  }
};

/** The app round whose Free round key is `key`, from the lock's `closesAt`; null if none. */
async function freeRoundOfKey(db: D1Database, evt: ChainEvent, key: Hex): Promise<string | null> {
  let closesAtSec: string | null;
  if (evt.event === 'Locked') {
    closesAtSec = String(evt.args.closesAt);
  } else {
    const lock = await db
      .prepare(
        `SELECT json_extract(args_json, '$.closesAt') AS closes_at FROM chain_events
         WHERE chain_id = ?1 AND event = 'Locked' AND removed = 0
           AND json_extract(args_json, '$.roundKey') = ?2 LIMIT 1`,
      )
      .bind(evt.chainId, key)
      .first<{ closes_at: string | number | null }>();
    closesAtSec = lock?.closes_at == null ? null : String(lock.closes_at);
  }
  if (closesAtSec === null || !/^[0-9]+$/.test(closesAtSec)) return null;
  const { results } = await db
    .prepare(
      "SELECT r.id FROM rounds r JOIN round_modes m ON m.round_id = r.id AND m.mode = 'free' WHERE r.closes_at = ?1",
    )
    .bind(Number(closesAtSec) * 1000)
    .all<{ id: string }>();
  return results.find((r) => roundKey(r.id, 'free') === key)?.id ?? null;
}

/** `Locked` / `Committed` → the Free mode's lock_tx / commit_tx. */
export const anchorConfirmationHandler: EventHandler = async (evt, env) => {
  if (evt.contractKind !== 'anchor') return;
  const key = String(evt.args.roundKey).toLowerCase() as Hex;
  const roundId = await freeRoundOfKey(env.DB, evt, key);
  if (roundId === null) {
    log.info('anchor_event_unknown_key', {
      chainEvent: evt.event,
      roundKey: key,
      txHash: evt.txHash,
    });
    return;
  }
  const column = evt.event === 'Locked' ? 'lock_tx' : 'commit_tx';
  const db = env.DB;
  if (evt.removed) {
    log.warn('anchor_write_reorged', { roundId, chainEvent: evt.event, txHash: evt.txHash });
    await resubmitWrite(env, evt, roundId, key);
    return [
      db
        .prepare(
          `UPDATE round_modes SET ${column} = NULL WHERE round_id = ?1 AND mode = 'free' AND ${column} = ?2`,
        )
        .bind(roundId, evt.txHash),
    ];
  }
  if (evt.event === 'Committed') {
    const row = await db
      .prepare("SELECT commitment_root FROM round_modes WHERE round_id = ?1 AND mode = 'free'")
      .bind(roundId)
      .first<{ commitment_root: string | null }>();
    const onchain = String(evt.args.commitmentRoot).toLowerCase();
    if (row?.commitment_root?.toLowerCase() !== onchain) {
      raiseAlert(env, 'ALERT_DO_ERROR', {
        roundId,
        step: 'commitment_mismatch',
        stored: row?.commitment_root ?? null,
        onchain,
        txHash: evt.txHash,
      });
    }
  }
  log.info('anchor_write_confirmed', { roundId, chainEvent: evt.event, txHash: evt.txHash });
  return [
    db
      .prepare(
        `UPDATE round_modes SET ${column} = ?2 WHERE round_id = ?1 AND mode = 'free' AND ${column} IS NULL`,
      )
      .bind(roundId, evt.txHash),
  ];
};

/**
 * N2: a reorged-out `Locked` / `Committed` goes back to the AnchorDO, rebuilt from the removed event
 * (it carries the values written). The AnchorDO reads the chain: still written (re-mined), it stays
 * confirmed; gone, it is sent again while its window is open, and alerts once it can't be.
 */
async function resubmitWrite(env: Env, evt: ChainEvent, roundId: string, key: Hex): Promise<void> {
  const a = evt.args;
  const anchor = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
  try {
    if (evt.event === 'Locked') {
      const item: AnchorLockItem = {
        roundKey: key,
        roundId,
        mode: 'free',
        closesAtSec: Number(a.closesAt),
        beaconRound: Number(a.beaconRound),
        questionHash: String(a.questionHash) as Hex,
        configHash: String(a.configHash) as Hex,
      };
      await anchor.submitLock([item]);
      return;
    }
    const round = await env.DB.prepare('SELECT closes_at, beacon_round FROM rounds WHERE id = ?1')
      .bind(roundId)
      .first<{ closes_at: number; beacon_round: number | null }>();
    if (!round?.beacon_round) throw new Error('the round has no beacon round');
    const chain = chainFromEnv({
      DRAND_CHAIN_HASH: env.DRAND_CHAIN_HASH,
      DRAND_PUBLIC_KEY: env.DRAND_PUBLIC_KEY,
      DRAND_GENESIS: env.DRAND_GENESIS,
      DRAND_PERIOD: env.DRAND_PERIOD,
    });
    const item: AnchorCommitItem = {
      roundKey: key,
      roundId,
      mode: 'free',
      root: String(a.commitmentRoot) as Hex,
      entryCount: Number(a.entryCount),
      totalStake: String(a.totalStake),
      closesAtSec: Math.floor(round.closes_at / 1000),
      beaconRound: round.beacon_round,
      beaconTimeSec: beaconTime(chain, round.beacon_round),
    };
    await anchor.submitCommit(item);
  } catch (err) {
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'anchor_write_resubmit',
      eventName: evt.event,
      error: message(err),
      txHash: evt.txHash,
    });
  }
}

/** `RoundRefunded` reason 4 → the Stakes mode is voided (a guardian void, or our own voidRound). */
export const stakesVoidHandler: EventHandler = async (evt, env) => {
  if (evt.contractKind !== 'escrow' || Number(evt.args.reason) !== VOID_REFUND_REASON) return;
  const db = env.DB;
  const row = await db
    .prepare("SELECT round_id FROM round_modes WHERE mode = 'stakes' AND chain_round_id = ?1")
    .bind(String(evt.args.roundId))
    .first<{ round_id: string }>();
  if (!row) return;
  const roundId = row.round_id;
  if (evt.removed) {
    // A void cannot be undone onchain, so a reorged-out void is re-mined or the chain disagrees
    // with D1; either way someone has to look.
    raiseAlert(env, 'ALERT_DO_ERROR', { roundId, step: 'void_reorged', txHash: evt.txHash });
    return;
  }
  const ours = await isSentTx(db, evt.chainId, evt.txHash);
  log.warn(ours ? 'stakes_void_confirmed' : 'guardian_void', { roundId, txHash: evt.txHash });
  const stub = env.ROUND.get(env.ROUND.idFromName(roundId));
  // Our own void voids Free too, through the RoundDO, unless the RoundDO abandoned it at close: then
  // it landed anyway (V1), Free goes on, and Stakes is voided as for a guardian void.
  const abandoned = ours && (await ourVoidAbandoned(env, roundId, stub));
  if (abandoned) {
    raiseAlert(env, 'ALERT_DO_ERROR', {
      roundId,
      step: 'void_landed_after_abandon',
      txHash: evt.txHash,
      blockNumber: evt.blockNumber,
    });
  }
  if (!ours || abandoned) {
    try {
      await stub.onModeResult('stakes', {
        outcome: 'refunded',
        reason: VOID_REFUND_REASON,
        provisional: false,
      });
    } catch (err) {
      if (isNotFound(err)) {
        log.warn('guardian_void_round_not_initialized', { roundId });
      } else if (isPermanent(err)) {
        raiseAlert(env, 'ALERT_DO_ERROR', {
          roundId,
          step: 'stakes_void_mode_result',
          error: message(err),
          txHash: evt.txHash,
        });
      } else {
        throw err;
      }
    }
  }
  return [
    db
      .prepare(
        `UPDATE round_modes SET status = 'voided', refund_reason = ?2, final_at = ?3
         WHERE round_id = ?1 AND mode = 'stakes' AND status IN ('pending', 'revealing')`,
      )
      .bind(roundId, VOID_REFUND_REASON, evt.blockTimestampSec * 1000),
  ];
};

/**
 * True when Free is still live in D1 and the RoundDO holds no void for it (it abandoned it). A void
 * still being applied (requested or confirmed) counts as not abandoned.
 */
async function ourVoidAbandoned(
  env: Env,
  roundId: string,
  stub: DurableObjectStub<RoundDO>,
): Promise<boolean> {
  const free = await env.DB.prepare(
    "SELECT status FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
  )
    .bind(roundId)
    .first<{ status: string }>();
  if (!free || free.status === 'voided') return false;
  try {
    return !(await stub.getState()).voidRequested;
  } catch (err) {
    if (isNotFound(err)) return true;
    throw err;
  }
}

/** Registers the W4-D lifecycle handlers on `registry`. Names are stable (chain_event_handled). */
export function registerLifecycleHandlers(registry: HandlerRegistry): HandlerRegistry {
  registry.register('Entered', 'stakes-ingest', stakesIngestHandler);
  registry.register('Locked', 'anchor-confirmation', anchorConfirmationHandler);
  registry.register('Committed', 'anchor-confirmation', anchorConfirmationHandler);
  registry.register('RoundRefunded', 'stakes-void', stakesVoidHandler);
  return registry;
}
