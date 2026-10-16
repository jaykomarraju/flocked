// Fixture bundles made by the API's own settlement pipeline (W5-A): `decryptChunk` and `reduce` from
// apps/api/src/settlement run here in Node over an in-memory bucket and a one-query D1 stand-in.
// Every ciphertext is a real tlock ciphertext sealed to a recorded quicknet round, so the verifier's
// recompute does real decryption. The pipeline is imported by a computed path so this package's
// typecheck doesn't pull in the API's Workers types; the shapes it needs are declared below.
import { freeCommitmentTree, userIdHash } from '@flocked/settle';
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  newUlid,
  ulidToBytes,
  type LockedConfig,
} from '@flocked/shared';
import {
  QUICKNET,
  commitment,
  encodePlaintext,
  encryptPick,
  roundRefFromChainId,
  roundRefFromUlid,
  toBase64Url,
} from '@flocked/tlock';
import { bytesToHex, keccak256, zeroHash, type Hex } from 'viem';
import type {
  AnchorLog,
  AnchorState,
  ChainReader,
  EnteredLog,
  ProposalLog,
  StakesRoundState,
} from '../src/chain.js';

/** Recorded quicknet beacon (packages/tlock/fixtures/quicknet-beacons.json). */
export const BEACON = {
  round: 32_870_075,
  signature:
    '85c653c4e0099d069e9f7f525d14239c5f2ffa496f02ad5daf4e4e240de575261d5248172ad543b351b236c838853d8e',
};
const BEACON_TIME = QUICKNET.genesis + (BEACON.round - 1) * QUICKNET.period;
const CLOSES_AT_MS = (BEACON_TIME - 120) * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const SETTLEMENT = new URL('../../../apps/api/src/settlement/', import.meta.url).href;

interface DecryptOut {
  output: { entries: unknown[] };
  result: { entries: number; valid: number; tally: unknown; voids: unknown };
}
interface Pipeline {
  decryptChunk(
    input: unknown,
    chain: typeof QUICKNET,
    beacon: { round: number; signature: string },
  ): Promise<DecryptOut>;
  reduce(
    env: { DB: unknown; BUCKET: unknown },
    i: Record<string, unknown>,
  ): Promise<{
    bundleHash: Hex;
    manifest: { record: { outcome: string; refundReason: number | null } };
  }>;
}

let loaded: Promise<Pipeline> | undefined;
function pipeline(): Promise<Pipeline> {
  loaded ??= (async () => {
    const decrypt = (await import(/* @vite-ignore */ `${SETTLEMENT}decrypt.ts`)) as Pick<
      Pipeline,
      'decryptChunk'
    >;
    const reduce = (await import(/* @vite-ignore */ `${SETTLEMENT}reduce.ts`)) as Pick<
      Pipeline,
      'reduce'
    >;
    return { decryptChunk: decrypt.decryptChunk, reduce: reduce.reduce };
  })();
  return loaded;
}

/** An R2 stand-in: get (arrayBuffer, json) and put. */
class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  get(key: string) {
    const b = this.objects.get(key);
    if (!b) return Promise.resolve(null);
    return Promise.resolve({
      arrayBuffer: () => Promise.resolve(b.slice().buffer),
      json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(b)) as unknown),
    });
  }
  put(key: string, value: Uint8Array | string) {
    this.objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
    return Promise.resolve();
  }
}

/** The D1 stand-in for reduce's one query: the mode's entries with their user and account age. */
function entriesDb(rows: { id: string; user_id: string | null; created_at: number | null }[]) {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    prepare: () => ({
      bind: (_round: string, _mode: string, after: string) => ({
        all: () => Promise.resolve({ results: sorted.filter((r) => r.id > after).slice(0, 5000) }),
      }),
    }),
  };
}

export type Sealed = 'valid' | 'garbage' | 'wrong_target' | 'bad_option' | 'bad_plaintext';

export interface FixtureEntry {
  option?: 0 | 1;
  sealed?: Sealed;
  /** Free points or Stakes base units; default the config's minimum. */
  stake?: bigint;
  /** Free room rounds: the account's age at close; default 2 days. */
  ageMs?: number;
}

async function seal(roundRef: Uint8Array, e: FixtureEntry): Promise<Uint8Array> {
  const sealed = e.sealed ?? 'valid';
  if (sealed === 'garbage') return new TextEncoder().encode('not an age file');
  const pt = encodePlaintext({
    roundRef,
    optionIndex: e.option ?? 0,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
  });
  if (sealed === 'bad_option') pt[17] = 2;
  if (sealed === 'bad_plaintext') pt[0] = 9;
  return encryptPick(QUICKNET, sealed === 'wrong_target' ? BEACON.round - 75 : BEACON.round, pt);
}

export interface Fixture {
  roundId: string;
  mode: 'free' | 'stakes';
  objects: Map<string, Uint8Array>;
  bundleHash: Hex;
  outcome: string;
  refundReason: number | null;
  /** A chain reader that agrees with the bundle. */
  reader: FakeChain;
  /** Free: the userIdHash per entry. Stakes: the wallet. */
  accounts: string[];
}

export interface FixtureOptions {
  entries: FixtureEntry[];
  kind?: 'daily' | 'room';
  /** Free: entries in the anchored set (default all). */
  anchored?: number;
  /** Entries per decrypt chunk and per bundle chunk. */
  decryptChunk?: number;
  bundleChunk?: number;
  free?: Partial<NonNullable<LockedConfig['free']>>;
  stakes?: Partial<NonNullable<LockedConfig['stakes']>>;
}

const ANCHORER: Hex = `0x${'a1'.repeat(20)}`;
const txHash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/** Runs the W5-A pipeline for one mode and returns its bundle, plus a chain that agrees with it. */
export async function makeBundle(mode: 'free' | 'stakes', o: FixtureOptions): Promise<Fixture> {
  const p = await pipeline();
  const kind = o.kind ?? 'daily';
  const roundId = newUlid();
  const chainRoundId = 7n;
  const configJson =
    mode === 'free'
      ? {
          beaconDelay: 120,
          free: {
            ...LOCKED_CONFIG_DEFAULTS.free,
            awardRecipient: null,
            ...(kind === 'room' ? { minEntrants: 3 } : {}),
            ...o.free,
          },
        }
      : {
          beaconDelay: 120,
          stakes: {
            ...LOCKED_CONFIG_DEFAULTS.stakes,
            creator: `0x${'de'.repeat(20)}`,
            ...(kind === 'room' ? { minEntrants: 3 } : {}),
            ...o.stakes,
          },
        };
  const config = LockedConfigSchema.parse(configJson);
  const roundRef = mode === 'free' ? roundRefFromUlid(roundId) : roundRefFromChainId(chainRoundId);
  const minStake = BigInt(
    mode === 'free' ? (config.free?.stakeMin ?? '1') : (config.stakes?.stake ?? '1'),
  );
  const anchoredCount = o.anchored ?? o.entries.length;

  const rows = await Promise.all(
    o.entries.map(async (e, seq) => {
      const userId = newUlid();
      const ct = await seal(roundRef, e);
      const stake = e.stake ?? minStake;
      const account: Hex =
        mode === 'free'
          ? userIdHash(ulidToBytes(roundId), ulidToBytes(userId))
          : `0x${(seq + 1).toString(16).padStart(40, '0')}`;
      const preVoid =
        mode !== 'free'
          ? null
          : seq >= anchoredCount
            ? 'not_anchored'
            : stake < BigInt(config.free?.stakeMin ?? '0') ||
                stake > BigInt(config.free?.stakeMax ?? '0')
              ? 'stake_out_of_range'
              : null;
      return {
        seq,
        entryId: `e${String(seq).padStart(6, '0')}`,
        userId,
        createdAt: CLOSES_AT_MS - (e.ageMs ?? 2 * DAY_MS),
        account,
        stake,
        ct,
        commitment: commitment(ct),
        preVoid,
      };
    }),
  );

  const bucket = new MemoryBucket();
  const size = o.decryptChunk ?? 500;
  const partials: unknown[] = [];
  let chunks = 0;
  for (let i = 0; i * size < rows.length; i++) {
    const input = {
      roundId,
      mode,
      index: i,
      beaconRound: BEACON.round,
      roundRef: bytesToHex(roundRef),
      entries: rows.slice(i * size, (i + 1) * size).map((r) => ({
        seq: r.seq,
        entryId: r.entryId,
        account: r.account,
        stake: r.stake.toString(),
        commitment: r.commitment,
        ciphertext: toBase64Url(r.ct),
        preVoid: r.preVoid,
      })),
    };
    const { output, result } = await p.decryptChunk(input, QUICKNET, BEACON);
    const pad = String(i).padStart(4, '0');
    await bucket.put(`settlement/${roundId}/${mode}/in-${pad}.json`, JSON.stringify(input));
    await bucket.put(`settlement/${roundId}/${mode}/out-${pad}.json`, JSON.stringify(output));
    partials.push({ ...result, resultKey: `settlement/${roundId}/${mode}/out-${pad}.json` });
    chunks += 1;
  }

  const anchoredRows = rows.filter((r) => r.seq < anchoredCount);
  const commitRoot =
    mode === 'free' && rows.length > 0
      ? freeCommitmentTree(
          anchoredRows.map((r) => ({
            roundId: ulidToBytes(roundId),
            mode: 0,
            userIdHash: r.account,
            stake: r.stake,
            commitment: r.commitment,
            seq: r.seq,
          })),
        ).root
      : null;
  const closeBlock = { number: 100, hash: keccak256(new TextEncoder().encode(`block-${roundId}`)) };
  const result = await p.reduce(
    {
      BUCKET: bucket,
      DB: entriesDb(
        rows.map((r) => ({ id: r.entryId, user_id: r.userId, created_at: r.createdAt })),
      ),
    },
    {
      round: {
        roundId,
        mode,
        kind,
        roomId: kind === 'room' ? newUlid() : null,
        closesAt: CLOSES_AT_MS,
        beaconRound: BEACON.round,
        config,
        configJson,
        status: 'settling',
        refundReason: null,
        chainRoundId: mode === 'stakes' ? chainRoundId.toString() : null,
        commitmentRoot: commitRoot,
        commitTx: commitRoot ? txHash(2) : null,
      },
      chainHash: QUICKNET.chainHash,
      signature: BEACON.signature,
      anchored: commitRoot
        ? { root: commitRoot, txHash: txHash(2), entryCount: anchoredCount }
        : null,
      closeBlock: mode === 'stakes' ? closeBlock : null,
      chunks,
      partials,
      ...(o.bundleChunk ? { bundleChunkSize: o.bundleChunk } : {}),
    },
  );

  const objects = new Map([...bucket.objects].filter(([k]) => k.startsWith('bundles/')));
  const reader = new FakeChain();
  const rec = result.manifest.record as unknown as {
    outcome: string;
    n: [string, string];
    voidCount: string;
  };
  const payoutRoot = (result.manifest as unknown as { payoutRoot: Hex | null }).payoutRoot;
  if (mode === 'free') {
    reader.anchorState = {
      closesAt: BigInt(CLOSES_AT_MS / 1000),
      beaconRound: BigInt(BEACON.round),
      lockedAt: 1n,
      committedAt: commitRoot ? 2n : 0n,
      configHash: (await import('@flocked/shared')).freeConfigHash(config),
      commitmentRoot: commitRoot ?? zeroHash,
      entryCount: commitRoot ? anchoredCount : 0,
      totalStake: anchoredRows.reduce((s, r) => s + r.stake, 0n),
      manifestAnchoredAt: 3n,
      manifestHash: result.bundleHash,
    };
    reader.logs = [
      { event: 'Locked', txHash: txHash(1), blockNumber: 10n, sender: ANCHORER },
      ...(commitRoot
        ? [{ event: 'Committed' as const, txHash: txHash(2), blockNumber: 20n, sender: ANCHORER }]
        : []),
      { event: 'ManifestAnchored', txHash: txHash(3), blockNumber: 300n, sender: ANCHORER },
    ];
  } else {
    reader.round = {
      status: 2,
      opensAt: BigInt(CLOSES_AT_MS / 1000 - 3600),
      closesAt: BigInt(CLOSES_AT_MS / 1000),
      beaconRound: BigInt(BEACON.round),
      stake: BigInt(config.stakes?.stake ?? '0'),
      feeBps: config.stakes?.feeBps ?? 0,
      creatorBps: config.stakes?.creatorBps ?? 0,
      capMultiple: config.stakes?.capMultiple ?? 0,
      minEntrants: config.stakes?.minEntrants ?? 0,
      entryCount: rows.length,
    };
    reader.blocks.set(100n, closeBlock.hash);
    reader.enteredLogs = rows.map((r) => ({
      player: r.account,
      ciphertext: bytesToHex(r.ct),
      blockNumber: 50n + BigInt(r.seq),
      logIndex: 0,
    }));
    reader.proposalLogs = [
      {
        status: rec.outcome === 'settled' ? 2 : 3,
        n0: Number(rec.n[0]),
        n1: Number(rec.n[1]),
        nVoid: Number(rec.voidCount),
        payoutRoot: rec.outcome === 'settled' ? (payoutRoot ?? zeroHash) : zeroHash,
        bundleHash: result.bundleHash,
        txHash: txHash(4),
        blockNumber: 200n,
      },
    ];
  }
  return {
    roundId,
    mode,
    objects,
    bundleHash: result.bundleHash,
    outcome: result.manifest.record.outcome,
    refundReason: result.manifest.record.refundReason,
    reader,
    accounts: rows.map((r) => r.account),
  };
}

/** A ChainReader over fixed state. */
export class FakeChain implements ChainReader {
  anchorState: AnchorState | null = null;
  logs: AnchorLog[] = [];
  revoked = new Map<Hex, bigint>();
  round: StakesRoundState | null = null;
  enteredLogs: EnteredLog[] = [];
  proposalLogs: ProposalLog[] = [];
  blocks = new Map<bigint, Hex>();

  anchor() {
    if (!this.anchorState) throw new Error('no anchor state');
    return Promise.resolve(this.anchorState);
  }
  anchorLogs() {
    return Promise.resolve(this.logs);
  }
  anchorRevocations(account: Hex, from: bigint) {
    const at = this.revoked.get(account);
    return Promise.resolve(at !== undefined && at >= from ? [at] : []);
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
