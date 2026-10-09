// Encryption and decryption on tlock-js's IBE and age layers, with no drand network client.
//
// tlock-js's `timelockDecrypt` fetches the beacon itself (and checks the wall clock), so settlement
// cannot use it: every ciphertext must be opened with the one signature `verifyBeacon` accepted.
// Instead this module calls tlock-js's age layer (`encryptAge`/`decryptAge`) with its own stanza
// wrappers: encryption uses tlock-js's `createTimelockEncrypter` against an offline chain client that
// only serves the pinned chain info; decryption parses the stanza body and calls tlock-js's
// `decryptOnG2` with the given signature as the IBE private key.
import { bls12_381 } from '@noble/curves/bls12-381';
import type { ChainClient, ChainInfo } from 'tlock-js';
import type { Stanza } from 'tlock-js/age/age-encrypt-decrypt.js';
import { decryptAge, encryptAge } from 'tlock-js/age/age-encrypt-decrypt.js';
import { decryptOnG2 } from 'tlock-js/crypto/ibe.js';
import { createTimelockEncrypter } from 'tlock-js/drand/timelock-encrypter.js';
import { SIGNATURE_BYTES } from './beacon.js';
import type { DrandChain } from './chains.js';
import { bytesToHex, bytesToLatin1, fromBase64Url, hexToBytes, latin1ToBytes } from './encoding.js';
import type { ParsedHeader } from './header.js';
import { parseHeader } from './header.js';
import { PLAINTEXT_LENGTH } from './plaintext.js';

/** Stanza body for G1 signatures: U (compressed G2, 96) ‖ V (16) ‖ W (16). */
const U_BYTES = 96;
const BODY_BYTES = U_BYTES + 16 + 16;
/** age payload: a 16-byte HKDF nonce, then at least one STREAM chunk with its 16-byte tag. */
const MIN_PAYLOAD = 16 + 16;

function offlineClient(chain: DrandChain): ChainClient {
  const info = {
    public_key: chain.publicKey,
    period: chain.period,
    genesis_time: chain.genesis,
    hash: chain.chainHash,
    schemeID: chain.scheme,
  } as ChainInfo;
  const offline = {
    chain: () => ({ info: () => Promise.resolve(info) }),
    get: () => Promise.reject(new Error('offline chain client')),
    latest: () => Promise.reject(new Error('offline chain client')),
  };
  return offline as unknown as ChainClient;
}

/** Encrypts any bytes to `beaconRound`. Exported for tests that need malformed plaintexts. */
export async function sealBytes(
  chain: DrandChain,
  beaconRound: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(beaconRound) || beaconRound < 1) {
    throw new RangeError('beaconRound must be ≥ 1');
  }
  const age = await encryptAge(
    plaintext,
    createTimelockEncrypter(offlineClient(chain), beaconRound),
  );
  return latin1ToBytes(age);
}

/**
 * Encrypts a pick plaintext to `beaconRound` as a binary (non-armored) age file. Refuses anything but
 * 34 bytes, so the ciphertext length never depends on the pick.
 */
export async function encryptPick(
  chain: DrandChain,
  beaconRound: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (plaintext.length !== PLAINTEXT_LENGTH) {
    throw new RangeError(`plaintext must be ${PLAINTEXT_LENGTH} bytes`);
  }
  return sealBytes(chain, beaconRound, plaintext);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, k) => x === b[k]);
}

/**
 * Throws unless U is the canonical compressed encoding of a G2 point other than infinity. noble's
 * `fromHex` reduces each coordinate mod p, so a U with p added to a coordinate decodes to the same point
 * and would still open: re-encoding and comparing byte for byte rejects it. Infinity is canonical but
 * can never be rP (tlock-js's pairing rejects it too; this names the reason).
 */
function assertCanonicalU(U: Uint8Array): void {
  const G2 = bls12_381.G2.ProjectivePoint;
  const point = G2.fromHex(U);
  if (point.equals(G2.ZERO)) throw new Error('U is the point at infinity');
  if (!sameBytes(point.toRawBytes(true), U)) throw new Error('U is not a canonical G2 encoding');
}

/** Decrypts a parsed canonical ciphertext with signature bytes. Throws on any failure. */
export async function openParsed(
  ct: Uint8Array,
  h: ParsedHeader,
  sig: Uint8Array,
): Promise<Uint8Array> {
  if (h.body.length !== BODY_BYTES) throw new Error('stanza body has the wrong length');
  const text = bytesToLatin1(ct);
  const payloadStart = text.indexOf('\n', text.indexOf('\n--- ') + 1) + 1;
  if (ct.length - payloadStart < MIN_PAYLOAD) throw new Error('payload too short');
  const U = h.body.subarray(0, U_BYTES);
  assertCanonicalU(U);
  const unwrap = (recipients: Stanza[]): Promise<Uint8Array> => {
    if (recipients.length !== 1) throw new Error('expected exactly one stanza');
    return decryptOnG2(sig, {
      U,
      V: h.body.subarray(U_BYTES, U_BYTES + 16),
      W: h.body.subarray(U_BYTES + 16),
    });
  };
  return Uint8Array.from(await decryptAge(text, unwrap));
}

/**
 * Decrypts `ct` with a beacon signature the caller has already checked with `verifyBeacon`. The
 * header must be canonical and name `chain`; a signature for any other round fails the IBE check.
 * Throws on any failure. Never contacts drand.
 */
export async function decryptWithSignature(
  chain: DrandChain,
  ct: Uint8Array,
  signature: string,
): Promise<Uint8Array> {
  const h = parseHeader(ct);
  if (!h) throw new Error('ciphertext header is not canonical');
  if (h.chainHash !== chain.chainHash) throw new Error('ciphertext targets another chain');
  const sig = hexToBytes(signature, SIGNATURE_BYTES);
  if (!sig) throw new Error(`signature must be ${SIGNATURE_BYTES * 2} hex chars`);
  return openParsed(ct, h, sig);
}

/**
 * A known-good case for `selfTest`: the round 32 870 075 pick from `fixtures/quicknet-ciphertexts.json`
 * and that round's signature from `fixtures/quicknet-beacons.json`, copied here because the fixtures are
 * not part of the package (and a Worker bundle should not carry them). `test/environment.test.ts` checks
 * the copy against the files.
 */
export const SELF_TEST_CASE = {
  round: 32_870_075,
  signature:
    '85c653c4e0099d069e9f7f525d14239c5f2ffa496f02ad5daf4e4e240de575261d5248172ad543b351b236c838853d8e',
  /** Unpadded base64url, as in the fixture. */
  ciphertext: [
    'YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0-IHRsb2NrIDMyODcwMDc1IDUyZGI5YmE3MGUwY2MwZjZlYWY3',
    'ODAzZGQwNzQ0N2ExZjU0Nzc3MzVmZDNmNjYxNzkyYmE5NDYwMGM4NGU5NzEKcGZVMmVrQ2hHb2dGNGl3',
    'ZVJvRi9wZVF2QThHaTZ6SjRyb0hEYlNTcGlCU2VUVlF3Qm9ndjJmNHhsODlBY0dVawpFZzZXY09mWlR5',
    'ZWZWVk9GMmRmWUFkZlBPZFF4WWFpUjFDTTlNWnFVN1ppVXdTUmhRMVYxSFV2eHcyRHdHeFZGCm5URU5P',
    'Ulh2SDE0WmhYQk8zYlRyYmZwc2ZtOG1la29HcWxvZjh0WUtBUnMKLS0tIEFka05xV2ZycXpsNWZjWVRr',
    'YXV4NVhDRmNBWHA5ek9vYjM3Q05UVmlMd0kKARtpADo1R_d8FObUAhroK8uH7hpeyIEx9utxkBnPxaWL',
    'PYK2JMEIj04ZGUDzU2bjPT3xYo5EPHWnXS4S_VvjXP51',
  ].join(''),
  /** The 34-byte plaintext, hex. */
  plaintext: '01000000000000000000000000000003ee00d1cb04d9c456e5161a03bf6de4437e39',
} as const;

/**
 * Opens `SELF_TEST_CASE` through `parseHeader` and `openParsed`, the path `classify` uses, and checks the
 * plaintext. Throws if this runtime cannot: a broken runtime must fail loudly, not VOID every entry.
 */
export async function selfTest(): Promise<void> {
  const c = SELF_TEST_CASE;
  const ct = fromBase64Url(c.ciphertext);
  const h = ct && parseHeader(ct);
  const sig = hexToBytes(c.signature, SIGNATURE_BYTES);
  if (!ct || !h || !sig) {
    throw new Error('tlock self-test failed: the embedded case does not parse');
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await openParsed(ct, h, sig);
  } catch (cause) {
    throw new Error('tlock self-test failed: the embedded ciphertext does not open', { cause });
  }
  if (bytesToHex(plaintext) !== c.plaintext) {
    throw new Error('tlock self-test failed: the embedded ciphertext opens to the wrong plaintext');
  }
}
