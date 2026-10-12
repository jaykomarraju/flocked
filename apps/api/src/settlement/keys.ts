// R2 keys and sizes for settlement. `bundles/` is the public verification bundle (write-once, docs/
// bundle-format.md); `settlement/` holds the private working files of one run (decrypt inputs and
// outputs, the verified beacon), which are deterministic and may be rewritten by a retry.
import type { Mode } from '@flocked/shared';

/** Ciphertexts per decrypt message (spec "Architecture": Decrypt workers, about 500). */
export const DECRYPT_CHUNK_SIZE = 500;
/** Entries per bundle chunk (spec "Settlement output": about 5,000). */
export const BUNDLE_CHUNK_SIZE = 5000;

const pad = (i: number) => String(i).padStart(4, '0');

export function bundlePrefix(roundId: string, mode: Mode): string {
  return `bundles/${roundId}/${mode}/`;
}

export function manifestKey(roundId: string, mode: Mode): string {
  return `${bundlePrefix(roundId, mode)}manifest.json`;
}

export function bundleChunkKey(roundId: string, mode: Mode, index: number): string {
  return `${bundlePrefix(roundId, mode)}chunk-${pad(index)}.json`;
}

export function workPrefix(roundId: string, mode: Mode): string {
  return `settlement/${roundId}/${mode}/`;
}

export function beaconKey(roundId: string, mode: Mode): string {
  return `${workPrefix(roundId, mode)}beacon.json`;
}

/** A decrypt message's `chunkKey`: the R2 key of that chunk's ciphertexts. */
export function decryptInputKey(roundId: string, mode: Mode, index: number): string {
  return `${workPrefix(roundId, mode)}in-${pad(index)}.json`;
}

/** Where the decrypt consumer writes a chunk's per-entry results (`DecryptChunkResult.resultKey`). */
export function decryptOutputKey(roundId: string, mode: Mode, index: number): string {
  return `${workPrefix(roundId, mode)}out-${pad(index)}.json`;
}

/** The chunk index of a decrypt input key for (roundId, mode), or null for any other key. */
export function decryptChunkIndex(roundId: string, mode: Mode, key: string): number | null {
  const prefix = `${workPrefix(roundId, mode)}in-`;
  if (!key.startsWith(prefix) || !key.endsWith('.json')) return null;
  const digits = key.slice(prefix.length, -'.json'.length);
  if (!/^[0-9]{4,}$/.test(digits)) return null;
  const i = Number(digits);
  return pad(i) === digits ? i : null;
}
