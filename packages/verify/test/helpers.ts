import { canonicalJson } from '@flocked/shared';
import { keccak256, type Hex } from 'viem';
import type { Chunk, Manifest } from '../src/bundle.js';
import { memorySource } from '../src/source.js';
import type { Report, VerifyRoundOptions } from '../src/types.js';
import { verifyRound } from '../src/verify.js';
import type { Fixture } from './pipeline.js';

export function options(f: Fixture, objects = f.objects): VerifyRoundOptions {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    chainId: 31337,
    roundId: f.roundId,
    mode: f.mode,
    bundleBaseUrl: 'memory:',
    source: memorySource(objects),
    reader: f.reader,
  };
}

export const verify = (f: Fixture, objects = f.objects) => verifyRound(options(f, objects));

/** Ids of the checks with `status`. */
export const ids = (r: Report, status: 'fail' | 'error' | 'pass' = 'fail') =>
  r.checks.filter((c) => c.status === status).map((c) => c.id);

const utf8 = new TextEncoder();
const parse = <T>(b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as T;
const manifestKeyOf = (f: Fixture) => `bundles/${f.roundId}/${f.mode}/manifest.json`;

export function manifestOf(f: Fixture, objects = f.objects): Manifest {
  const b = objects.get(manifestKeyOf(f));
  if (!b) throw new Error('no manifest');
  return parse<Manifest>(b);
}

/**
 * A consistently re-published bundle: edits chunks and the manifest, re-hashes every chunk into the
 * manifest, and points the fake chain's anchor or proposal at the new manifest hash, so only the
 * semantic checks can catch the edit.
 */
export function republish(
  f: Fixture,
  edit: { chunk?: (c: Chunk) => void; manifest?: (m: Manifest) => void },
): Map<string, Uint8Array> {
  const objects = new Map(f.objects);
  const m = manifestOf(f);
  for (const ref of m.chunks) {
    const c = parse<Chunk>(objects.get(ref.key) ?? new Uint8Array());
    edit.chunk?.(c);
    const bytes = utf8.encode(canonicalJson(c));
    objects.set(ref.key, bytes);
    ref.hash = keccak256(bytes);
  }
  edit.manifest?.(m);
  const bytes = utf8.encode(canonicalJson(m));
  objects.set(manifestKeyOf(f), bytes);
  const hash: Hex = keccak256(bytes);
  if (f.reader.anchorState) f.reader.anchorState = { ...f.reader.anchorState, manifestHash: hash };
  f.reader.proposalLogs = f.reader.proposalLogs.map((p) => ({ ...p, bundleHash: hash }));
  return objects;
}
