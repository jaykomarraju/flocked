// A real Stakes bundle, built here rather than taken from apps/api: the watcher verifies the
// published format, so its tests must be able to produce a bundle (and tamper with one) without the
// backend. Every ciphertext is a real tlock ciphertext sealed to a recorded quicknet round, so the
// recompute in `@flocked/verify` does real decryption.
import {
  settle,
  stakesPayoutTree,
  type EntryInput,
  type OptionIndex,
  type Payout,
  type SettlementRecord,
  type StakesLeafKind,
} from '@flocked/settle';
import { QUICKNET, encodePlaintext, encryptPick, roundRefFromChainId } from '@flocked/tlock';
import { recordJson, type ChainReader } from '@flocked/verify';
import { bytesToHex, keccak256, zeroHash, type Address, type Hex } from 'viem';

/** A recorded quicknet beacon (packages/tlock/fixtures/quicknet-beacons.json), as W9-B's fixtures use. */
export const BEACON = {
  round: 32_870_075,
  signature:
    '85c653c4e0099d069e9f7f525d14239c5f2ffa496f02ad5daf4e4e240de575261d5248172ad543b351b236c838853d8e',
};
export const BEACON_TIME = QUICKNET.genesis + (BEACON.round - 1) * QUICKNET.period;
/** The round closes `beaconDelay` before the beacon. */
export const BEACON_DELAY = 120;
export const CLOSES_AT = BEACON_TIME - BEACON_DELAY;
export const OPENS_AT = CLOSES_AT - 3 * 60 * 60;

export const ROUND_ID = '01K8V3R4N5P6Q7S8T9VWXYZABC';
export const CHAIN_ROUND_ID = 7n;
export const STAKE = 5_000_000n;
export const TREASURY: Address = '0x00000000000000000000000000000000000beef0';

// ---- Canonical JSON (RFC 8785, JCS) ------------------------------------------------------------
// The watcher's own, so the fixture does not reach into @flocked/shared (which the watcher may not
// depend on). Bundle objects hold only strings, finite integers, booleans, nulls, arrays and plain
// objects, which is all this needs to cover.
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(',')}}`;
  }
  throw new TypeError(`jcs: unsupported ${typeof value}`);
}

const utf8 = new TextEncoder();
export const bytesOf = (v: unknown): Uint8Array => utf8.encode(jcs(v));
export const parseJson = <T>(b: Uint8Array): T => JSON.parse(new TextDecoder().decode(b)) as T;

// ---- Shapes the fixture builds (docs/bundle-format.md, bundleFormat 1) -------------------------

export interface FixtureEntry {
  seq: number;
  account: string;
  stake: string;
  option: OptionIndex | null;
  nonce: string | null;
  valid: boolean;
  voidReason: string | null;
}

export interface FixtureChunk {
  bundleFormat: 1;
  roundId: string;
  mode: 'stakes';
  index: number;
  entries: FixtureEntry[];
}

export interface FixtureManifest {
  bundleFormat: 1;
  formulaVersion: number;
  roundId: string;
  mode: 'stakes';
  kind: 'daily' | 'room';
  roomId: string | null;
  closesAt: number;
  beaconRound: number;
  config: unknown;
  drand: { chainHash: string; signature: string };
  commitment: null;
  chainRoundId: string;
  closeBlock: { number: number; hash: Hex };
  record: ReturnType<typeof recordJson>;
  voids: Record<string, number>;
  payoutRoot: Hex | null;
  entryCount: number;
  chunkSize: number;
  chunks: {
    index: number;
    key: string;
    hash: Hex;
    entries: number;
    firstSeq: number;
    lastSeq: number;
    totals: [{ n: string; w: string }, { n: string; w: string }];
    voids: number;
  }[];
}

/** What each entry's ciphertext is: an option, or a ciphertext that recomputes to a VOID reason. */
export type Pick = 0 | 1 | 'wrong_target' | 'bad_plaintext';

export interface StakesFixtureOptions {
  roundId?: string;
  chainRoundId?: bigint;
  picks?: Pick[];
  stake?: bigint;
  minEntrants?: number;
  feeBps?: number;
  creatorBps?: number;
  capMultiple?: number;
  chunkSize?: number;
  creator?: Address;
  payoutAddress?: Address | null;
}

/** The locked config the manifest carries (`LockedConfigSchema`, Stakes only). */
export interface FixtureConfig {
  beaconDelay: number;
  stakes: {
    stake: string;
    feeBps: number;
    creatorBps: number;
    capMultiple: number;
    minEntrants: number;
    creator: Address;
    payoutAddress: Address | null;
  };
}

export interface StakesFixture {
  roundId: string;
  chainRoundId: bigint;
  closesAt: number;
  config: FixtureConfig;
  objects: Map<string, Uint8Array>;
  manifest: FixtureManifest;
  bundleHash: Hex;
  record: SettlementRecord;
  payouts: Payout[];
  payoutRoot: Hex | null;
  entered: { player: Address; ciphertext: Hex; blockNumber: bigint; logIndex: number }[];
  closeBlock: { number: number; hash: Hex };
  reader: FakeChainReader;
}

const account = (i: number): Address => `0x${(i + 1).toString(16).padStart(40, '0')}`;

const KIND_INDEX: Partial<Record<Payout['kind'], StakesLeafKind>> = {
  win: 0,
  rebate: 1,
  void_refund: 2,
};

export const manifestKeyOf = (roundId: string) => `bundles/${roundId}/stakes/manifest.json`;
export const chunkKeyOf = (roundId: string, i: number) =>
  `bundles/${roundId}/stakes/chunk-${String(i).padStart(4, '0')}.json`;

/** Builds a complete, self-consistent Stakes bundle and the chain state that posts it. */
export async function stakesFixture(o: StakesFixtureOptions = {}): Promise<StakesFixture> {
  const roundId = o.roundId ?? ROUND_ID;
  const chainRoundId = o.chainRoundId ?? CHAIN_ROUND_ID;
  const stake = o.stake ?? STAKE;
  const picks: Pick[] = o.picks ?? [0, 0, 0, 0, 1, 'wrong_target', 'bad_plaintext'];
  const chunkSize = o.chunkSize ?? 5;
  const roundRef = roundRefFromChainId(chainRoundId);
  const config: FixtureConfig = {
    beaconDelay: BEACON_DELAY,
    stakes: {
      stake: String(stake),
      feeBps: o.feeBps ?? 500,
      creatorBps: o.creatorBps ?? 100,
      capMultiple: o.capMultiple ?? 10,
      minEntrants: o.minEntrants ?? 3,
      creator: o.creator ?? TREASURY,
      payoutAddress: o.payoutAddress ?? null,
    },
  };

  const entries: FixtureEntry[] = [];
  const inputs: EntryInput[] = [];
  const entered: StakesFixture['entered'] = [];
  for (const [seq, pick] of picks.entries()) {
    const nonce = new Uint8Array(16).fill(seq + 1);
    let ct: Uint8Array;
    let option: OptionIndex | null;
    let voidReason: string | null;
    if (pick === 'wrong_target') {
      // Sealed to another drand round: `classify` stops at the stanza, before any decryption.
      ct = await encryptPick(
        QUICKNET,
        BEACON.round + 1,
        encodePlaintext({ roundRef, optionIndex: 0, nonce }),
      );
      option = null;
      voidReason = 'wrong_target';
    } else if (pick === 'bad_plaintext') {
      // Sealed to the right round, but the plaintext names another escrow round: it really is
      // decrypted, and the reason comes out of the plaintext.
      ct = await encryptPick(
        QUICKNET,
        BEACON.round,
        encodePlaintext({
          roundRef: roundRefFromChainId(chainRoundId + 1n),
          optionIndex: 1,
          nonce,
        }),
      );
      option = null;
      voidReason = 'bad_plaintext';
    } else {
      ct = await encryptPick(
        QUICKNET,
        BEACON.round,
        encodePlaintext({ roundRef, optionIndex: pick, nonce }),
      );
      option = pick;
      voidReason = null;
    }
    const player = account(seq);
    entries.push({
      seq,
      account: player,
      stake: String(stake),
      option,
      nonce: option === null ? null : bytesToHex(nonce),
      valid: option !== null,
      voidReason,
    });
    inputs.push({
      account: player,
      stake,
      option,
      voidReason: (voidReason ?? null) as EntryInput['voidReason'],
    });
    entered.push({
      player,
      ciphertext: bytesToHex(ct),
      blockNumber: 50n + BigInt(seq),
      logIndex: 0,
    });
  }

  const { record, payouts } = settle(inputs, {
    feeBps: config.stakes.feeBps,
    creatorBps: config.stakes.creatorBps,
    capMultiple: config.stakes.capMultiple,
    minEntrants: config.stakes.minEntrants,
  });
  const payoutRoot =
    record.outcome === 'settled' && payouts.length > 0
      ? stakesPayoutTree(
          chainRoundId,
          payouts.map((p) => {
            const kind = KIND_INDEX[p.kind];
            if (kind === undefined) throw new Error(`no Stakes leaf kind for ${p.kind}`);
            return { account: p.account as Hex, kind };
          }),
        ).root
      : null;

  const objects = new Map<string, Uint8Array>();
  const chunks: FixtureManifest['chunks'] = [];
  for (let i = 0; i * chunkSize < entries.length; i++) {
    const slice = entries.slice(i * chunkSize, (i + 1) * chunkSize);
    const chunk: FixtureChunk = {
      bundleFormat: 1,
      roundId,
      mode: 'stakes',
      index: i,
      entries: slice,
    };
    const key = chunkKeyOf(roundId, i);
    const bytes = bytesOf(chunk);
    objects.set(key, bytes);
    chunks.push({
      index: i,
      key,
      hash: keccak256(bytes),
      entries: slice.length,
      firstSeq: slice[0]?.seq ?? 0,
      lastSeq: slice[slice.length - 1]?.seq ?? 0,
      totals: chunkTotals(slice),
      voids: slice.filter((e) => e.option === null).length,
    });
  }

  const voids: Record<string, number> = {};
  for (const e of entries) if (e.voidReason) voids[e.voidReason] = (voids[e.voidReason] ?? 0) + 1;
  const closeBlock = { number: 100, hash: keccak256(utf8.encode(`close-${roundId}`)) };
  const manifest: FixtureManifest = {
    bundleFormat: 1,
    formulaVersion: 1,
    roundId,
    mode: 'stakes',
    kind: 'daily',
    roomId: null,
    closesAt: CLOSES_AT,
    beaconRound: BEACON.round,
    config,
    drand: { chainHash: QUICKNET.chainHash, signature: BEACON.signature },
    commitment: null,
    chainRoundId: String(chainRoundId),
    closeBlock,
    record: recordJson(record),
    voids,
    payoutRoot,
    entryCount: entries.length,
    chunkSize,
    chunks,
  };
  const manifestBytes = bytesOf(manifest);
  objects.set(manifestKeyOf(roundId), manifestBytes);
  const bundleHash = keccak256(manifestBytes);

  const reader = new FakeChainReader();
  reader.round = {
    status: record.outcome === 'settled' ? 2 : 3,
    opensAt: BigInt(OPENS_AT),
    closesAt: BigInt(CLOSES_AT),
    beaconRound: BigInt(BEACON.round),
    stake,
    feeBps: config.stakes.feeBps,
    creatorBps: config.stakes.creatorBps,
    capMultiple: config.stakes.capMultiple,
    minEntrants: config.stakes.minEntrants,
    entryCount: entries.length,
  };
  reader.blocks.set(BigInt(closeBlock.number), closeBlock.hash);
  reader.enteredLogs = entered;
  reader.proposalLogs = [
    {
      status: record.outcome === 'settled' ? 2 : 3,
      n0: Number(record.n[0]),
      n1: Number(record.n[1]),
      nVoid: Number(record.voidCount),
      payoutRoot: payoutRoot ?? zeroHash,
      bundleHash,
      txHash: keccak256(utf8.encode(`propose-${roundId}`)),
      blockNumber: 200n,
    },
  ];

  return {
    roundId,
    chainRoundId,
    closesAt: CLOSES_AT,
    config,
    objects,
    manifest,
    bundleHash,
    record,
    payouts,
    payoutRoot,
    entered,
    closeBlock,
    reader,
  };
}

function chunkTotals(
  entries: readonly FixtureEntry[],
): FixtureManifest['chunks'][number]['totals'] {
  const n = [0n, 0n];
  const w = [0n, 0n];
  for (const e of entries) {
    if (e.option === null) continue;
    n[e.option] = (n[e.option] ?? 0n) + 1n;
    w[e.option] = (w[e.option] ?? 0n) + BigInt(e.stake);
  }
  return [
    { n: String(n[0]), w: String(w[0]) },
    { n: String(n[1]), w: String(w[1]) },
  ];
}

/**
 * A consistently re-published bundle: edits chunks and the manifest, re-hashes every chunk into the
 * manifest and points the proposal at the new manifest hash, so only the semantic checks can catch
 * the edit (as `packages/verify/test/helpers.ts` does).
 */
export function republish(
  f: StakesFixture,
  edit: { chunk?: (c: FixtureChunk) => void; manifest?: (m: FixtureManifest) => void },
): Map<string, Uint8Array> {
  const objects = new Map(f.objects);
  const m = parseJson<FixtureManifest>(objects.get(manifestKeyOf(f.roundId)) ?? new Uint8Array());
  for (const ref of m.chunks) {
    const c = parseJson<FixtureChunk>(objects.get(ref.key) ?? new Uint8Array());
    edit.chunk?.(c);
    const bytes = bytesOf(c);
    objects.set(ref.key, bytes);
    ref.hash = keccak256(bytes);
  }
  edit.manifest?.(m);
  const bytes = bytesOf(m);
  objects.set(manifestKeyOf(f.roundId), bytes);
  const hash = keccak256(bytes);
  f.reader.proposalLogs = f.reader.proposalLogs.map((p) => ({ ...p, bundleHash: hash }));
  return objects;
}

type StakesRoundState = Awaited<ReturnType<ChainReader['stakesRound']>>;
type EnteredLog = Awaited<ReturnType<ChainReader['entered']>>[number];
type ProposalLog = Awaited<ReturnType<ChainReader['proposals']>>[number];

/** `@flocked/verify`'s ChainReader over fixed state (its own tests' FakeChain, Stakes half). */
export class FakeChainReader implements ChainReader {
  round: StakesRoundState | null = null;
  enteredLogs: EnteredLog[] = [];
  proposalLogs: ProposalLog[] = [];
  blocks = new Map<bigint, Hex>();

  anchor(): never {
    throw new Error('the watcher does not read anchors for Stakes (W11-B)');
  }
  anchorLogs() {
    return Promise.resolve([]);
  }
  anchorRevocations() {
    return Promise.resolve([]);
  }
  stakesRound() {
    if (!this.round) throw new Error('no round');
    return Promise.resolve(this.round);
  }
  entered(_id: bigint, _opensAt: bigint, toBlock: bigint) {
    return Promise.resolve(this.enteredLogs.filter((l) => l.blockNumber <= toBlock));
  }
  proposals() {
    return Promise.resolve(this.proposalLogs);
  }
  blockHash(n: bigint) {
    return Promise.resolve(this.blocks.get(n) ?? null);
  }
}

/**
 * The round as `GET /rounds/:id` publishes it for this fixture: the same Stakes config, plus the
 * override row that makes its non-default `minEntrants` legitimate.
 */
export function publishedRoundFor(
  f: StakesFixture,
  over: { overrides?: { field: string; value: string | number | boolean; auditId: string }[] } = {},
) {
  const s = f.config.stakes;
  return {
    id: f.roundId,
    kind: 'daily' as const,
    roomId: null,
    gameDay: '2026-10-17',
    question: { author: null },
    opensAt: OPENS_AT,
    closesAt: f.closesAt,
    beaconRound: BEACON.round,
    config: {
      beaconDelay: BEACON_DELAY,
      stakes: {
        chainRoundId: String(f.chainRoundId),
        opensAt: OPENS_AT,
        closesAt: f.closesAt,
        beaconRound: BEACON.round,
        stake: s.stake,
        feeBps: s.feeBps,
        creatorBps: s.creatorBps,
        capMultiple: s.capMultiple,
        minEntrants: s.minEntrants,
        creator: s.creator,
        questionHash: `0x${'11'.repeat(32)}`,
        authorHandle: null,
        payoutAddress: null,
      },
      overrides: over.overrides ?? [
        { field: 'stakes.minEntrants', value: s.minEntrants, auditId: 'audit-fixture' },
      ],
    },
    modes: { stakes: {} },
  };
}
