// GET /rounds/:id/me (spec "API"): the caller's entry in each mode, its receipt and inclusion proof,
// the result, the payouts with their claim proofs, and the caller's share cards for the round.
//
// Reveal gating: an entry's option, validity and VOID reason, its result and any payout that depends
// on the outcome are read only once the mode's `revealed_at` is set (Stakes settlement writes the
// entries' outcomes before `propose`). Refunds that need no reveal (Free rules 4, 7, 8; Stakes 1 and
// 4) are shown as refunds, with nothing per option.
//
// The Free receipt is re-signed from the stored fields with the receipt key (EIP-712 signatures are
// deterministic, so it is the receipt the entry got while the key is unchanged); without a key it is
// null. Stakes payouts and proofs come from the bundle (src/read/proofs.ts), like GET /claims.
import type {
  EntryResult,
  Mode,
  ModeStatus,
  MyModeEntry,
  MyPayout,
  RoundMeResponse,
} from '@flocked/shared';
import type { Hex } from 'viem';
import { receiptSigner } from '../crypto/receipt.js';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { freeInclusionProof, stakesPayoutIndex } from './proofs.js';

interface Row {
  mode: Mode;
  status: ModeStatus;
  revealed_at: number | null;
  claims_open_at: number | null;
  commitment_root: Hex | null;
  entry_id: string;
  stake: number;
  commitment: Hex;
  created_at: number;
  wallet: string | null;
  tx_hash: Hex | null;
  block_number: number | null;
  log_index: number | null;
  receipt_seq: number | null;
  option_index: 0 | 1 | null;
  valid: number | null;
  void_reason: string | null;
  outcome: string | null;
  winners_json: string | null;
  bundle_hash: Hex | null;
}

interface PayoutRow {
  mode: Mode;
  wallet: string | null;
  kind: MyPayout['kind'];
  amount: number;
  claimed_at: number | null;
  claim_tx: Hex | null;
}

const REFUNDED: ReadonlySet<ModeStatus> = new Set(['refund_proposed', 'refunded', 'voided']);

function resultOf(r: Row): EntryResult | null {
  const revealed = r.revealed_at !== null;
  if (revealed && r.valid === 0) return 'void';
  if (REFUNDED.has(r.status)) return 'refund';
  if (!revealed || r.outcome === null) return null;
  if (r.outcome !== 'settled') return 'refund';
  const winner = r.winners_json ? (JSON.parse(r.winners_json) as { winner?: 0 | 1 | null }) : null;
  return r.option_index === winner?.winner ? 'win' : 'loss';
}

async function freeReceipt(
  env: Env,
  roundId: string,
  userId: string,
  r: Row,
  round: { closesAt: number; beaconRound: number },
): Promise<MyModeEntry['receipt']> {
  if (r.receipt_seq === null) return null;
  const signer = receiptSigner(env);
  if (signer instanceof Error) return null;
  return signer.sign({
    roundId,
    userId,
    stake: BigInt(r.stake),
    commitment: r.commitment,
    seq: r.receipt_seq,
    closesAtSec: Math.floor(round.closesAt / 1000),
    beaconRound: round.beaconRound,
  });
}

/** The caller's Stakes payout: from the bundle once revealed, or the refund. */
async function stakesPayouts(
  env: Env,
  roundId: string,
  r: Row,
  claimed: PayoutRow[],
): Promise<MyPayout[]> {
  const wallet = r.wallet?.toLowerCase() ?? null;
  if (!wallet) return [];
  const mark = (kind: MyPayout['kind']) => claimed.find((p) => p.kind === kind);
  if (REFUNDED.has(r.status)) {
    const p = mark('refund');
    return [
      {
        kind: 'refund',
        amount: String(r.stake),
        wallet,
        proof: null,
        claimedAt: p?.claimed_at ?? null,
        claimTx: p?.claim_tx ?? null,
      },
    ];
  }
  if (r.revealed_at === null || r.bundle_hash === null || r.outcome !== 'settled') return [];
  try {
    const index = await stakesPayoutIndex(env, roundId, r.bundle_hash);
    const p = index.byWallet.get(wallet);
    if (!p) return [];
    const m = mark(p.kind);
    return [
      {
        kind: p.kind,
        amount: p.amount.toString(),
        wallet,
        proof: p.proof,
        claimedAt: m?.claimed_at ?? null,
        claimTx: m?.claim_tx ?? null,
      },
    ];
  } catch (err) {
    log.error('me_bundle_unusable', { roundId, error: String(err) });
    return [];
  }
}

/** GET /rounds/:id/me's body; the caller has passed the round's access gate. */
export async function readRoundMe(
  env: Env,
  roundId: string,
  userId: string,
): Promise<RoundMeResponse> {
  const db = env.DB;
  const round = await db
    .prepare('SELECT closes_at, beacon_round FROM rounds WHERE id = ?1')
    .bind(roundId)
    .first<{ closes_at: number; beacon_round: number }>();
  const out: RoundMeResponse = { roundId, modes: {}, cards: [] };
  if (!round) return out;
  const [{ results: rows }, { results: payouts }, { results: cards }] = await Promise.all([
    db
      .prepare(
        `SELECT m.mode, m.status, m.revealed_at, m.claims_open_at, m.commitment_root,
                e.id AS entry_id, e.stake, e.commitment, e.created_at, e.wallet, e.tx_hash,
                e.block_number, e.log_index, e.receipt_seq, e.option_index, e.valid, e.void_reason,
                s.outcome, s.winners_json, s.bundle_hash
         FROM entries e JOIN round_modes m ON m.round_id = e.round_id AND m.mode = e.mode
         LEFT JOIN settlements s ON s.round_id = e.round_id AND s.mode = e.mode
           AND s.superseded_at IS NULL AND m.revealed_at IS NOT NULL
         WHERE e.round_id = ?1 AND e.user_id = ?2`,
      )
      .bind(roundId, userId)
      .all<Row>(),
    db
      .prepare(
        `SELECT mode, wallet, kind, amount, claimed_at, claim_tx FROM payouts
         WHERE round_id = ?1 AND user_id = ?2`,
      )
      .bind(roundId, userId)
      .all<PayoutRow>(),
    db
      .prepare(
        'SELECT kind, mode, share_id FROM share_cards WHERE round_id = ?1 AND user_id = ?2 ORDER BY created_at',
      )
      .bind(roundId, userId)
      .all<{ kind: 'result' | 'teaser'; mode: Mode; share_id: string }>(),
  ]);
  for (const r of rows) {
    const revealed = r.revealed_at !== null;
    let myPayouts: MyPayout[];
    if (r.mode === 'free') {
      // A win or rebate says which side won: only after the reveal. Refunds need none.
      myPayouts = payouts
        .filter((p) => p.mode === 'free' && (revealed || REFUNDED.has(r.status)))
        .map((p) => ({
          kind: p.kind,
          amount: String(p.amount),
          wallet: null,
          proof: null,
          claimedAt: p.claimed_at,
          claimTx: p.claim_tx,
        }));
    } else {
      myPayouts = await stakesPayouts(
        env,
        roundId,
        r,
        payouts.filter((p) => p.mode === 'stakes'),
      );
    }
    const entry: MyModeEntry = {
      modeStatus: r.status,
      entry: {
        id: r.entry_id,
        stake: String(r.stake),
        commitment: r.commitment,
        createdAt: r.created_at,
        wallet: r.mode === 'stakes' ? (r.wallet?.toLowerCase() ?? null) : null,
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        logIndex: r.log_index,
        optionIndex: revealed ? r.option_index : null,
        valid: revealed && r.valid !== null ? r.valid === 1 : null,
        voidReason: revealed ? (r.void_reason as MyModeEntry['entry']['voidReason']) : null,
      },
      receipt:
        r.mode === 'free'
          ? await freeReceipt(env, roundId, userId, r, {
              closesAt: round.closes_at,
              beaconRound: round.beacon_round,
            })
          : null,
      inclusionProof:
        r.mode === 'free' && r.commitment_root !== null && r.receipt_seq !== null
          ? await freeInclusionProof(db, roundId, r.commitment_root, r.receipt_seq)
          : null,
      result: resultOf(r),
      payouts: myPayouts,
      claimsOpenAt: r.mode === 'stakes' ? r.claims_open_at : null,
    };
    out.modes[r.mode] = entry;
  }
  out.cards = cards.map((c) => ({ kind: c.kind, mode: c.mode, shareId: c.share_id }));
  return out;
}
