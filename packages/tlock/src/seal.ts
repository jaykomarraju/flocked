// Encryption and decryption on tlock-js's IBE and age layers, with no drand network client.
//
// tlock-js's `timelockDecrypt` fetches the beacon itself (and checks the wall clock), so settlement
// cannot use it: every ciphertext must be opened with the one signature `verifyBeacon` accepted.
// Instead this module calls tlock-js's age layer (`encryptAge`/`decryptAge`) with its own stanza
// wrappers: encryption uses tlock-js's `createTimelockEncrypter` against an offline chain client that
// only serves the pinned chain info; decryption parses the stanza body and calls tlock-js's
// `decryptOnG2` with the given signature as the IBE private key.
import type { ChainClient, ChainInfo } from 'tlock-js';
import type { Stanza } from 'tlock-js/age/age-encrypt-decrypt.js';
import { decryptAge, encryptAge } from 'tlock-js/age/age-encrypt-decrypt.js';
import { decryptOnG2 } from 'tlock-js/crypto/ibe.js';
import { createTimelockEncrypter } from 'tlock-js/drand/timelock-encrypter.js';
import { SIGNATURE_BYTES } from './beacon.js';
import type { DrandChain } from './chains.js';
import { bytesToLatin1, hexToBytes, latin1ToBytes } from './encoding.js';
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

/** Decrypts a parsed canonical ciphertext with signature bytes. Throws on any failure. */
export async function openParsed(
  ct: Uint8Array,
  h: ParsedHeader,
  sig: Uint8Array,
): Promise<Uint8Array> {
  if (h.body.length !== BODY_BYTES) throw new Error('stanza body has the wrong length');
  const unwrap = (recipients: Stanza[]): Promise<Uint8Array> => {
    if (recipients.length !== 1) throw new Error('expected exactly one stanza');
    return decryptOnG2(sig, {
      U: h.body.subarray(0, U_BYTES),
      V: h.body.subarray(U_BYTES, U_BYTES + 16),
      W: h.body.subarray(U_BYTES + 16),
    });
  };
  const text = bytesToLatin1(ct);
  const payloadStart = text.indexOf('\n', text.indexOf('\n--- ') + 1) + 1;
  if (ct.length - payloadStart < MIN_PAYLOAD) throw new Error('payload too short');
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
