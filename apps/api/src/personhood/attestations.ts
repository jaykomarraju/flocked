// Coinbase Verified Account and Verified Country attestations (spec "Identity and personhood" ›
// Personhood › Country): EAS on Base, issued by Coinbase's attester, found through Coinbase's
// attestation indexer (`getAttestationUid(recipient, schemaUid)`), then read from EAS
// (`getAttestation(uid)`) to check the schema, recipient, attester, revocation and expiry.
//
// Results are cached per wallet in `identities.data_json.attestations` (spec "Data model":
// data_json holds attestation UIDs and verified country). `GET /me` accepts a cached result up to
// ATTESTATION_CACHE_MS old; a ticket (W6-B) passes `maxAgeMs: 0` to re-check them unrevoked.
// A failed lookup is never cached, and counts as "no attestation" (fail closed).
import {
  decodeAbiParameters,
  isAddressEqual,
  zeroHash,
  type Address,
  type Client,
  type Hex,
} from 'viem';
import { readContract } from 'viem/actions';
import { log } from '../lib/log.js';
import { attestationNetwork, type AttestationNetwork, type PersonhoodEnv } from './config.js';
import { personhoodDeps } from './deps.js';

/** `GET /me` re-reads a wallet's attestations at most this often. */
export const ATTESTATION_CACHE_MS = 10 * 60 * 1000;

export const INDEXER_ABI = [
  {
    type: 'function',
    name: 'getAttestationUid',
    stateMutability: 'view',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'schemaUid', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

export const EAS_ABI = [
  {
    type: 'function',
    name: 'getAttestation',
    stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'schema', type: 'bytes32' },
          { name: 'time', type: 'uint64' },
          { name: 'expirationTime', type: 'uint64' },
          { name: 'revocationTime', type: 'uint64' },
          { name: 'refUID', type: 'bytes32' },
          { name: 'recipient', type: 'address' },
          { name: 'attester', type: 'address' },
          { name: 'revocable', type: 'bool' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/** One wallet's Coinbase attestations: the UIDs of the valid ones and the attested country. */
export interface WalletAttestations {
  /** Unrevoked, unexpired Verified Account attestation, or null. */
  verifiedAccount: Hex | null;
  /** Unrevoked, unexpired Verified Country attestation, or null. */
  verifiedCountry: Hex | null;
  /** ISO 3166-1 alpha-2 from the Verified Country attestation, or null. */
  country: string | null;
  checkedAt: number;
}

type Kind = 'account' | 'country';

/** The attestation's payload if it is a valid Coinbase attestation of `kind` for `wallet`. */
async function validAttestation(
  rpc: Client,
  net: AttestationNetwork,
  wallet: Address,
  kind: Kind,
  nowSec: bigint,
): Promise<{ uid: Hex; data: Hex } | null> {
  const schema = kind === 'account' ? net.verifiedAccountSchema : net.verifiedCountrySchema;
  const uid = await readContract(rpc, {
    address: net.indexer,
    abi: INDEXER_ABI,
    functionName: 'getAttestationUid',
    args: [wallet, schema],
  });
  if (uid === zeroHash) return null;
  const a = await readContract(rpc, {
    address: net.eas,
    abi: EAS_ABI,
    functionName: 'getAttestation',
    args: [uid],
  });
  const ok =
    a.uid.toLowerCase() === uid.toLowerCase() &&
    a.schema.toLowerCase() === schema.toLowerCase() &&
    isAddressEqual(a.recipient, wallet) &&
    isAddressEqual(a.attester, net.attester) &&
    a.revocationTime === 0n &&
    (a.expirationTime === 0n || a.expirationTime > nowSec);
  return ok ? { uid, data: a.data } : null;
}

function decodeAccount(data: Hex): boolean {
  try {
    return decodeAbiParameters([{ type: 'bool' }], data)[0];
  } catch {
    return false;
  }
}

function decodeCountry(data: Hex): string | null {
  try {
    const country = decodeAbiParameters([{ type: 'string' }], data)[0]
      .trim()
      .toUpperCase();
    return /^[A-Z]{2}$/.test(country) ? country : null;
  } catch {
    return null;
  }
}

/** Reads one wallet's attestations from the chain. Rejects when the RPC fails. */
export async function lookupAttestations(
  env: PersonhoodEnv,
  wallet: Address,
  now: number,
): Promise<WalletAttestations> {
  const net = attestationNetwork(env);
  const rpc = personhoodDeps(env).attestationRpc;
  const nowSec = BigInt(Math.floor(now / 1000));
  const [account, country] = await Promise.all([
    validAttestation(rpc, net, wallet, 'account', nowSec),
    validAttestation(rpc, net, wallet, 'country', nowSec),
  ]);
  const attestedCountry = country ? decodeCountry(country.data) : null;
  return {
    verifiedAccount: account && decodeAccount(account.data) ? account.uid : null,
    verifiedCountry: attestedCountry ? (country?.uid ?? null) : null,
    country: attestedCountry,
    checkedAt: now,
  };
}

interface WalletRow {
  id: string;
  external_id: string;
  data_json: string;
}

function cached(row: WalletRow): WalletAttestations | null {
  try {
    const data = JSON.parse(row.data_json) as { attestations?: WalletAttestations };
    const a = data.attestations;
    return a && typeof a.checkedAt === 'number' ? a : null;
  } catch {
    return null;
  }
}

/**
 * The attestations of every verified wallet linked to `userId`, re-read from the chain when the
 * cached copy is older than `maxAgeMs`. A wallet whose lookup fails is reported with no
 * attestations (and `lookupFailed`), so callers fail closed.
 */
export async function userWalletAttestations(
  env: PersonhoodEnv,
  userId: string,
  now: number,
  maxAgeMs: number = ATTESTATION_CACHE_MS,
): Promise<{ wallet: Address; attestations: WalletAttestations | null }[]> {
  const db = env.DB;
  const { results } = await db
    .prepare(
      "SELECT id, external_id, data_json FROM identities WHERE user_id = ?1 AND provider = 'wallet' " +
        'AND verified_at IS NOT NULL ORDER BY id',
    )
    .bind(userId)
    .all<WalletRow>();
  return Promise.all(
    results.map(async (row) => {
      const wallet = row.external_id as Address;
      const hit = cached(row);
      if (hit && maxAgeMs > 0 && now - hit.checkedAt < maxAgeMs) {
        return { wallet, attestations: hit };
      }
      try {
        const fresh = await lookupAttestations(env, wallet, now);
        await db
          .prepare(
            "UPDATE identities SET data_json = json_set(data_json, '$.attestations', json(?1)) WHERE id = ?2",
          )
          .bind(JSON.stringify(fresh), row.id)
          .run();
        return { wallet, attestations: fresh };
      } catch (err) {
        log.warn('attestation_lookup_failed', {
          identityId: row.id,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
        return { wallet, attestations: null };
      }
    }),
  );
}
