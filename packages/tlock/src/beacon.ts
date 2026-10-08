// BLS verification of a drand beacon signature against the pinned chain (spec: "Sealed picks" › Scheme).
import { bls12_381 } from '@noble/curves/bls12-381';
import { sha256 } from '@noble/hashes/sha2';
import type { DrandChain } from './chains.js';
import { hexToBytes } from './encoding.js';

/** RFC 9380 hash-to-G1 domain for the `bls-unchained-g1-rfc9380` scheme (quicknet). */
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
/** A compressed G1 signature. */
export const SIGNATURE_BYTES = 48;

/** The unchained beacon message: sha256 of the round as a big-endian uint64. */
function roundMessage(round: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(round));
  return sha256(b);
}

/**
 * True when `signature` (96 hex chars) is the chain's BLS signature for exactly `round`. Returns false,
 * never throws, for a malformed signature, a point off the curve or a round < 1.
 */
export function verifyBeacon(chain: DrandChain, round: number, signature: string): boolean {
  if (chain.scheme !== 'bls-unchained-g1-rfc9380') return false;
  if (!Number.isSafeInteger(round) || round < 1) return false;
  const sig = hexToBytes(signature, SIGNATURE_BYTES);
  if (!sig) return false;
  try {
    return bls12_381.verifyShortSignature(sig, roundMessage(round), chain.publicKey, { DST });
  } catch {
    return false;
  }
}

// Settlement verifies one signature and then classifies thousands of ciphertexts with it. Remembering
// the few (chain, round, signature) triples that passed keeps classify at one pairing per entry.
const verified = new Set<string>();

export function verifyBeaconCached(chain: DrandChain, round: number, signature: string): boolean {
  const key = `${chain.chainHash}:${chain.publicKey}:${round}:${signature.toLowerCase()}`;
  if (verified.has(key)) return true;
  if (!verifyBeacon(chain, round, signature)) return false;
  if (verified.size >= 64) verified.clear();
  verified.add(key);
  return true;
}
