// Shared by the Node and Workers projects, so no Node built-ins here.
import { bls12_381 } from '@noble/curves/bls12-381';
import beacons from '../fixtures/quicknet-beacons.json' with { type: 'json' };
import ciphertexts from '../fixtures/quicknet-ciphertexts.json' with { type: 'json' };
import { bytesToLatin1, hexToBytes, latin1ToBytes } from '../src/encoding.js';

export interface RecordedBeacon {
  round: number;
  randomness: string;
  signature: string;
  source: string;
}
export const BEACONS: RecordedBeacon[] = beacons.beacons;
export const PICKS = ciphertexts.picks;

export function beacon(round: number): RecordedBeacon {
  const b = BEACONS.find((x) => x.round === round);
  if (!b) throw new Error(`no recorded beacon for round ${round}`);
  return b;
}

export function hex(s: string): Uint8Array {
  const b = hexToBytes(s, s.length / 2);
  if (!b) throw new Error('bad hex');
  return b;
}

/** Flips one bit of a hex string's bytes. */
export function flipBit(hexSig: string, bit: number): string {
  const b = hex(hexSig);
  b[bit >> 3] = (b[bit >> 3] ?? 0) ^ (0x80 >> (bit & 7));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A ciphertext as its header lines (version through MAC line) and binary payload. */
export function splitCt(ct: Uint8Array): { lines: string[]; payload: Uint8Array } {
  const text = bytesToLatin1(ct);
  const macAt = text.indexOf('\n--- ') + 1;
  const end = text.indexOf('\n', macAt) + 1;
  return { lines: text.slice(0, end - 1).split('\n'), payload: ct.slice(end) };
}

export function joinCt(lines: string[], payload: Uint8Array): Uint8Array {
  const head = latin1ToBytes(`${lines.join('\n')}\n`);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head);
  out.set(payload, head.length);
  return out;
}

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** A valid G2 public key that is not quicknet's: a chain impersonating quicknet's hash. */
export function otherG2PublicKey(): string {
  const p = bls12_381.G2.ProjectivePoint.BASE.multiply(123_456_789n);
  return p.toHex(true);
}
