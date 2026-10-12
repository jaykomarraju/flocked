// Merkle proofs for reads.
//
// Stakes claim proofs come from the public bundle only (spec "API": GET /claims?wallet= "from public
// bundle data"; docs/bundle-format.md "Verifying a bundle", steps 1, 4 and 5): the manifest and its
// chunks are read from R2, every hash is checked, `settle` is re-run over the chunks' entries with the
// config's parameters, and the payout tree is rebuilt. Its root must equal the manifest's
// `payoutRoot`, which must equal the record's (the root proposed onchain). Nothing user-specific in
// D1 is involved, so a wallet with no account gets the same proof.
//
// A proof is served only for a proposal that is live onchain (liveStakesPayoutIndex, W6-F1 R8 and
// R9): the mode is `settle_proposed` or `settled` (a reorg that removes `OutcomeProposed` sends it
// back to `revealing`, while `revealed_at` stays set), the current record's bundle is the one the
// chain recorded (`round_modes.bundle_hash`, written by the `OutcomeProposed` handler), and the
// rebuilt root is the record's `payout_root` as well as the manifest's.
//
// Free inclusion proofs (GET /rounds/:id/me) are over the commitment tree of the round's committed
// entries, which must hash to the anchored `commitment_root`.
//
// Both trees are cached per isolate (a small LRU keyed by the bundle hash or the anchored root), since
// one claims page or one round's players ask for the same tree many times.
import {
  freeCommitmentTree,
  settle,
  stakesPayoutTree,
  type EntryInput,
  type PayoutKind as SettlePayoutKind,
  type StakesLeafKind,
} from '@flocked/settle';
import { LockedConfigSchema, MODE_CODES, ulidToBytes } from '@flocked/shared';
import { keccak256, type Hex } from 'viem';
import type { Env } from '../env.js';
import { receiptUserIdHash } from '../crypto/receipt.js';
import { manifestKey } from '../settlement/keys.js';
import type { BundleChunk, Manifest } from '../settlement/types.js';

/** Payout kinds a Stakes payout tree holds (`refund` is claimed without a proof). */
export type StakesClaimKind = 'win' | 'rebate' | 'void_refund';

const LEAF_KIND: Record<StakesClaimKind, StakesLeafKind> = { win: 0, rebate: 1, void_refund: 2 };

export interface StakesPayout {
  kind: StakesClaimKind;
  amount: bigint;
  proof: Hex[];
}

/** A settled Stakes bundle's payouts by lowercase wallet. */
export interface StakesPayoutIndex {
  bundleHash: Hex;
  chainRoundId: string;
  payoutRoot: Hex;
  byWallet: Map<string, StakesPayout>;
}

/** Why a bundle could not back a proof (logged; the item is left out). */
export class BundleError extends Error {
  override name = 'BundleError';
}

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

const stakesCache = new Lru<StakesPayoutIndex>(8);
const freeCache = new Lru<{ proof: (seq: number) => Hex[] }>(8);

async function readObject(bucket: R2Bucket, key: string): Promise<Uint8Array> {
  const obj = await bucket.get(key);
  if (!obj) throw new BundleError(`missing bundle object ${key}`);
  return new Uint8Array(await obj.arrayBuffer());
}

const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

/**
 * The payouts of a settled Stakes bundle whose manifest hashes to `bundleHash` (the current
 * settlement record's), rebuilt from the bundle alone. Throws BundleError when the bundle is missing,
 * doesn't match its hashes, or doesn't reproduce its payout root.
 */
export async function stakesPayoutIndex(
  env: Pick<Env, 'BUCKET'>,
  roundId: string,
  bundleHash: Hex,
): Promise<StakesPayoutIndex> {
  const cached = stakesCache.get(bundleHash);
  if (cached) return cached;
  const manifestBytes = await readObject(env.BUCKET, manifestKey(roundId, 'stakes'));
  if (keccak256(manifestBytes) !== bundleHash) {
    throw new BundleError(`the stakes manifest of ${roundId} is not bundle ${bundleHash}`);
  }
  const manifest = decode(manifestBytes) as Manifest;
  if (manifest.record.outcome !== 'settled' || !manifest.payoutRoot || !manifest.chainRoundId) {
    throw new BundleError(`the stakes bundle of ${roundId} has no payout tree`);
  }
  const inputs: EntryInput[] = [];
  for (const ref of manifest.chunks) {
    const bytes = await readObject(env.BUCKET, ref.key);
    if (keccak256(bytes) !== ref.hash) {
      throw new BundleError(`chunk ${ref.index} of ${roundId} does not match its hash`);
    }
    for (const e of (decode(bytes) as BundleChunk).entries) {
      inputs.push({
        account: e.account,
        stake: BigInt(e.stake),
        option: e.option,
        voidReason: e.voidReason,
      });
    }
  }
  const s = LockedConfigSchema.parse(manifest.config).stakes;
  if (!s) throw new BundleError(`the stakes bundle of ${roundId} has no stakes config`);
  const { record, payouts } = settle(inputs, {
    feeBps: s.feeBps,
    creatorBps: s.creatorBps,
    capMultiple: s.capMultiple,
    minEntrants: s.minEntrants,
  });
  if (record.outcome !== 'settled') {
    throw new BundleError(`the stakes bundle of ${roundId} does not settle`);
  }
  const leaves = payouts.map((p) => ({ account: p.account as Hex, kind: leafKind(p.kind) }));
  const tree = stakesPayoutTree(BigInt(manifest.chainRoundId), leaves);
  if (tree.root !== manifest.payoutRoot) {
    throw new BundleError(`the stakes bundle of ${roundId} does not reproduce its payout root`);
  }
  const byWallet = new Map<string, StakesPayout>();
  for (const p of payouts) {
    const kind = p.kind as StakesClaimKind;
    byWallet.set(p.account.toLowerCase(), {
      kind,
      amount: p.amount,
      proof: tree.proof(p.account as Hex, LEAF_KIND[kind]),
    });
  }
  const index: StakesPayoutIndex = {
    bundleHash,
    chainRoundId: manifest.chainRoundId,
    payoutRoot: tree.root,
    byWallet,
  };
  stakesCache.set(bundleHash, index);
  return index;
}

/** What D1 holds about a Stakes mode's proposal, for a proof. */
export interface StakesProposalState {
  status: string;
  revealedAt: number | null;
  /** `round_modes.bundle_hash`: the bundle hash the `OutcomeProposed` handler took from the chain. */
  chainBundleHash: string | null;
  /** The current (not superseded) settlement record's bundle hash and payout root. */
  bundleHash: string | null;
  payoutRoot: string | null;
}

/** Stakes statuses with a live settlement proposal onchain or a final settlement. */
const PROPOSED: ReadonlySet<string> = new Set(['settle_proposed', 'settled']);

/**
 * The payouts of a Stakes mode whose settlement proposal is live onchain (see the header): null
 * when the mode is not proposed or settled, not revealed, or has no record matching the chain's
 * bundle hash. Throws BundleError when the bundle can't back a proof, or rebuilds another root than
 * the record's.
 */
export async function liveStakesPayoutIndex(
  env: Pick<Env, 'BUCKET'>,
  roundId: string,
  state: StakesProposalState,
): Promise<StakesPayoutIndex | null> {
  if (!PROPOSED.has(state.status) || state.revealedAt === null) return null;
  const { bundleHash, chainBundleHash, payoutRoot } = state;
  if (bundleHash === null || chainBundleHash === null || payoutRoot === null) return null;
  if (bundleHash.toLowerCase() !== chainBundleHash.toLowerCase()) {
    throw new BundleError(
      `the stakes record of ${roundId} is bundle ${bundleHash}, the chain's ${chainBundleHash}`,
    );
  }
  const index = await stakesPayoutIndex(env, roundId, bundleHash.toLowerCase() as Hex);
  if (index.payoutRoot.toLowerCase() !== payoutRoot.toLowerCase()) {
    throw new BundleError(`the stakes bundle of ${roundId} does not reproduce its recorded root`);
  }
  return index;
}

function leafKind(kind: SettlePayoutKind): StakesLeafKind {
  if (kind === 'win' || kind === 'rebate' || kind === 'void_refund') return LEAF_KIND[kind];
  throw new BundleError(`no Stakes leaf kind for ${kind}`);
}

/**
 * The proof of a Free receipt leaf (`seq`) in the commitment root `root`, from the round's committed
 * entries in D1; null when they don't hash to `root` (W5-Z: settlement alerts on that case).
 */
export async function freeInclusionProof(
  db: D1Database,
  roundId: string,
  root: Hex,
  seq: number,
): Promise<Hex[] | null> {
  const key = `${roundId}:${root}`;
  let tree = freeCache.get(key);
  if (!tree) {
    const { results } = await db
      .prepare(
        `SELECT user_id, stake, commitment, receipt_seq FROM entries
         WHERE round_id = ?1 AND mode = 'free' AND receipt_seq IS NOT NULL ORDER BY receipt_seq`,
      )
      .bind(roundId)
      .all<{ user_id: string; stake: number; commitment: Hex; receipt_seq: number }>();
    if (results.length === 0) return null;
    const roundBytes = ulidToBytes(roundId);
    const built = freeCommitmentTree(
      results.map((e) => ({
        roundId: roundBytes,
        mode: MODE_CODES.free,
        userIdHash: receiptUserIdHash(roundId, e.user_id),
        stake: BigInt(e.stake),
        commitment: e.commitment,
        seq: e.receipt_seq,
      })),
    );
    if (built.root !== root) return null;
    tree = built;
    freeCache.set(key, tree);
  }
  try {
    return tree.proof(seq);
  } catch {
    return null;
  }
}
