// GET /claims (spec "API"; "Identity and personhood" › Merging accounts and Account deletion): the
// unclaimed Stakes payouts and refunds, with proofs and claim-open times.
//   - Signed in: the caller's entries and those of every account merged into the caller (merges can
//     chain, so the losing accounts are followed transitively). `userId` names the entry's account.
//   - `?wallet=`: the wallet's entries in daily rounds, from public data only (the bundle for the
//     payout and its proof, the mirrored `Entered` for refunds), no sign-in. `userId` is null. The
//     wallet's own room-round payouts and refunds come in `roomClaims` (O5, Oct 12; "Identity and
//     personhood" › Account deletion), so a deleted account can still claim them: the chain round
//     ID, kind, account, amount, proof and claim-open time only, with no round ID, question, room or
//     other members' data (Reveal gating keeps the rest members-only).
//
// A payout is listed from the proposal on (`settle_proposed`, with `claimsOpenAt` the end of the
// challenge window) until the indexer sees its claim (`payouts.claimed_at`, src/read/claimed.ts). The
// payout and proof come from the bundle (src/read/proofs.ts), never from D1's copy of the outcome, and
// only for a proposal live onchain (liveStakesPayoutIndex: revealed, proposed or settled, the chain's
// bundle hash, the recorded root). A loser of a round with no rebate has nothing to claim.
// Refunds (`refund_proposed`, `refunded`, `voided`) are the stake, claimed with `claimRefund` and no
// proof.
import type { ClaimItem, RoomClaimItem } from '@flocked/shared';
import type { Hex } from 'viem';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { liveStakesPayoutIndex } from './proofs.js';

/** How many merge hops `/claims` follows (merges are rate-limited to one inbound per 30 days). */
export const MAX_MERGE_DEPTH = 16;

interface ClaimRow {
  round_id: string;
  user_id: string | null;
  wallet: string;
  stake: number;
  status: string;
  chain_round_id: string | null;
  claims_open_at: number | null;
  final_at: number | null;
  revealed_at: number | null;
  /** round_modes.bundle_hash: what the `OutcomeProposed` handler recorded from the chain. */
  chain_bundle_hash: Hex | null;
  /** The current settlement record's. */
  bundle_hash: Hex | null;
  payout_root: Hex | null;
}

const COLUMNS = `
  e.round_id, e.user_id, e.wallet, e.stake, m.status, m.chain_round_id, m.claims_open_at,
  m.final_at, m.revealed_at, m.bundle_hash AS chain_bundle_hash,
  (SELECT s.bundle_hash FROM settlements s WHERE s.round_id = e.round_id AND s.mode = 'stakes'
     AND s.superseded_at IS NULL) AS bundle_hash,
  (SELECT s.payout_root FROM settlements s WHERE s.round_id = e.round_id AND s.mode = 'stakes'
     AND s.superseded_at IS NULL) AS payout_root`;

const UNCLAIMED = `
  e.mode = 'stakes'
  AND m.status IN ('settle_proposed', 'settled', 'refund_proposed', 'refunded', 'voided')
  AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.round_id = e.round_id AND p.mode = 'stakes'
                  AND p.wallet = e.wallet AND p.claimed_at IS NOT NULL)`;

const BY_ACCOUNTS = `
  WITH RECURSIVE acct(id, depth) AS (
    SELECT ?1, 0
    UNION
    SELECT u.id, a.depth + 1 FROM users u JOIN acct a ON u.merged_into = a.id
    WHERE u.status = 'merged' AND a.depth < ?2
  )
  SELECT DISTINCT ${COLUMNS}
  FROM entries e JOIN acct a ON e.user_id = a.id
  JOIN round_modes m ON m.round_id = e.round_id AND m.mode = 'stakes'
  WHERE ${UNCLAIMED}
  ORDER BY e.round_id DESC`;

/** A wallet's entries in rounds of kind ?2 (daily, or room for `roomClaims`). */
const BY_WALLET = `
  SELECT ${COLUMNS}
  FROM entries e JOIN rounds r ON r.id = e.round_id AND r.kind = ?2
  JOIN round_modes m ON m.round_id = e.round_id AND m.mode = 'stakes'
  WHERE e.wallet = ?1 AND ${UNCLAIMED}
  ORDER BY e.round_id DESC`;

async function itemOf(
  env: Pick<Env, 'BUCKET'>,
  row: ClaimRow,
  userId: string | null,
): Promise<ClaimItem | null> {
  const base = { roundId: row.round_id, account: row.wallet.toLowerCase(), userId };
  if (row.status === 'settle_proposed' || row.status === 'settled') {
    // The gate: a payout says which side won, so nothing before the reveal, and a proof only for
    // the proposal the chain holds.
    if (row.chain_round_id === null) return null;
    try {
      const index = await liveStakesPayoutIndex(env, row.round_id, {
        status: row.status,
        revealedAt: row.revealed_at,
        chainBundleHash: row.chain_bundle_hash,
        bundleHash: row.bundle_hash,
        payoutRoot: row.payout_root,
      });
      const p = index?.byWallet.get(base.account);
      if (!index || !p) return null;
      return {
        ...base,
        chainRoundId: index.chainRoundId,
        kind: p.kind,
        amount: p.amount.toString(),
        proof: p.proof,
        claimsOpenAt: row.claims_open_at,
      };
    } catch (err) {
      log.error('claims_bundle_unusable', { roundId: row.round_id, error: String(err) });
      return null;
    }
  }
  if (row.chain_round_id === null) return null;
  return {
    ...base,
    chainRoundId: row.chain_round_id,
    kind: 'refund',
    amount: String(row.stake),
    proof: null,
    claimsOpenAt: row.claims_open_at ?? row.final_at,
  };
}

async function itemsOf(
  env: Pick<Env, 'BUCKET'>,
  rows: ClaimRow[],
  byWallet: boolean,
): Promise<ClaimItem[]> {
  const items: ClaimItem[] = [];
  for (const row of rows) {
    const item = await itemOf(env, row, byWallet ? null : row.user_id);
    if (item) items.push(item);
  }
  return items;
}

/** The signed-in caller's claims, including every account merged into it. */
export async function claimsForUser(
  env: Pick<Env, 'DB' | 'BUCKET'>,
  userId: string,
): Promise<ClaimItem[]> {
  const { results } = await env.DB.prepare(BY_ACCOUNTS)
    .bind(userId, MAX_MERGE_DEPTH)
    .all<ClaimRow>();
  return itemsOf(env, results, false);
}

/** A wallet's claims in daily rounds, from public data only. */
export async function claimsForWallet(
  env: Pick<Env, 'DB' | 'BUCKET'>,
  wallet: string,
): Promise<ClaimItem[]> {
  const { results } = await env.DB.prepare(BY_WALLET)
    .bind(wallet.toLowerCase(), 'daily')
    .all<ClaimRow>();
  return itemsOf(env, results, true);
}

/**
 * A wallet's own claims in room rounds (O5): only what claiming needs, nothing that names the
 * round, its question, its room or another member.
 */
export async function roomClaimsForWallet(
  env: Pick<Env, 'DB' | 'BUCKET'>,
  wallet: string,
): Promise<RoomClaimItem[]> {
  const { results } = await env.DB.prepare(BY_WALLET)
    .bind(wallet.toLowerCase(), 'room')
    .all<ClaimRow>();
  return (await itemsOf(env, results, true)).map((i) => ({
    chainRoundId: i.chainRoundId,
    kind: i.kind,
    account: i.account,
    amount: i.amount,
    proof: i.proof,
    claimsOpenAt: i.claimsOpenAt,
  }));
}
