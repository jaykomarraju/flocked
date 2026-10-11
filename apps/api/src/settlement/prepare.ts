// The settlement's inputs (spec "Sealed picks" › Free mode specifics and Invalid entries): the
// round as locked, the anchored commitment, and the entries in seq order, written to R2 as decrypt
// chunks of DECRYPT_CHUNK_SIZE. Free entries outside the anchored leaf set are VOID `not_anchored`
// and Free stakes outside the locked range `stake_out_of_range`; both are decided here, before
// decryption, and in that order (docs/bundle-format.md › VOID precedence).
import { freeCommitmentTree, type VoidReason } from '@flocked/settle';
import {
  LockedConfigSchema,
  MODE_CODES,
  roundKey,
  ulidToBytes,
  type LockedConfig,
  type Mode,
  type ModeStatus,
  type RoundKind,
} from '@flocked/shared';
import { roundRefFromChainId, roundRefFromUlid, toBase64Url } from '@flocked/tlock';
import { bytesToHex, type Hex } from 'viem';
import { receiptUserIdHash } from '../crypto/receipt.js';
import { ANCHOR_SINGLETON } from '../do/anchor-do.js';
import type { Env } from '../env.js';
import { DECRYPT_CHUNK_SIZE, decryptInputKey } from './keys.js';

/** The round and mode as settlement reads them from D1. */
export interface SettlementRound {
  roundId: string;
  mode: Mode;
  kind: RoundKind;
  roomId: string | null;
  /** Epoch ms. */
  closesAt: number;
  beaconRound: number;
  config: LockedConfig;
  /** The stored JSON, for the manifest. */
  configJson: unknown;
  status: ModeStatus;
  chainRoundId: string | null;
  commitmentRoot: Hex | null;
  commitTx: Hex | null;
}

interface RoundRow {
  kind: RoundKind;
  room_id: string | null;
  closes_at: number;
  beacon_round: number | null;
  locked_at: number | null;
  config_json: string | null;
  status: ModeStatus;
  chain_round_id: string | null;
  commitment_root: string | null;
  commit_tx: string | null;
}

/** The locked round and its mode row, or null when either is missing or the round isn't locked. */
export async function loadRound(
  db: D1Database,
  roundId: string,
  mode: Mode,
): Promise<SettlementRound | null> {
  const r = await db
    .prepare(
      `SELECT r.kind, r.room_id, r.closes_at, r.beacon_round, r.locked_at, r.config_json,
              m.status, m.chain_round_id, m.commitment_root, m.commit_tx
       FROM rounds r JOIN round_modes m ON m.round_id = r.id AND m.mode = ?2 WHERE r.id = ?1`,
    )
    .bind(roundId, mode)
    .first<RoundRow>();
  if (!r || r.locked_at === null || r.beacon_round === null || r.config_json === null) return null;
  const configJson = JSON.parse(r.config_json) as unknown;
  const config = LockedConfigSchema.parse(configJson);
  if (!config[mode]) throw new Error(`settlement: the locked config has no ${mode} section`);
  return {
    roundId,
    mode,
    kind: r.kind,
    roomId: r.room_id,
    closesAt: r.closes_at,
    beaconRound: r.beacon_round,
    config,
    configJson,
    status: r.status,
    chainRoundId: r.chain_round_id,
    commitmentRoot: (r.commitment_root?.toLowerCase() ?? null) as Hex | null,
    commitTx: (r.commit_tx?.toLowerCase() ?? null) as Hex | null,
  };
}

/** The 16-byte round reference the plaintexts carry (Free: the ULID; Stakes: the onchain ID). */
export function roundRefHex(round: SettlementRound): Hex {
  if (round.mode === 'free') return bytesToHex(roundRefFromUlid(round.roundId));
  if (round.chainRoundId === null) throw new Error('settlement: Stakes mode has no chain_round_id');
  return bytesToHex(roundRefFromChainId(BigInt(round.chainRoundId)));
}

// The anchored commitment (Free) ---------------------------------------------------------------

export type AnchoredCommitment =
  | {
      state: 'anchored';
      root: Hex;
      txHash: Hex;
      /** From the mirrored `Committed` event; null when the indexer hasn't mirrored it. */
      entryCount: number | null;
    }
  /** No entries, so nothing was anchored (refund rule 1, not rule 7). */
  | { state: 'empty' }
  /** The AnchorDO gave up (skipped or failed): not anchored before the beacon (rule 7). */
  | { state: 'missing'; detail: string }
  /** Not confirmed yet; check again. */
  | { state: 'waiting'; detail: string };

/** Where the Free commitment stands at beacon time. */
export async function anchoredCommitment(
  env: Pick<Env, 'DB' | 'ANCHOR'>,
  round: SettlementRound,
): Promise<AnchoredCommitment> {
  const key = roundKey(round.roundId, 'free');
  if (round.commitTx !== null && round.commitmentRoot !== null) {
    return {
      state: 'anchored',
      root: round.commitmentRoot,
      txHash: round.commitTx,
      entryCount: await committedEntryCount(env.DB, round.commitTx, key),
    };
  }
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM entries WHERE round_id = ?1 AND mode = 'free'",
  )
    .bind(round.roundId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) === 0) return { state: 'empty' };
  const anchor = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
  const commit = (await anchor.status(key)).commit;
  if (commit.state === 'confirmed' && commit.txHash && round.commitmentRoot !== null) {
    return {
      state: 'anchored',
      root: round.commitmentRoot,
      txHash: commit.txHash.toLowerCase() as Hex,
      entryCount: await committedEntryCount(env.DB, commit.txHash.toLowerCase() as Hex, key),
    };
  }
  if (commit.state === 'skipped' || commit.state === 'failed') {
    return { state: 'missing', detail: `${commit.state}: ${commit.detail ?? ''}` };
  }
  return { state: 'waiting', detail: `commit ${commit.state}` };
}

/** `entryCount` of the mirrored `Committed(roundKey, root, entryCount, totalStake)` in `txHash`. */
async function committedEntryCount(db: D1Database, txHash: Hex, key: Hex): Promise<number | null> {
  const { results } = await db
    .prepare(
      "SELECT args_json FROM chain_events WHERE tx_hash = ?1 AND event = 'Committed' AND removed = 0",
    )
    .bind(txHash)
    .all<{ args_json: string }>();
  for (const r of results) {
    const args = JSON.parse(r.args_json) as { roundKey?: string; entryCount?: string | number };
    if (args.roundKey?.toLowerCase() === key && args.entryCount !== undefined) {
      return Number(args.entryCount);
    }
  }
  return null;
}

// Decrypt chunks -------------------------------------------------------------------------------

/** One entry in a decrypt chunk (R2 working file; docs/bundle-format.md › Working files). */
export interface InputEntry {
  seq: number;
  entryId: string;
  account: string;
  stake: string;
  commitment: Hex;
  /** base64url; null only for an entry with `preVoid` whose D1 row has none. */
  ciphertext: string | null;
  /** A VOID decided before decryption (`not_anchored`, `stake_out_of_range`). */
  preVoid: VoidReason | null;
}

export interface DecryptInput {
  roundId: string;
  mode: Mode;
  index: number;
  beaconRound: number;
  /** 16 bytes hex: what every plaintext's round reference must equal. */
  roundRef: Hex;
  entries: InputEntry[];
}

export interface PreparedChunks {
  /** Decrypt input keys, by index. */
  keys: string[];
  entryCount: number;
}

export class IntegrityError extends Error {}

interface EntryRow {
  id: string;
  user_id: string | null;
  wallet: string | null;
  stake: number;
  commitment: string;
  ciphertext: ArrayBuffer | null;
  receipt_seq: number | null;
  block_number: number | null;
  log_index: number | null;
}

const COLUMNS =
  'id, user_id, wallet, stake, commitment, ciphertext, receipt_seq, block_number, log_index';

/** One page of the mode's entries in seq order, after `after` (keyset pagination). */
async function entryPage(
  db: D1Database,
  round: SettlementRound,
  after: EntryRow | null,
  limit: number,
): Promise<EntryRow[]> {
  if (round.mode === 'free') {
    const { results } = await db
      .prepare(
        `SELECT ${COLUMNS} FROM entries WHERE round_id = ?1 AND mode = 'free' AND receipt_seq > ?2
         ORDER BY receipt_seq LIMIT ?3`,
      )
      .bind(round.roundId, after?.receipt_seq ?? -1, limit)
      .all<EntryRow>();
    return results;
  }
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM entries WHERE round_id = ?1 AND mode = 'stakes'
         AND (block_number > ?2 OR (block_number = ?2 AND log_index > ?3))
       ORDER BY block_number, log_index LIMIT ?4`,
    )
    .bind(round.roundId, after?.block_number ?? -1, after?.log_index ?? -1, limit)
    .all<EntryRow>();
  return results;
}

/**
 * Writes the decrypt chunks: every entry of the mode in seq order, `chunkSize` per chunk.
 * Free: checks that the anchored root is the tree over the first `entryCount` entries (all of them
 * when the count isn't mirrored) and marks the rest `not_anchored`; a root that matches no prefix
 * throws IntegrityError. The files are a deterministic function of D1, so a retry rewrites them
 * with the same bytes.
 */
export async function prepareChunks(
  env: Pick<Env, 'DB' | 'BUCKET'>,
  round: SettlementRound,
  anchored: Extract<AnchoredCommitment, { state: 'anchored' }> | null,
  chunkSize: number = DECRYPT_CHUNK_SIZE,
): Promise<PreparedChunks> {
  const roundRef = roundRefHex(round);
  const free = round.mode === 'free' ? round.config.free : undefined;
  const fixedStake = round.mode === 'stakes' ? round.config.stakes?.stake : undefined;
  const leaves: { userIdHash: Hex; stake: bigint; commitment: Hex; seq: number }[] = [];
  const keys: string[] = [];
  let entryCount = 0;
  let last: EntryRow | null = null;
  for (;;) {
    const page = await entryPage(env.DB, round, last, chunkSize);
    if (page.length === 0) break;
    last = page[page.length - 1] ?? null;
    const entries = page.map((e, k): InputEntry => {
      const seq = entryCount + k;
      const stake = BigInt(e.stake);
      const commitment = e.commitment.toLowerCase() as Hex;
      let account: string;
      let preVoid: VoidReason | null = null;
      if (free) {
        if (e.user_id === null || e.receipt_seq !== seq) {
          throw new IntegrityError(`free entries are not contiguous by seq at ${seq}`);
        }
        account = receiptUserIdHash(round.roundId, e.user_id);
        const inAnchoredSet = anchored?.entryCount == null || seq < anchored.entryCount;
        if (inAnchoredSet) {
          leaves.push({ userIdHash: account as Hex, stake, commitment, seq });
        }
        if (!inAnchoredSet) preVoid = 'not_anchored';
        else if (stake < BigInt(free.stakeMin) || stake > BigInt(free.stakeMax)) {
          preVoid = 'stake_out_of_range';
        }
      } else {
        if (e.wallet === null) throw new IntegrityError(`stakes entry ${e.id} has no wallet`);
        if (fixedStake !== undefined && stake !== BigInt(fixedStake)) {
          throw new IntegrityError(`stakes entry ${e.id} stake differs from the round stake`);
        }
        account = e.wallet.toLowerCase();
      }
      if (preVoid === null && e.ciphertext === null) {
        throw new IntegrityError(`entry ${e.id} has no ciphertext`);
      }
      return {
        seq,
        entryId: e.id,
        account,
        stake: stake.toString(),
        commitment,
        ciphertext: e.ciphertext ? toBase64Url(new Uint8Array(e.ciphertext)) : null,
        preVoid,
      };
    });
    const index = keys.length;
    const input: DecryptInput = {
      roundId: round.roundId,
      mode: round.mode,
      index,
      beaconRound: round.beaconRound,
      roundRef,
      entries,
    };
    const key = decryptInputKey(round.roundId, round.mode, index);
    await env.BUCKET.put(key, JSON.stringify(input), {
      httpMetadata: { contentType: 'application/json' },
    });
    keys.push(key);
    entryCount += page.length;
    if (page.length < chunkSize) break;
  }
  if (free) checkAnchoredRoot(round, anchored, leaves, entryCount);
  return { keys, entryCount };
}

function checkAnchoredRoot(
  round: SettlementRound,
  anchored: Extract<AnchoredCommitment, { state: 'anchored' }> | null,
  leaves: { userIdHash: Hex; stake: bigint; commitment: Hex; seq: number }[],
  entryCount: number,
): void {
  if (anchored === null) {
    if (entryCount > 0)
      throw new IntegrityError('free entries exist but no commitment is anchored');
    return;
  }
  if (anchored.entryCount !== null && leaves.length !== anchored.entryCount) {
    throw new IntegrityError(
      `the anchored commitment has ${anchored.entryCount} leaves but D1 has ${leaves.length}`,
    );
  }
  if (leaves.length === 0) throw new IntegrityError('an anchored commitment over no entries');
  const roundBytes = ulidToBytes(round.roundId);
  const root = freeCommitmentTree(
    leaves.map((l) => ({ roundId: roundBytes, mode: MODE_CODES.free, ...l })),
  ).root;
  if (root.toLowerCase() !== anchored.root) {
    throw new IntegrityError(
      `the anchored root ${anchored.root} is not the tree over D1's entries`,
    );
  }
}
