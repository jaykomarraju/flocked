// Coinbase Verified Account and Verified Country attestations, read by the watcher itself (EAS on
// Base, found through Coinbase's attestation indexer). apps/api reads the same attestations, but the
// watcher cannot use its code or its cache: the point of this check is that it depends on nothing
// the backend says (spec "Smart contract" › Challenge window, watcher and guardian).
//
// Constants from github.com/coinbase/verifications, as apps/api/src/personhood/config.ts has them.
import {
  createPublicClient,
  decodeAbiParameters,
  http,
  isAddressEqual,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

export interface AttestationNetwork {
  name: 'base' | 'base-sepolia';
  chainId: number;
  eas: Address;
  indexer: Address;
  attester: Address;
  verifiedAccountSchema: Hex;
  verifiedCountrySchema: Hex;
}

export const ATTESTATION_NETWORKS: Record<AttestationNetwork['name'], AttestationNetwork> = {
  base: {
    name: 'base',
    chainId: 8453,
    eas: '0x4200000000000000000000000000000000000021',
    indexer: '0x2c7eE1E5f416dfF40054c27A62f7B357C4E8619C',
    attester: '0x357458739F90461b99789350868CD7CF330Dd7EE',
    verifiedAccountSchema: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
    verifiedCountrySchema: '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065',
  },
  'base-sepolia': {
    name: 'base-sepolia',
    chainId: 84532,
    eas: '0x4200000000000000000000000000000000000021',
    indexer: '0xd147a19c3B085Fb9B0c15D2EAAFC6CB086ea849B',
    attester: '0xB5644397a9733f86Cacd928478B29b4cD6041C45',
    verifiedAccountSchema: '0x2f34a2ffe5f87b2f45fbc7c784896b768d77261e2f24f77341ae43751c765a69',
    verifiedCountrySchema: '0xef54ae90f47a187acc050ce631c55584fd4273c0ca9456ab21750921c3a84028',
  },
};

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

/** One wallet's Coinbase attestations, as the watcher read them. */
export interface WalletAttestations {
  /** An unrevoked, unexpired Verified Account attestation from Coinbase's attester. */
  verifiedAccount: boolean;
  /** ISO 3166-1 alpha-2 from an unrevoked, unexpired Verified Country attestation, else null. */
  country: string | null;
}

/** Reads one wallet's attestations. Rejects when the RPC fails, so the caller reports `unable`. */
export type AttestationReader = (wallet: Address, nowSec: bigint) => Promise<WalletAttestations>;

function decodeCountry(data: Hex): string | null {
  try {
    const c = decodeAbiParameters([{ type: 'string' }], data)[0]
      .trim()
      .toUpperCase();
    return /^[A-Z]{2}$/.test(c) ? c : null;
  } catch {
    return null;
  }
}

function decodeAccount(data: Hex): boolean {
  try {
    return decodeAbiParameters([{ type: 'bool' }], data)[0];
  } catch {
    return false;
  }
}

export function attestationReader(i: {
  rpcUrl: string;
  network: AttestationNetwork;
  client?: PublicClient;
}): AttestationReader {
  const client: PublicClient = i.client ?? createPublicClient({ transport: http(i.rpcUrl) });
  const net = i.network;

  const valid = async (
    wallet: Address,
    schema: Hex,
    nowSec: bigint,
  ): Promise<{ data: Hex } | null> => {
    const uid: Hex = await client.readContract({
      address: net.indexer,
      abi: INDEXER_ABI,
      functionName: 'getAttestationUid',
      args: [wallet, schema],
    });
    if (uid === zeroHash) return null;
    const a = await client.readContract({
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
    return ok ? { data: a.data } : null;
  };

  return async (wallet, nowSec) => {
    const [account, country] = await Promise.all([
      valid(wallet, net.verifiedAccountSchema, nowSec),
      valid(wallet, net.verifiedCountrySchema, nowSec),
    ]);
    return {
      verifiedAccount: account !== null && decodeAccount(account.data),
      country: country ? decodeCountry(country.data) : null,
    };
  };
}
