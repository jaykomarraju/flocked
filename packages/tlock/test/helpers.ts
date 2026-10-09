// Shared by the Node and Workers projects, so no Node built-ins here.
import { bls12_381 } from '@noble/curves/bls12-381';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import beacons from '../fixtures/quicknet-beacons.json' with { type: 'json' };
import ciphertexts from '../fixtures/quicknet-ciphertexts.json' with { type: 'json' };
import {
  base64Decode,
  base64Encode,
  bytesToLatin1,
  fromBase64Url,
  hexToBytes,
  latin1ToBytes,
} from '../src/encoding.js';
import { encodePlaintext } from '../src/plaintext.js';

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

/** A committed pick as bytes. */
export function fixturePick(round: number): {
  ct: Uint8Array;
  plaintext: Uint8Array;
  roundRef: Uint8Array;
  signature: string;
} {
  const p = PICKS.find((x) => x.round === round);
  const ct = p && fromBase64Url(p.ciphertext);
  if (!p || !ct) throw new Error(`no committed pick for round ${round}`);
  const roundRef = hex(p.roundRef);
  const optionIndex = p.optionIndex as 0 | 1;
  const plaintext = encodePlaintext({ roundRef, optionIndex, nonce: hex(p.nonce) });
  return { ct, plaintext, roundRef, signature: beacon(round).signature };
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

/** The decoded stanza body (U ‖ V ‖ W). */
export function stanzaBody(ct: Uint8Array): Uint8Array {
  const body = base64Decode(splitCt(ct).lines.slice(2, -1).join(''));
  if (!body) throw new Error('bad body');
  return body;
}

/** `ct` with its stanza body replaced and wrapped canonically; the MAC line and payload are kept. */
export function withBody(ct: Uint8Array, body: Uint8Array): Uint8Array {
  const { lines, payload } = splitCt(ct);
  const wrapped: string[] = base64Encode(body).match(/.{1,64}/g) ?? [];
  if ((wrapped.at(-1)?.length ?? 0) === 64) wrapped.push('');
  return joinCt([lines[0] ?? '', lines[1] ?? '', ...wrapped, lines.at(-1) ?? ''], payload);
}

/**
 * `ct` with its header MAC recomputed under `fileKey`, as the ciphertext's author can: age's HMAC-SHA256
 * over the header through `---`, keyed by HKDF-SHA256(fileKey, salt "", info "header").
 */
export function remac(ct: Uint8Array, fileKey: Uint8Array): Uint8Array {
  const { lines, payload } = splitCt(ct);
  const header = latin1ToBytes(`${lines.slice(0, -1).join('\n')}\n---`);
  const mac = hmac(sha256, hkdf(sha256, fileKey, new Uint8Array(0), 'header', 32), header);
  return joinCt([...lines.slice(0, -1), `--- ${base64Encode(mac)}`], payload);
}

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** A valid G2 public key that is not quicknet's: a chain impersonating quicknet's hash. */
export function otherG2PublicKey(): string {
  const p = bls12_381.G2.ProjectivePoint.BASE.multiply(123_456_789n);
  return p.toHex(true);
}
