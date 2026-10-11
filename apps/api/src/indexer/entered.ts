// `Entered` → user mapping and the foreign-entry path (spec "Identity and personhood" › Entry tickets
// (Stakes); Decision log, Oct 8, 2026). The indexer maps each `Entered` to its user through
// stakes_tickets by (round, personTag, wallet), never through current wallet links. An `Entered` with no
// ticket record is a foreign entry, only possible with a stolen ticket-signer key: it is stored with
// user_id NULL and foreign_entry = 1, raises ALERT_FOREIGN_EVENT, and holds the round's Stakes
// settlement for the guardian. The response (pause, disable the signer, veto or let it settle) is manual.
//
// Ticketed entries are not handled here: the Stakes ingestion handler (W4-D, W6-A) counts them, using
// resolveEntered for the same mapping.
import { newUlid } from '@flocked/shared';
import { hexToBytes, keccak256, type Hex } from 'viem';
import type { Env } from '../env.js';
import { raiseAlert } from '../lib/alert.js';
import type { ChainEvent } from './types.js';

export interface EnteredArgs {
  /** FlockedEscrow round ID (uint256 decimal). */
  chainRoundId: string;
  player: Hex;
  personTag: Hex;
  ticketHash: Hex;
  ciphertext: Hex;
}

export interface EnteredMatch {
  args: EnteredArgs;
  /** The app round whose Stakes mode has this chain round ID; null if none. */
  roundId: string | null;
  /** The round's fixed stake (USDC base units), from the locked config or `RoundCreated`. */
  stake: string | null;
  /** stakes_tickets.user_id for (round, personTag, wallet); null for a foreign entry. */
  userId: string | null;
}

const hexArg = (v: unknown, name: string): Hex => {
  if (typeof v !== 'string' || !/^0x[0-9a-f]*$/.test(v))
    throw new Error(`Entered.${name} is not hex`);
  return v as Hex;
};

export function enteredArgs(evt: Pick<ChainEvent, 'args'>): EnteredArgs {
  const a = evt.args;
  if (typeof a.roundId !== 'string' || !/^[0-9]+$/.test(a.roundId)) {
    throw new Error('Entered.roundId is not a uint');
  }
  return {
    chainRoundId: a.roundId,
    player: hexArg(a.player, 'player'),
    personTag: hexArg(a.personTag, 'personTag'),
    ticketHash: hexArg(a.ticketHash, 'ticketHash'),
    ciphertext: hexArg(a.ciphertext, 'ciphertext'),
  };
}

/** Maps an `Entered` event to its round and (through its ticket) its user. */
export async function resolveEntered(
  db: D1Database,
  evt: Pick<ChainEvent, 'args' | 'chainId'>,
): Promise<EnteredMatch> {
  const args = enteredArgs(evt);
  const round = await db
    .prepare(
      `SELECT m.round_id AS round_id, json_extract(r.config_json, '$.stakes.stake') AS stake
       FROM round_modes m JOIN rounds r ON r.id = m.round_id
       WHERE m.mode = 'stakes' AND m.chain_round_id = ?1 LIMIT 1`,
    )
    .bind(args.chainRoundId)
    .first<{ round_id: string; stake: string | number | null }>();
  if (!round) return { args, roundId: null, stake: null, userId: null };

  let stake = round.stake === null ? null : String(round.stake);
  if (stake === null) {
    const created = await db
      .prepare(
        `SELECT json_extract(args_json, '$.cfg.stake') AS stake FROM chain_events
         WHERE chain_id = ?1 AND event = 'RoundCreated' AND removed = 0
           AND json_extract(args_json, '$.roundId') = ?2 LIMIT 1`,
      )
      .bind(evt.chainId, args.chainRoundId)
      .first<{ stake: string | null }>();
    stake = created?.stake ?? null;
  }

  const ticket = await db
    .prepare(
      'SELECT user_id FROM stakes_tickets WHERE round_id = ?1 AND person_tag = ?2 AND wallet = ?3 LIMIT 1',
    )
    .bind(round.round_id, args.personTag, args.player)
    .first<{ user_id: string }>();
  return { args, roundId: round.round_id, stake, userId: ticket?.user_id ?? null };
}

/** The foreign-entry handler (registered for `Entered` in handlers.ts). */
export async function foreignEntryHandler(
  evt: ChainEvent,
  env: Env,
): Promise<D1PreparedStatement[] | void> {
  const db = env.DB;
  if (evt.removed) {
    // The log left the chain. A stored foreign entry goes with it; the hold stays for the guardian.
    return [
      db
        .prepare('DELETE FROM entries WHERE tx_hash = ?1 AND log_index = ?2 AND foreign_entry = 1')
        .bind(evt.txHash, evt.logIndex),
    ];
  }
  const m = await resolveEntered(db, evt);
  if (m.userId !== null) return;

  const stored = m.roundId !== null && m.stake !== null;
  raiseAlert(env, 'ALERT_FOREIGN_EVENT', {
    kind: 'foreign_entry',
    chainId: evt.chainId,
    chainRoundId: m.args.chainRoundId,
    roundId: m.roundId,
    player: m.args.player,
    personTag: m.args.personTag,
    ticketHash: m.args.ticketHash,
    txHash: evt.txHash,
    blockNumber: evt.blockNumber,
    logIndex: evt.logIndex,
    // Not stored when the chain round is unknown to the backend (its RoundCreated alerts on its own).
    stored,
    settlementHeld: m.roundId !== null,
  });
  if (m.roundId === null) return;

  const createdAt = evt.blockTimestampSec * 1000;
  const stmts: D1PreparedStatement[] = [];
  if (m.stake !== null) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO entries (id, round_id, mode, user_id, foreign_entry, wallet, person_tag, stake,
             ciphertext, commitment, tx_hash, block_number, log_index, created_at)
           VALUES (?1, ?2, 'stakes', NULL, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        )
        .bind(
          newUlid(createdAt),
          m.roundId,
          m.args.player,
          m.args.personTag,
          Number(m.stake),
          hexToBytes(m.args.ciphertext),
          keccak256(m.args.ciphertext),
          evt.txHash,
          evt.blockNumber,
          evt.logIndex,
          createdAt,
        ),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO settlement_holds (round_id, mode, reason, tx_hash, created_at)
         VALUES (?1, 'stakes', 'foreign_entry', ?2, ?3) ON CONFLICT DO NOTHING`,
      )
      .bind(m.roundId, evt.txHash, createdAt),
  );
  return stmts;
}
