// Sign-In with Ethereum (EIP-4361) as the API checks it (apps/api/src/auth/siwe.ts): the message
// names this origin's host and URI and the deployment chain, with a single-use nonce from the API.
import type { AuthSessionResponse, SessionTransport } from '@flocked/shared';
import type { Address } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { api, type ApiClient } from '../api/client';
import type { WalletSigner } from './wallet';

export const SIWE_STATEMENT = 'Sign in to Flocked.';

export function siweMessage(opts: {
  address: Address;
  chainId: number;
  nonce: string;
  origin: URL;
  now: Date;
}): string {
  return createSiweMessage({
    domain: opts.origin.host,
    address: opts.address,
    statement: SIWE_STATEMENT,
    uri: opts.origin.origin,
    version: '1',
    chainId: opts.chainId,
    nonce: opts.nonce,
    issuedAt: opts.now,
  });
}

/** Nonce → message → wallet signature → session. */
export async function siweSignIn(opts: {
  client: ApiClient;
  wallet: WalletSigner;
  chainId: number;
  turnstileToken?: string;
  transport?: SessionTransport;
  origin?: URL;
}): Promise<AuthSessionResponse> {
  const { nonce } = await opts.client.call(api.siweNonce);
  const message = siweMessage({
    address: opts.wallet.address,
    chainId: opts.chainId,
    nonce,
    origin: opts.origin ?? new URL(window.location.origin),
    now: new Date(),
  });
  const signature = await opts.wallet.signMessage(message);
  return opts.client.call(api.siweVerify, {
    body: {
      message,
      signature,
      ...(opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
      ...(opts.transport ? { transport: opts.transport } : {}),
    },
  });
}
