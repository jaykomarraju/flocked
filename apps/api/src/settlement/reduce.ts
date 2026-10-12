// The reduce step (spec "Architecture": Settlement coordinator): once every decrypt chunk is done,
// read the chunks back in seq order, check each against the partial tally its consumer reported,
// run `settle`, build the payout tree, and write the bundle (chunks first, the manifest last, all
// write-once). Payouts are not written anywhere here: the apply hook writes them (W5-D, W6-A).
import {
  FORMULA_VERSION,
  checkInvariant,
  freePayoutTree,
  settle,
  stakesPayoutTree,
  type EntryInput,
  type SettleParams,
  type StakesLeafKind,
  type VoidReason,
} from '@flocked/settle';
import { ulidToBytes } from '@flocked/shared';
import type { Hex } from 'viem';
import type { DecryptChunkResult } from '../do/types.js';
import type { Env } from '../env.js';
import { buildBundleChunk, buildManifest, recordJson, writeOnce } from './bundle.js';
import type { DecryptOutput } from './decrypt.js';
import { BUNDLE_CHUNK_SIZE, decryptInputKey, decryptOutputKey, manifestKey } from './keys.js';
import { IntegrityError, type DecryptInput, type SettlementRound } from './prepare.js';
import {
  BUNDLE_FORMAT,
  type BundleEntry,
  type ChunkRef,
  type ClassifiedEntry,
  type Manifest,
  type TallyResult,
} from './types.js';

export interface ReduceInputs {
  round: SettlementRound;
  chainHash: string;
  signature: string;
  /** Free with entries: the anchored commitment. */
  anchored: { root: Hex; txHash: Hex; entryCount: number } | null;
  /** Stakes: the close block (src/chain/safe-head.ts). */
  closeBlock?: { number: number; hash: Hex } | null;
  /** Decrypt chunk count; chunk i's files are at decryptInputKey / decryptOutputKey(i). */
  chunks: number;
  /** The consumers' partial tallies, by chunk index. */
  partials: DecryptChunkResult[];
  /** Entries per bundle chunk (BUNDLE_CHUNK_SIZE; recorded in the manifest). */
  bundleChunkSize?: number;
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`settlement file ${key} is missing`);
  return obj.json<T>();
}

/** entryId → userId for the mode's entries. */
async function userIds(
  db: D1Database,
  round: SettlementRound,
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  let after = '';
  for (;;) {
    const { results } = await db
      .prepare(
        'SELECT id, user_id FROM entries WHERE round_id = ?1 AND mode = ?2 AND id > ?3 ORDER BY id LIMIT 5000',
      )
      .bind(round.roundId, round.mode, after)
      .all<{ id: string; user_id: string | null }>();
    for (const r of results) map.set(r.id, r.user_id);
    const last = results[results.length - 1];
    if (!last || results.length < 5000) return map;
    after = last.id;
  }
}

/** Throws IntegrityError unless the consumer's partial tally is what its output says. */
function reconcileChunk(
  index: number,
  input: DecryptInput,
  output: DecryptOutput,
  partial: DecryptChunkResult | undefined,
): void {
  if (!partial) throw new IntegrityError(`chunk ${index} has no result`);
  const n = [0, 0];
  const w = [0n, 0n];
  const voids: Partial<Record<VoidReason, number>> = {};
  output.entries.forEach((o, k) => {
    const e = input.entries[k];
    if (!e || e.seq !== o.seq || e.entryId !== o.entryId) {
      throw new IntegrityError(`chunk ${index}: output entry ${k} does not match its input`);
    }
    if (o.option === null) {
      const r = o.voidReason ?? 'decrypt_failed';
      voids[r] = (voids[r] ?? 0) + 1;
    } else {
      n[o.option] = (n[o.option] ?? 0) + 1;
      w[o.option] = (w[o.option] ?? 0n) + BigInt(e.stake);
    }
  });
  const ok =
    output.entries.length === input.entries.length &&
    partial.entries === output.entries.length &&
    partial.valid === (n[0] ?? 0) + (n[1] ?? 0) &&
    partial.tally.every(
      (t, o) => t.headcount === (n[o] ?? 0) && t.total === (w[o] ?? 0n).toString(),
    ) &&
    JSON.stringify(Object.entries(partial.voids).sort()) ===
      JSON.stringify(Object.entries(voids).sort());
  if (!ok) throw new IntegrityError(`chunk ${index}: the reported tally does not match its output`);
}

export function settleParams(round: SettlementRound): SettleParams {
  if (round.mode === 'free') {
    const f = round.config.free;
    if (!f) throw new Error('no free config');
    return {
      feeBps: f.feeBps,
      creatorBps: f.creatorBps,
      capMultiple: f.capMultiple,
      minEntrants: f.minEntrants,
      // House questions and rooms pay no award (awardRecipient null).
      creatorAwardBps: f.awardRecipient === null ? 0 : f.creatorAwardBps,
    };
  }
  const s = round.config.stakes;
  if (!s) throw new Error('no stakes config');
  return {
    feeBps: s.feeBps,
    creatorBps: s.creatorBps,
    capMultiple: s.capMultiple,
    minEntrants: s.minEntrants,
  };
}

const STAKES_KIND: Record<string, StakesLeafKind> = { win: 0, rebate: 1, void_refund: 2 };

/** Runs reduce. Deterministic: the same inputs give the same TallyResult and bundle bytes. */
export async function reduce(
  env: Pick<Env, 'DB' | 'BUCKET'>,
  i: ReduceInputs,
): Promise<TallyResult> {
  const { round } = i;
  const { roundId, mode } = round;
  const bundleChunkSize = i.bundleChunkSize ?? BUNDLE_CHUNK_SIZE;
  const users = await userIds(env.DB, round);
  const entries: ClassifiedEntry[] = [];
  const chunks: ChunkRef[] = [];
  let pending: BundleEntry[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const { bytes, ref } = buildBundleChunk(roundId, mode, chunks.length, pending);
    await writeOnce(env.BUCKET, ref.key, bytes);
    chunks.push(ref);
    pending = [];
  };
  for (let index = 0; index < i.chunks; index++) {
    const input = await readJson<DecryptInput>(env.BUCKET, decryptInputKey(roundId, mode, index));
    const output = await readJson<DecryptOutput>(
      env.BUCKET,
      decryptOutputKey(roundId, mode, index),
    );
    reconcileChunk(index, input, output, i.partials[index]);
    for (const [k, o] of output.entries.entries()) {
      const e = input.entries[k];
      if (!e) throw new IntegrityError('unreachable: reconciled');
      if (!users.has(e.entryId)) throw new IntegrityError(`entry ${e.entryId} is not in D1`);
      entries.push({
        entryId: e.entryId,
        userId: users.get(e.entryId) ?? null,
        account: e.account,
        stake: BigInt(e.stake),
        seq: e.seq,
        option: o.option,
        nonce: o.nonce,
        voidReason: o.voidReason,
      });
      pending.push({
        seq: e.seq,
        account: e.account,
        stake: e.stake,
        option: o.option,
        nonce: o.nonce,
        valid: o.option !== null,
        voidReason: o.voidReason,
        ...(mode === 'free' ? { commitment: e.commitment, ciphertext: e.ciphertext } : {}),
      });
      // Bundle chunk i is exactly entries [i·size, (i + 1)·size) in seq order.
      if (pending.length === bundleChunkSize) await flush();
    }
  }
  await flush();
  if (entries.length !== users.size) {
    throw new IntegrityError(`D1 has ${users.size} entries but the chunks hold ${entries.length}`);
  }

  const inputs: EntryInput[] = entries.map((e) => ({
    account: e.account,
    stake: e.stake,
    option: e.option,
    voidReason: e.voidReason,
  }));
  const { record, payouts } = settle(inputs, settleParams(round));
  checkInvariant(record, payouts);

  let payoutRoot: Hex | null = null;
  if (mode === 'free' && payouts.length > 0) {
    payoutRoot = freePayoutTree(
      ulidToBytes(roundId),
      payouts.map((p) => ({ userIdHash: p.account as Hex, amount: p.amount })),
    ).root;
  } else if (mode === 'stakes' && record.outcome === 'settled' && payouts.length > 0) {
    if (round.chainRoundId === null) throw new Error('stakes mode has no chain_round_id');
    payoutRoot = stakesPayoutTree(
      BigInt(round.chainRoundId),
      payouts.map((p) => {
        const kind = STAKES_KIND[p.kind];
        if (kind === undefined) throw new IntegrityError(`no Stakes leaf kind for ${p.kind}`);
        return { account: p.account as Hex, kind };
      }),
    ).root;
  }

  const voids: Partial<Record<VoidReason, number>> = {};
  for (const e of entries) if (e.voidReason) voids[e.voidReason] = (voids[e.voidReason] ?? 0) + 1;
  const manifest: Manifest = {
    bundleFormat: BUNDLE_FORMAT,
    formulaVersion: FORMULA_VERSION,
    roundId,
    mode,
    kind: round.kind,
    roomId: round.roomId,
    closesAt: Math.floor(round.closesAt / 1000),
    beaconRound: round.beaconRound,
    config: round.configJson,
    drand: { chainHash: i.chainHash, signature: i.signature },
    commitment: i.anchored
      ? { root: i.anchored.root, anchorTx: i.anchored.txHash, entryCount: i.anchored.entryCount }
      : null,
    chainRoundId: round.chainRoundId,
    closeBlock:
      mode === 'stakes' && i.closeBlock
        ? { number: i.closeBlock.number, hash: i.closeBlock.hash }
        : null,
    record: recordJson(record),
    voids,
    payoutRoot,
    entryCount: entries.length,
    chunkSize: bundleChunkSize,
    chunks,
  };
  const { bytes, bundleHash } = buildManifest(manifest);
  await writeOnce(env.BUCKET, manifestKey(roundId, mode), bytes);
  return { record, payouts, entries, manifest, manifestBytes: bytes, bundleHash, chunks };
}
