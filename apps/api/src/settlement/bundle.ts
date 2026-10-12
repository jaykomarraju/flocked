// The public verification bundle (docs/bundle-format.md): RFC 8785 canonical JSON, so the bytes are
// a pure function of the settlement inputs and a retry writes the same objects. Bundle objects are
// write-once: an existing object with other bytes is never replaced.
import type { SettlementRecord } from '@flocked/settle';
import { canonicalJson, type Mode } from '@flocked/shared';
import { keccak256, type Hex } from 'viem';
import { bundleChunkKey } from './keys.js';
import {
  BUNDLE_FORMAT,
  type BundleChunk,
  type BundleEntry,
  type ChunkRef,
  type Manifest,
  type RecordJson,
} from './types.js';

const utf8 = new TextEncoder();

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8.encode(canonicalJson(value));
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

/** A bundle chunk's bytes and its manifest entry. `entries` are consecutive in seq order. */
export function buildBundleChunk(
  roundId: string,
  mode: Mode,
  index: number,
  entries: BundleEntry[],
): { bytes: Uint8Array; ref: ChunkRef } {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (!first || !last) throw new RangeError('a bundle chunk needs at least one entry');
  const chunk: BundleChunk = { bundleFormat: BUNDLE_FORMAT, roundId, mode, index, entries };
  const bytes = canonicalBytes(chunk);
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
  const totals: ChunkRef['totals'] = [
    { n: String(n[0]), w: String(w[0]) },
    { n: String(n[1]), w: String(w[1]) },
  ];
  return {
    bytes,
    ref: {
      index,
      key: bundleChunkKey(roundId, mode, index),
      hash: keccak256(bytes),
      entries: entries.length,
      firstSeq: first.seq,
      lastSeq: last.seq,
      totals,
      voids,
    },
  };
}

export function buildManifest(manifest: Manifest): { bytes: Uint8Array; bundleHash: Hex } {
  const bytes = canonicalBytes(manifest);
  return { bytes, bundleHash: keccak256(bytes) };
}

/** An existing bundle object holds other bytes than this run produced. Never overwritten. */
export class BundleConflictError extends Error {
  constructor(readonly key: string) {
    super(`bundle object ${key} already exists with different bytes`);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Writes `bytes` at `key` unless an object is there: the same bytes are a retry (`unchanged`), and
 * any other bytes throw BundleConflictError. One SettlementDO per (round, mode) is the only writer
 * of its prefix and runs one reduce at a time, so the read and the write cannot interleave.
 */
export async function writeOnce(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
): Promise<'written' | 'unchanged'> {
  const existing = await bucket.get(key);
  if (existing) {
    if (sameBytes(new Uint8Array(await existing.arrayBuffer()), bytes)) return 'unchanged';
    throw new BundleConflictError(key);
  }
  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });
  return 'written';
}
