import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from './encoding.js';

/** keccak256 of the binary ciphertext: the value receipts sign and the Free Merkle leaves commit. */
export function commitment(ct: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(keccak_256(ct))}`;
}
