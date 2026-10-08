// Sign-In with Ethereum (EIP-4361). Nonces are single use: issued into KV as a hash with a 5-minute
// TTL and consumed by AuthDO before the signature is checked, so a message can never be replayed
// (spec "Data model"). The message must name this app's domain and URI origin and the deployment
// chain. Signatures go through viem's verifySiweMessage, which ecrecovers EOA signatures and asks
// the chain for ERC-1271 (deployed smart wallets) and ERC-6492 (not yet deployed Coinbase Smart
// Wallets, through the universal validator in an eth_call).
import type { SiweNonceResponse } from '@flocked/shared';
import { getAddress, type Hex } from 'viem';
import { parseSiweMessage, validateSiweMessage, verifySiweMessage } from 'viem/siwe';
import { AUTH_SECRET_TTL_MS, authDOFor, nonceKvKey, type NonceRecord } from '../do/auth-do.js';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { appOrigin } from './config.js';
import { randomHex, sha256Hex } from './crypto.js';
import type { AuthDeps } from './deps.js';

export async function nonceHash(nonce: string): Promise<string> {
  return sha256Hex(`siwe-nonce:${nonce}`);
}

/** Issues a nonce: 128 random bits as 32 hex characters (EIP-4361 wants ≥ 8 alphanumerics). */
export async function issueNonce(env: Pick<Env, 'KV' | 'ENVIRONMENT' | 'FLOCKED_TEST_CLOCK'>) {
  const nonce = randomHex(16);
  const expiresAt = now(env) + AUTH_SECRET_TTL_MS;
  const record: NonceRecord = { expiresAt };
  await env.KV.put(nonceKvKey(await nonceHash(nonce)), JSON.stringify(record), {
    expirationTtl: AUTH_SECRET_TTL_MS / 1000,
  });
  return { nonce, expiresAt } satisfies SiweNonceResponse;
}

const invalid = (message: string) => new HttpError('invalid_signature', message);

/**
 * Verifies a signed SIWE message and returns the lowercase signer address. Throws 401
 * `invalid_signature` (malformed, wrong domain, URI or chain, outside its validity window, bad
 * signature), 401 `invalid_nonce` (unknown, expired or already used), or 503 `unavailable` when
 * the chain RPC fails while checking a smart-wallet signature.
 */
export async function verifySiwe(
  env: Env,
  deps: Pick<AuthDeps, 'rpc'>,
  input: { message: string; signature: string },
): Promise<Hex> {
  const { origin, host } = appOrigin(env);
  const parsed = parseSiweMessage(input.message);
  if (!parsed.address || !parsed.nonce || !parsed.domain || !parsed.uri || !parsed.chainId) {
    throw invalid('Malformed SIWE message');
  }
  if (parsed.domain !== host) throw invalid('SIWE domain does not match this app');
  let uriOrigin: string | null = null;
  try {
    uriOrigin = new URL(parsed.uri).origin;
  } catch {
    // Reported below.
  }
  if (uriOrigin !== origin) throw invalid('SIWE URI does not match this app');
  if (parsed.chainId !== Number(env.CHAIN_ID)) throw invalid('SIWE chain ID is not this chain');
  const time = new Date(now(env));
  if (!validateSiweMessage({ message: parsed, domain: host, time })) {
    throw invalid('SIWE message is outside its validity window');
  }

  const hash = await nonceHash(parsed.nonce);
  const consumed = await authDOFor(env, 'nonce', hash).consumeNonce(hash);
  if (!consumed.ok) throw new HttpError('invalid_nonce', `SIWE nonce ${consumed.reason}`);

  let valid: boolean;
  try {
    valid = await verifySiweMessage(deps.rpc, {
      message: input.message,
      signature: input.signature as Hex,
      domain: host,
      nonce: parsed.nonce,
      time,
    });
  } catch (err) {
    log.error('siwe_verify_failed', {
      chainId: parsed.chainId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new HttpError('unavailable', 'Could not check the wallet signature; try again');
  }
  if (!valid) throw invalid('Signature does not match the SIWE message');
  return getAddress(parsed.address).toLowerCase() as Hex;
}
