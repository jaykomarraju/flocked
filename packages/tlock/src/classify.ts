// VOID classification of one ciphertext (spec: "Sealed picks" › Invalid entries).
import type { VoidReason } from '@flocked/settle';
import { SIGNATURE_BYTES, verifyBeaconCached } from './beacon.js';
import type { DrandChain } from './chains.js';
import { hexToBytes } from './encoding.js';
import { parseHeader } from './header.js';
import { PLAINTEXT_VERSION, decodePlaintext } from './plaintext.js';
import { openParsed } from './seal.js';

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, k) => x === b[k]);
}

/**
 * Decides whether a ciphertext is a valid pick for the round, and if not, which VOID reason applies.
 * Checks run in order and the first failure wins:
 * 1. `non_canonical_header`: the age header is not one canonical tlock stanza (see `parseHeader`);
 * 2. `wrong_target`: the stanza names another round or another chain hash;
 * 3. `decrypt_failed`: the stanza body, header MAC or payload does not open with the signature;
 * 4. `bad_plaintext`: not 34 bytes, version not 0x01, or a round reference other than `roundRef`;
 * 5. `bad_option`: `optionIndex` is neither 0 nor 1.
 *
 * It never throws for a bad ciphertext. It throws when `signature` fails `verifyBeacon` for
 * `beaconRound` (a bad signature must never produce VOIDs) and when `roundRef` is not 16 bytes.
 */
export async function classify(i: {
  ct: Uint8Array;
  chain: DrandChain;
  beaconRound: number;
  signature: string;
  roundRef: Uint8Array;
}): Promise<
  { valid: true; optionIndex: 0 | 1; nonce: Uint8Array } | { valid: false; voidReason: VoidReason }
> {
  if (!verifyBeaconCached(i.chain, i.beaconRound, i.signature)) {
    throw new Error(`beacon signature failed verification for round ${i.beaconRound}`);
  }
  if (i.roundRef.length !== 16) throw new RangeError('roundRef must be 16 bytes');
  const sig = hexToBytes(i.signature, SIGNATURE_BYTES);
  if (!sig) throw new Error('unreachable: a verified signature is well-formed');
  const invalid = (voidReason: VoidReason) => ({ valid: false as const, voidReason });

  const h = parseHeader(i.ct);
  if (!h) return invalid('non_canonical_header');
  if (h.round !== String(i.beaconRound) || h.chainHash !== i.chain.chainHash) {
    return invalid('wrong_target');
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await openParsed(i.ct, h, sig);
  } catch {
    return invalid('decrypt_failed');
  }
  const p = decodePlaintext(plaintext);
  if (!p || p.version !== PLAINTEXT_VERSION || !sameBytes(p.roundRef, i.roundRef)) {
    return invalid('bad_plaintext');
  }
  if (p.optionIndex !== 0 && p.optionIndex !== 1) return invalid('bad_option');
  return { valid: true, optionIndex: p.optionIndex, nonce: p.nonce };
}
