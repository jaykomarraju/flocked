// verifyRound: reproduces one mode's settlement from public data and compares it with the chain:
// the onchain proposal (Stakes) or the anchored commitment and manifest (Free). verifyEntry: the same,
// then one account's entries and payout with its Merkle proof.
import { committedDeployments } from '@flocked/abi';
import type { Payout, StakesLeafKind } from '@flocked/settle';
import { freeConfigHash, roundKey } from '@flocked/shared';
import { QUICKNET, type DrandChain } from '@flocked/tlock';
import { hexToBytes, zeroHash, type Hex } from 'viem';
import type { BundleEntry } from './bundle.js';
import { ESCROW_STATUS, viemReader, type ChainReader } from './chain.js';
import { Checks } from './checks.js';
import {
  checkBeacon,
  loadBundle,
  recomputeCommitment,
  recomputeEntries,
  recomputeSettlement,
  type LoadedBundle,
  type Recomputed,
} from './recompute.js';
import { httpSource } from './source.js';
import {
  EXIT_CODES,
  type AnchorWrite,
  type ProposalInfo,
  type Report,
  type Verdict,
  type VerifyRoundOptions,
} from './types.js';

interface Run {
  report: Report;
  bundle: LoadedBundle | null;
  recomputed: Recomputed | null;
}

function verdictOf(checks: Checks, disputed: boolean): Verdict {
  if (checks.failed()) return 'mismatch';
  if (disputed || checks.list.some((c) => c.status === 'error')) return 'unverifiable';
  return 'match';
}

function readerFor(o: VerifyRoundOptions): ChainReader {
  if (o.reader) return o.reader;
  const d = o.addresses ?? committedDeployments[o.chainId];
  if (!d)
    throw new Error(`no Flocked deployment is known on chain ${o.chainId}: pass the addresses`);
  return viemReader({
    rpcUrl: o.rpcUrl,
    escrow: d.escrow,
    anchor: d.anchor,
    deployBlock: d.deployBlock,
  });
}

async function run(o: VerifyRoundOptions): Promise<Run> {
  const checks = new Checks();
  const progress = o.onProgress ?? (() => {});
  const chain: DrandChain = o.drand ?? QUICKNET;
  const report: Report = {
    roundId: o.roundId,
    mode: o.mode,
    chainId: o.chainId,
    verdict: 'unverifiable',
    exitCode: 2,
    disputed: false,
    bundleHash: null,
    record: null,
    entryCount: null,
    anchors: [],
    proposal: null,
    checks: checks.list,
  };
  const finish = (bundle: LoadedBundle | null, recomputed: Recomputed | null): Run => {
    report.disputed = report.anchors.some((a) => a.disputed);
    report.verdict = verdictOf(checks, report.disputed);
    report.exitCode = EXIT_CODES[report.verdict];
    return { report, bundle, recomputed };
  };

  let reader: ChainReader;
  try {
    reader = readerFor(o);
  } catch (e) {
    checks.error('chain.config', (e as Error).message);
    return finish(null, null);
  }

  progress('reading the bundle');
  const source = o.source ?? httpSource(o.bundleBaseUrl);
  const bundle = await loadBundle(source, o.roundId, o.mode, checks, progress);
  if (!bundle) return finish(null, null);
  report.bundleHash = bundle.bundleHash;
  report.entryCount = bundle.entries.length;

  let recomputed: Recomputed | null = null;
  try {
    if (o.mode === 'free') {
      recomputed = await verifyFree(bundle, chain, reader, checks, report, progress);
    } else {
      recomputed = await verifyStakes(bundle, chain, reader, checks, report, progress);
    }
  } catch (e) {
    checks.error('verify', `verification stopped: ${(e as Error).message}`);
  }
  report.record = recomputed?.record ?? null;
  return finish(bundle, recomputed);
}

async function verifyFree(
  b: LoadedBundle,
  chain: DrandChain,
  reader: ChainReader,
  checks: Checks,
  report: Report,
  progress: (l: string) => void,
): Promise<Recomputed | null> {
  const m = b.manifest;
  checks.equal(
    'manifest.free',
    'Free manifest has no Stakes fields',
    'null/null',
    `${m.chainRoundId}/${m.closeBlock === null ? 'null' : 'set'}`,
  );
  const commitment = recomputeCommitment(b, checks);
  let recomputed: Recomputed | null = null;
  if (checkBeacon(b, chain, checks)) {
    const picks = await recomputeEntries(b, chain, checks, null, progress);
    recomputed = recomputeSettlement(b, picks, checks);
  }

  progress('reading the anchor');
  const key = roundKey(m.roundId, 'free');
  const a = await reader.anchor(key);
  if (a.lockedAt === 0n) {
    checks.error('anchor.lock', 'the round key is not locked on FlockedAnchor');
    return recomputed;
  }
  checks.equal(
    'anchor.lock',
    'closesAt and beaconRound in the lock leaf',
    `${a.closesAt}/${a.beaconRound}`,
    `${m.closesAt}/${m.beaconRound}`,
  );
  checks.equal(
    'anchor.configHash',
    'Free config hash in the lock leaf',
    a.configHash,
    freeConfigHash(b.config),
  );
  if (m.commitment) {
    if (a.committedAt === 0n)
      checks.fail('anchor.commitment', 'the manifest names a commitment the anchor never received');
    else {
      checks.equal(
        'anchor.commitment',
        'anchored commitment root and entry count',
        `${a.commitmentRoot}/${a.entryCount}`,
        `${m.commitment.root}/${m.commitment.entryCount}`,
      );
      if (commitment)
        checks.equal(
          'anchor.totalStake',
          'anchored total stake',
          a.totalStake,
          commitment.totalStake,
        );
    }
  }
  if (a.manifestAnchoredAt === 0n)
    checks.error('anchor.manifestHash', 'the manifest hash is not anchored yet');
  else
    checks.equal(
      'anchor.manifestHash',
      'anchored manifest hash is keccak256(manifest)',
      a.manifestHash,
      b.bundleHash,
    );

  report.anchors = await anchorWrites(reader, key, a, checks);
  const commit = report.anchors.find((w) => w.event === 'Committed');
  if (m.commitment && commit) {
    checks.equal(
      'anchor.anchorTx',
      'manifest anchorTx is the Committed transaction',
      commit.txHash,
      m.commitment.anchorTx,
    );
  }
  return recomputed;
}

/** The anchor writes for `key`, their senders, and whether each sender's role was revoked later. */
async function anchorWrites(
  reader: ChainReader,
  key: Hex,
  state: Awaited<ReturnType<ChainReader['anchor']>>,
  checks: Checks,
): Promise<AnchorWrite[]> {
  const logs = await reader.anchorLogs(key, state);
  const out: AnchorWrite[] = [];
  for (const l of logs) {
    const revoked =
      (await reader.anchorRevocations(l.sender, l.blockNumber)).find((n) => n >= l.blockNumber) ??
      null;
    out.push({ ...l, revokedAtBlock: revoked, disputed: revoked !== null });
  }
  const want = [
    ['Locked', state.lockedAt],
    ['Committed', state.committedAt],
    ['ManifestAnchored', state.manifestAnchoredAt],
  ] as const;
  const unseen = want.filter(([event, at]) => at !== 0n && !out.some((w) => w.event === event));
  if (unseen.length > 0) {
    checks.error(
      'anchor.sender',
      `no log found for ${unseen.map(([e]) => e).join(', ')}, so its sender is unknown`,
    );
    return out;
  }
  const disputed = out.filter((w) => w.disputed);
  if (disputed.length > 0) {
    checks.error(
      'anchor.sender',
      `disputed: ${disputed.map((w) => `${w.event} by ${w.sender}, revoked at block ${w.revokedAtBlock}`).join('; ')}`,
    );
  } else if (out.length > 0) {
    checks.pass('anchor.sender', out.map((w) => `${w.event} by ${w.sender}`).join('; '));
  }
  return out;
}

async function verifyStakes(
  b: LoadedBundle,
  chain: DrandChain,
  reader: ChainReader,
  checks: Checks,
  report: Report,
  progress: (l: string) => void,
): Promise<Recomputed | null> {
  const m = b.manifest;
  if (m.chainRoundId === null || m.closeBlock === null || m.commitment !== null) {
    checks.fail(
      'manifest.stakes',
      'a Stakes manifest needs chainRoundId and closeBlock and no commitment',
    );
    return null;
  }
  const id = BigInt(m.chainRoundId);
  progress('reading the escrow round');
  const r = await reader.stakesRound(id);
  if (r.status === 0) {
    checks.fail('escrow.round', `escrow round ${id} does not exist`);
    return null;
  }
  const s = b.config.stakes;
  checks.equal(
    'escrow.config',
    'closesAt, beaconRound, stake, fees, cap and minEntrants in the onchain RoundConfig',
    `${r.closesAt}/${r.beaconRound}/${r.stake}/${r.feeBps}/${r.creatorBps}/${r.capMultiple}/${r.minEntrants}`,
    `${m.closesAt}/${m.beaconRound}/${s?.stake}/${s?.feeBps}/${s?.creatorBps}/${s?.capMultiple}/${s?.minEntrants}`,
  );
  const hash = await reader.blockHash(BigInt(m.closeBlock.number));
  checks.equal('escrow.closeBlock', 'close block hash', hash ?? 'missing', m.closeBlock.hash);

  progress('reading Entered logs');
  const logs = await reader.entered(id, r.opensAt, BigInt(m.closeBlock.number));
  checks.equal(
    'escrow.entries',
    'Entered logs up to the close block (and all the round has)',
    `${logs.length}/${r.entryCount}`,
    `${b.entries.length}/${b.entries.length}`,
  );
  const accounts = checks.many(
    'entry.account',
    'entry is the Entered log at its seq (player, stake)',
  );
  b.entries.forEach((e, k) => {
    const l = logs[k];
    accounts.item(
      l !== undefined && l.player === e.account && BigInt(e.stake) === r.stake,
      () => `seq ${e.seq}`,
    );
  });
  accounts.done();

  let recomputed: Recomputed | null = null;
  if (checkBeacon(b, chain, checks)) {
    const cts = b.entries.map((_, k) => {
      const l = logs[k];
      return l ? hexToBytes(l.ciphertext) : null;
    });
    const picks = await recomputeEntries(b, chain, checks, cts, progress);
    recomputed = recomputeSettlement(b, picks, checks);
  }

  progress('reading the proposal');
  const proposals = await reader.proposals(id, BigInt(m.closeBlock.number));
  const p = [...proposals].reverse().find((x) => x.bundleHash === b.bundleHash);
  if (!p) {
    const last = proposals[proposals.length - 1];
    if (last)
      checks.fail(
        'proposal.bundleHash',
        'no proposal posts this manifest',
        last.bundleHash,
        b.bundleHash,
      );
    else checks.error('proposal.bundleHash', 'no outcome is proposed for this round yet');
    return recomputed;
  }
  checks.pass('proposal.bundleHash', 'the proposal posts keccak256(manifest)');
  const status = ESCROW_STATUS[p.status] ?? String(p.status);
  report.proposal = {
    status: status as ProposalInfo['status'],
    n0: p.n0,
    n1: p.n1,
    nVoid: p.nVoid,
    payoutRoot: p.payoutRoot,
    bundleHash: p.bundleHash,
    txHash: p.txHash,
    blockNumber: p.blockNumber,
    onchainStatus: ESCROW_STATUS[r.status] ?? String(r.status),
  };
  const rec = m.record;
  checks.equal(
    'proposal.outcome',
    'proposed status and headcounts (n0, n1, nVoid)',
    `${status}/${p.n0}/${p.n1}/${p.nVoid}`,
    `${rec.outcome === 'settled' ? 'SettleProposed' : 'RefundProposed'}/${rec.n[0]}/${rec.n[1]}/${rec.voidCount}`,
  );
  checks.equal(
    'proposal.payoutRoot',
    'proposed payout root',
    p.payoutRoot,
    m.payoutRoot ?? zeroHash,
  );
  return recomputed;
}

/** Reproduces one mode's settlement from public data. Never throws for bad data: see `verdict`. */
export async function verifyRound(o: VerifyRoundOptions): Promise<Report> {
  return (await run(o)).report;
}

export interface EntryPayout {
  kind: Payout['kind'];
  amount: bigint;
  /** The leaf's Merkle proof against `payoutRoot` (empty when the mode has no payout tree). */
  proof: Hex[];
}

export interface EntryReport {
  report: Report;
  /** The account's entries in the bundle. */
  entries: BundleEntry[];
  /** The account's payouts, with proofs. */
  payouts: EntryPayout[];
}

const KIND_INDEX: Partial<Record<Payout['kind'], StakesLeafKind>> = {
  win: 0,
  rebate: 1,
  void_refund: 2,
};

/**
 * verifyRound, then one account's view: its entries and its payouts with Merkle proofs. `account` is
 * the Free userIdHash (from the receipt) or the Stakes wallet.
 */
export async function verifyEntry(
  o: VerifyRoundOptions & { account: string },
): Promise<EntryReport> {
  const { report, bundle, recomputed } = await run(o);
  const account = o.account.toLowerCase();
  const entries = bundle?.entries.filter((e) => e.account === account) ?? [];
  const payouts: EntryPayout[] = (recomputed?.payouts ?? [])
    .filter((p) => p.account === account)
    .map((p) => {
      let proof: Hex[] = [];
      if (recomputed?.freeTree) proof = recomputed.freeTree.proof(account as Hex);
      const kind = KIND_INDEX[p.kind];
      if (recomputed?.stakesTree && kind !== undefined)
        proof = recomputed.stakesTree.proof(account as Hex, kind);
      return { kind: p.kind, amount: p.amount, proof };
    });
  return { report, entries, payouts };
}
