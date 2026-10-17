// Everything the verifier recomputes from the bundle alone (plus drand, and the Stakes ciphertexts
// the caller reads from `Entered` logs): chunk hashes and totals, every entry's VOID reason and pick,
// the settlement record, and both Merkle roots. Pure and browser-safe: no Node APIs, no chain reads.
import {
  FORMULA_VERSION,
  freeCommitmentTree,
  freePayoutTree,
  settle,
  stakesPayoutTree,
  type EntryInput,
  type Mode,
  type OptionIndex,
  type Payout,
  type PayoutTree,
  type SettleParams,
  type SettlementRecord,
  type StakesLeafKind,
  type VoidReason,
} from '@flocked/settle';
import { LockedConfigSchema, ulidToBytes, type LockedConfig } from '@flocked/shared';
import {
  classify,
  commitment as commitmentOf,
  fromBase64Url,
  roundRefFromChainId,
  roundRefFromUlid,
  verifyBeacon,
  type DrandChain,
} from '@flocked/tlock';
import { bytesToHex, keccak256, type Hex } from 'viem';
import {
  BUNDLE_FORMAT,
  ChunkSchema,
  ManifestSchema,
  chunkKey,
  manifestKey,
  parseCanonical,
  type BundleEntry,
  type Manifest,
  type RecordJson,
} from './bundle.js';
import type { Checks } from './checks.js';
import type { BundleSource } from './types.js';

export interface LoadedBundle {
  manifest: Manifest;
  manifestBytes: Uint8Array;
  /** keccak256(manifest bytes). */
  bundleHash: Hex;
  /** Every entry, in seq order. */
  entries: BundleEntry[];
  config: LockedConfig;
}

type Progress = (line: string) => void;

/**
 * Reads the manifest and every chunk, and checks what the bundle says about itself: the encoding,
 * chunk hashes, the chunk partition by seq, per-chunk totals and VOID counts, and each entry's fields.
 * Returns null when the bundle can't be read far enough to recompute anything.
 */
export async function loadBundle(
  source: BundleSource,
  roundId: string,
  mode: Mode,
  checks: Checks,
  progress: Progress = () => {},
): Promise<LoadedBundle | null> {
  let manifestBytes: Uint8Array | null;
  try {
    manifestBytes = await source(manifestKey(roundId, mode));
  } catch (e) {
    checks.error('manifest.fetch', `could not read the manifest: ${(e as Error).message}`);
    return null;
  }
  if (manifestBytes === null) {
    checks.error('manifest.fetch', 'no manifest is published for this round and mode');
    return null;
  }
  const bundleHash = keccak256(manifestBytes);
  const unsupported = unsupportedFormat(manifestBytes);
  if (unsupported) {
    checks.error('manifest.format', unsupported);
    return null;
  }
  const parsed = parseCanonical(manifestBytes, ManifestSchema);
  if (!parsed.ok) {
    checks.fail('manifest.format', `the manifest is malformed: ${parsed.error}`);
    return null;
  }
  checks.pass('manifest.format', `bundleFormat ${BUNDLE_FORMAT}, canonical JSON`);
  const manifest = parsed.value;
  if (
    !checks.equal(
      'manifest.round',
      'round and mode',
      `${roundId}/${mode}`,
      `${manifest.roundId}/${manifest.mode}`,
    )
  ) {
    return null;
  }
  const cfg = LockedConfigSchema.safeParse(manifest.config);
  if (!cfg.success || cfg.data[mode] === undefined) {
    checks.fail('manifest.config', `the locked config is not valid for ${mode}`);
    return null;
  }
  checks.pass('manifest.config', 'locked config parses');

  const wantChunks = Math.ceil(manifest.entryCount / manifest.chunkSize);
  if (
    !checks.equal(
      'manifest.chunks',
      'chunk count for entryCount and chunkSize',
      wantChunks,
      manifest.chunks.length,
    )
  ) {
    return null;
  }

  const entries: BundleEntry[] = [];
  const hashes = checks.many('chunk.hash', 'chunk hash is keccak256 of its bytes');
  const refs = checks.many('chunk.ref', 'chunk key, index, seq range and entry count');
  const totals = checks.many('chunk.totals', 'per-option totals and VOID count');
  let readable = true;
  for (const [i, ref] of manifest.chunks.entries()) {
    const key = chunkKey(roundId, mode, i);
    progress(`chunk ${i + 1}/${manifest.chunks.length}`);
    let bytes: Uint8Array | null;
    try {
      bytes = await source(key);
    } catch (e) {
      checks.error('chunk.fetch', `could not read ${key}: ${(e as Error).message}`);
      return null;
    }
    if (bytes === null) {
      checks.error('chunk.fetch', `${key} is missing`);
      return null;
    }
    const hash = keccak256(bytes);
    hashes.item(hash === ref.hash, () => `chunk ${i}: manifest ${ref.hash}, bytes ${hash}`);
    const chunk = parseCanonical(bytes, ChunkSchema);
    if (!chunk.ok) {
      checks.fail('chunk.format', `chunk ${i} is malformed: ${chunk.error}`);
      readable = false;
      continue;
    }
    const c = chunk.value;
    const first = i * manifest.chunkSize;
    const expectEntries = Math.min(manifest.chunkSize, manifest.entryCount - first);
    const seqsOk = c.entries.every((e, k) => e.seq === first + k);
    refs.item(
      ref.index === i &&
        ref.key === key &&
        c.bundleFormat === BUNDLE_FORMAT &&
        c.roundId === roundId &&
        c.mode === mode &&
        c.index === i &&
        c.entries.length === expectEntries &&
        ref.entries === expectEntries &&
        ref.firstSeq === first &&
        ref.lastSeq === first + expectEntries - 1 &&
        seqsOk,
      () =>
        `chunk ${i} (${ref.key}) does not hold seq ${first}..${first + expectEntries - 1} as listed`,
    );
    const t = tally(c.entries);
    totals.item(
      t.n[0] === ref.totals[0].n &&
        t.w[0] === ref.totals[0].w &&
        t.n[1] === ref.totals[1].n &&
        t.w[1] === ref.totals[1].w &&
        t.voids === ref.voids,
      () =>
        `chunk ${i}: manifest ${JSON.stringify(ref.totals)} voids ${ref.voids}, ` +
        `entries ${JSON.stringify([
          { n: t.n[0], w: t.w[0] },
          { n: t.n[1], w: t.w[1] },
        ])} voids ${t.voids}`,
    );
    entries.push(...c.entries);
  }
  hashes.done();
  refs.done();
  totals.done();
  if (!readable) return null;

  checkEntryFields(manifest, entries, checks);
  const voids: Partial<Record<VoidReason, number>> = {};
  for (const e of entries) if (e.voidReason) voids[e.voidReason] = (voids[e.voidReason] ?? 0) + 1;
  checks.equal(
    'manifest.voids',
    'VOID count per reason',
    sortedJson(voids),
    sortedJson(manifest.voids),
  );
  return { manifest, manifestBytes, bundleHash, entries, config: cfg.data };
}

/** A manifest this verifier can't read (a newer bundleFormat or formulaVersion): unverifiable, not a mismatch. */
function unsupportedFormat(bytes: Uint8Array): string | null {
  try {
    const m = JSON.parse(new TextDecoder().decode(bytes)) as {
      bundleFormat?: unknown;
      formulaVersion?: unknown;
    };
    if (typeof m.bundleFormat === 'number' && m.bundleFormat !== BUNDLE_FORMAT) {
      return `bundleFormat ${m.bundleFormat} is not supported (this verifier reads ${BUNDLE_FORMAT})`;
    }
    if (typeof m.formulaVersion === 'number' && m.formulaVersion !== FORMULA_VERSION) {
      return `formulaVersion ${m.formulaVersion} is not supported (this verifier runs ${FORMULA_VERSION})`;
    }
  } catch {
    // Malformed JSON is reported by the strict parse.
  }
  return null;
}

function sortedJson(o: Partial<Record<string, number>>): string {
  return JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function tally(entries: readonly BundleEntry[]) {
  const n = [0n, 0n];
  const w = [0n, 0n];
  let voids = 0;
  for (const e of entries) {
    if (e.option === null) voids += 1;
    else {
      n[e.option] = (n[e.option] ?? 0n) + 1n;
      w[e.option] = (w[e.option] ?? 0n) + BigInt(e.stake);
    }
  }
  return { n: [String(n[0]), String(n[1])], w: [String(w[0]), String(w[1])], voids };
}

/** Field rules from docs/bundle-format.md › Chunk and › Room minimum. */
function checkEntryFields(
  manifest: Manifest,
  entries: readonly BundleEntry[],
  checks: Checks,
): void {
  const free = manifest.mode === 'free';
  const room = manifest.kind === 'room';
  const agg = checks.many('entry.fields', 'entry fields are consistent');
  for (const e of entries) {
    const valid = e.option !== null;
    agg.item(
      e.valid === valid &&
        (e.voidReason === null) === valid &&
        (e.nonce === null) === !valid &&
        (free
          ? e.commitment !== undefined &&
            e.ciphertext !== undefined &&
            /^0x[0-9a-f]{64}$/.test(e.account)
          : e.commitment === undefined &&
            e.ciphertext === undefined &&
            /^0x[0-9a-f]{40}$/.test(e.account)) &&
        (room ? e.qualifies !== undefined : e.qualifies === undefined),
      () => `seq ${e.seq}`,
    );
  }
  agg.done();
  if (!room) return;
  // The API decides `qualifies` from account ages, which the bundle doesn't hold; a verifier checks
  // only that no VOID entry qualifies, that a Stakes entry qualifies exactly when valid, and that no
  // Free account (userIdHash: one per user per round) qualifies twice.
  const seen = new Set<string>();
  const q = checks.many('entry.qualifies', 'room qualification flags are possible');
  for (const e of entries) {
    const ok =
      (e.qualifies !== true || (e.option !== null && !seen.has(e.account))) &&
      (free || e.qualifies === (e.option !== null));
    if (e.qualifies === true) seen.add(e.account);
    q.item(ok, () => `seq ${e.seq}`);
  }
  q.done();
}

export interface RecomputedPick {
  option: OptionIndex | null;
  nonce: Hex | null;
  voidReason: VoidReason | null;
}

/**
 * Checks the drand signature for `beaconRound` against the pinned chain. classify refuses to run
 * without a verified signature, so a failure here ends the recompute.
 */
export function checkBeacon(b: LoadedBundle, chain: DrandChain, checks: Checks): boolean {
  const { drand, beaconRound } = b.manifest;
  if (!checks.equal('drand.chainHash', 'drand chain hash', chain.chainHash, drand.chainHash))
    return false;
  if (!verifyBeacon(chain, beaconRound, drand.signature)) {
    checks.fail(
      'drand.signature',
      `the signature for round ${beaconRound} does not verify against the chain's public key`,
    );
    return false;
  }
  checks.pass('drand.signature', `round ${beaconRound} signature verifies`);
  return true;
}

/**
 * Recomputes every entry's VOID reason, option and nonce (docs/bundle-format.md › VOID reasons and their
 * order) and compares them with the bundle. Free ciphertexts come from the chunks; Stakes ciphertexts
 * from `ciphertexts` (the `Entered` logs, by seq). Returns the recomputed picks, by seq.
 */
export async function recomputeEntries(
  b: LoadedBundle,
  chain: DrandChain,
  checks: Checks,
  ciphertexts: readonly (Uint8Array | null)[] | null,
  progress: Progress = () => {},
): Promise<RecomputedPick[]> {
  const { manifest } = b;
  const free = manifest.mode === 'free';
  const roundRef = free
    ? roundRefFromUlid(manifest.roundId)
    : roundRefFromChainId(BigInt(manifest.chainRoundId ?? '0'));
  const stakeMin = BigInt(b.config.free?.stakeMin ?? '0');
  const stakeMax = BigInt(b.config.free?.stakeMax ?? '0');
  const anchoredCount = manifest.commitment?.entryCount ?? 0;
  const commits = checks.many('entry.commitment', 'Free commitment is keccak256(ciphertext)');
  const reasons = checks.many('entry.voidReason', 'VOID reason recomputes');
  const picks = checks.many('entry.pick', 'decrypted option and nonce recompute');
  const out: RecomputedPick[] = [];
  for (const [k, e] of b.entries.entries()) {
    if (k % 500 === 0) progress(`decrypting ${k}/${b.entries.length}`);
    let ct: Uint8Array | null;
    if (free) {
      ct = e.ciphertext ? fromBase64Url(e.ciphertext) : null;
      if (ct) commits.item(commitmentOf(ct) === e.commitment, () => `seq ${e.seq}`);
    } else {
      ct = ciphertexts?.[k] ?? null;
    }
    let r: RecomputedPick;
    const preVoid: VoidReason | null = !free
      ? null
      : e.seq >= anchoredCount
        ? 'not_anchored'
        : BigInt(e.stake) < stakeMin || BigInt(e.stake) > stakeMax
          ? 'stake_out_of_range'
          : null;
    if (preVoid) r = { option: null, nonce: null, voidReason: preVoid };
    else if (ct === null) {
      // A ciphertext may be absent only for an entry voided before decryption.
      reasons.item(false, () => `seq ${e.seq}: no ciphertext to decrypt`);
      out.push({ option: null, nonce: null, voidReason: null });
      continue;
    } else {
      const c = await classify({
        ct,
        chain,
        beaconRound: manifest.beaconRound,
        signature: manifest.drand.signature,
        roundRef,
      });
      r = c.valid
        ? { option: c.optionIndex, nonce: bytesToHex(c.nonce), voidReason: null }
        : { option: null, nonce: null, voidReason: c.voidReason };
    }
    reasons.item(
      r.voidReason === e.voidReason,
      () => `seq ${e.seq}: bundle ${e.voidReason}, recomputed ${r.voidReason}`,
    );
    picks.item(
      r.option === e.option && r.nonce === e.nonce,
      () => `seq ${e.seq}: bundle ${e.option}/${e.nonce}, recomputed ${r.option}/${r.nonce}`,
    );
    out.push(r);
  }
  if (free) commits.done();
  reasons.done();
  picks.done();
  return out;
}

/** Settle's params from the locked config (docs/bundle-format.md › Verifying a bundle, step 4). */
export function settleParamsOf(b: LoadedBundle): SettleParams {
  const room = b.manifest.kind === 'room' ? { countQualifyingOnly: true } : {};
  if (b.manifest.mode === 'free') {
    const f = b.config.free;
    if (!f) throw new Error('no free config');
    return {
      feeBps: f.feeBps,
      creatorBps: f.creatorBps,
      capMultiple: f.capMultiple,
      minEntrants: f.minEntrants,
      creatorAwardBps: f.awardRecipient === null ? 0 : f.creatorAwardBps,
      ...room,
    };
  }
  const s = b.config.stakes;
  if (!s) throw new Error('no stakes config');
  return {
    feeBps: s.feeBps,
    creatorBps: s.creatorBps,
    capMultiple: s.capMultiple,
    minEntrants: s.minEntrants,
    ...room,
  };
}

export function recordJson(r: SettlementRecord): RecordJson {
  return {
    outcome: r.outcome,
    refundReason: r.refundReason,
    n: [r.n[0].toString(), r.n[1].toString()],
    w: [r.w[0].toString(), r.w[1].toString()],
    winner: r.winner,
    lossPool: r.lossPool.toString(),
    fee: r.fee.toString(),
    creatorFee: r.creatorFee.toString(),
    distributable: r.distributable.toString(),
    rebatePool: r.rebatePool.toString(),
    dust: r.dust.toString(),
    voidCount: r.voidCount.toString(),
    voidStake: r.voidStake.toString(),
    total: r.total.toString(),
    creatorAward: r.creatorAward.toString(),
  };
}

const STAKES_KIND: Partial<Record<Payout['kind'], StakesLeafKind>> = {
  win: 0,
  rebate: 1,
  void_refund: 2,
};

export interface Recomputed {
  record: SettlementRecord;
  payouts: Payout[];
  /** Free: the payout tree keyed by userIdHash. Stakes: keyed by (account, kind). null without leaves. */
  freeTree: PayoutTree<[userIdHash: Hex]> | null;
  stakesTree: PayoutTree<[account: Hex, kind: StakesLeafKind]> | null;
  payoutRoot: Hex | null;
}

/**
 * Re-runs `settle` over the recomputed picks (with the bundle's `qualifies` flags in a room round) and
 * rebuilds the payout tree; compares the record and `payoutRoot` with the manifest.
 */
export function recomputeSettlement(
  b: LoadedBundle,
  picks: readonly RecomputedPick[],
  checks: Checks,
): Recomputed | null {
  const { manifest } = b;
  const inputs: EntryInput[] = b.entries.map((e, k) => {
    const p = picks[k] ?? { option: null, voidReason: 'decrypt_failed' as const };
    return {
      account: e.account,
      stake: BigInt(e.stake),
      option: p.option,
      voidReason: p.option === null ? (p.voidReason ?? 'decrypt_failed') : null,
      ...(e.qualifies === undefined ? {} : { qualifies: e.qualifies }),
    };
  });
  let settled: ReturnType<typeof settle>;
  try {
    settled = settle(inputs, settleParamsOf(b));
  } catch (e) {
    // settle refuses inputs the API never produces (e.g. one account entering twice).
    checks.fail('record', `settle refuses the bundle's entries: ${(e as Error).message}`);
    return null;
  }
  const { record, payouts } = settled;
  const got = recordJson(record);
  const differs = (Object.keys(got) as (keyof RecordJson)[]).filter(
    (k) => JSON.stringify(got[k]) !== JSON.stringify(manifest.record[k]),
  );
  if (differs.length === 0)
    checks.pass('record', `settlement record recomputes (${record.outcome})`);
  else {
    checks.fail(
      'record',
      `settlement record differs in ${differs.join(', ')}`,
      JSON.stringify(Object.fromEntries(differs.map((k) => [k, got[k]]))),
      JSON.stringify(Object.fromEntries(differs.map((k) => [k, manifest.record[k]]))),
    );
  }
  checks.equal('manifest.entryCount', 'entry count', b.entries.length, manifest.entryCount);

  let freeTree: Recomputed['freeTree'] = null;
  let stakesTree: Recomputed['stakesTree'] = null;
  if (manifest.mode === 'free' && payouts.length > 0) {
    freeTree = freePayoutTree(
      ulidToBytes(manifest.roundId),
      payouts.map((p) => ({ userIdHash: p.account as Hex, amount: p.amount })),
    );
  } else if (manifest.mode === 'stakes' && record.outcome === 'settled' && payouts.length > 0) {
    stakesTree = stakesPayoutTree(
      BigInt(manifest.chainRoundId ?? '0'),
      payouts.map((p) => {
        const kind = STAKES_KIND[p.kind];
        if (kind === undefined) throw new Error(`no Stakes leaf kind for ${p.kind}`);
        return { account: p.account as Hex, kind };
      }),
    );
  }
  const payoutRoot = freeTree?.root ?? stakesTree?.root ?? null;
  checks.equal('payoutRoot', 'payout root', payoutRoot ?? 'null', manifest.payoutRoot ?? 'null');
  return { record, payouts, freeTree, stakesTree, payoutRoot };
}

/** Free: rebuilds the commitment tree over the anchored entries (seq < entryCount). */
export function recomputeCommitment(
  b: LoadedBundle,
  checks: Checks,
): { root: Hex; totalStake: bigint } | null {
  const c = b.manifest.commitment;
  if (c === null) {
    if (b.entries.length > 0)
      checks.fail('commitment.root', 'a Free mode with entries has no commitment');
    else checks.skip('commitment.root', 'no entries, no commitment');
    return null;
  }
  const anchored = b.entries.filter((e) => e.seq < c.entryCount);
  if (anchored.length !== c.entryCount) {
    checks.fail(
      'commitment.root',
      'the bundle holds fewer entries than the commitment',
      c.entryCount,
      anchored.length,
    );
    return null;
  }
  const roundId = ulidToBytes(b.manifest.roundId);
  const root = freeCommitmentTree(
    anchored.map((e) => ({
      roundId,
      mode: 0,
      userIdHash: e.account as Hex,
      stake: BigInt(e.stake),
      commitment: (e.commitment ?? '0x') as Hex,
      seq: e.seq,
    })),
  ).root;
  checks.equal('commitment.root', 'commitment root over the anchored entries', c.root, root);
  return { root, totalStake: anchored.reduce((s, e) => s + BigInt(e.stake), 0n) };
}
