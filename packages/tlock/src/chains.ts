// The only place drand chain constants live (plan.md 4.4). Everything else takes a `DrandChain`.

export interface DrandChain {
  /** 64 lowercase hex chars: the drand chain hash, also the second tlock stanza argument. */
  chainHash: string;
  /** 192 lowercase hex chars: the compressed G2 group public key. */
  publicKey: string;
  scheme: 'bls-unchained-g1-rfc9380';
  /** Unix seconds of round 1. */
  genesis: number;
  /** Seconds between rounds. */
  period: number;
}

/** drand quicknet (mainnet), as served by https://api.drand.sh/<chainHash>/info. */
export const QUICKNET: DrandChain = Object.freeze({
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  scheme: 'bls-unchained-g1-rfc9380',
  genesis: 1692803367,
  period: 3,
});

const HASH_RE = /^[0-9a-f]{64}$/;
const PUBLIC_KEY_RE = /^[0-9a-f]{192}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

function decimal(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!DECIMAL_RE.test(value) || !Number.isSafeInteger(n) || n < min) {
    throw new RangeError(`${name} must be a decimal integer ≥ ${min}`);
  }
  return n;
}

/**
 * The chain from `DRAND_CHAIN_HASH`, `DRAND_PUBLIC_KEY`, `DRAND_GENESIS` and `DRAND_PERIOD` (a local
 * drand network in dev and e2e). With none set it returns `QUICKNET`. Setting only some of them, or
 * any malformed value, throws: a half-overridden chain must never reach encryption or settlement.
 */
export function chainFromEnv(env: Record<string, string | undefined>): DrandChain {
  const keys = ['DRAND_CHAIN_HASH', 'DRAND_PUBLIC_KEY', 'DRAND_GENESIS', 'DRAND_PERIOD'] as const;
  const [chainHash, publicKey, genesis, period] = keys.map((k) => env[k]);
  if (keys.every((k) => env[k] === undefined || env[k] === '')) return QUICKNET;
  if (!chainHash || !publicKey || !genesis || !period) {
    throw new Error(`set all of ${keys.join(', ')} or none of them`);
  }
  if (!HASH_RE.test(chainHash)) {
    throw new RangeError('DRAND_CHAIN_HASH must be 64 lowercase hex chars');
  }
  if (!PUBLIC_KEY_RE.test(publicKey)) {
    throw new RangeError('DRAND_PUBLIC_KEY must be 192 lowercase hex chars (compressed G2)');
  }
  return Object.freeze({
    chainHash,
    publicKey,
    scheme: 'bls-unchained-g1-rfc9380',
    genesis: decimal('DRAND_GENESIS', genesis, 0),
    period: decimal('DRAND_PERIOD', period, 1),
  });
}
