import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage, verifySiweMessage } from 'viem/siwe';
import { createPublicClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api/client';
import { json, ME, SESSION } from '../test/fixtures';
import type { MiniApp } from './miniapp';
import { AuthProvider, useAuth } from './session';
import { SIWE_STATEMENT, siweMessage, siweSignIn } from './siwe';
import { createWagmiConfig } from './wallet';

// anvil's first dev key: a throwaway test key, public in every Foundry install.
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

describe('SIWE', () => {
  it('builds a message the API parses: this origin, the chain, the nonce, the statement', async () => {
    const origin = new URL('http://localhost:8787');
    const message = siweMessage({
      address: account.address,
      chainId: 31337,
      nonce: 'abcdef0123456789abcdef0123456789',
      origin,
      now: new Date('2026-10-13T12:00:00Z'),
    });
    const parsed = parseSiweMessage(message);
    expect(parsed).toMatchObject({
      domain: 'localhost:8787',
      uri: 'http://localhost:8787',
      chainId: 31337,
      nonce: 'abcdef0123456789abcdef0123456789',
      statement: SIWE_STATEMENT,
      version: '1',
    });
    expect(parsed.address?.toLowerCase()).toBe(account.address.toLowerCase());
    const signature = await account.signMessage({ message });
    // The API's own check, minus the chain call an EOA doesn't need.
    const client = createPublicClient({ chain: foundry, transport: http('http://127.0.0.1:1') });
    await expect(
      verifySiweMessage(client, {
        message,
        signature,
        domain: 'localhost:8787',
        time: new Date('2026-10-13T12:01:00Z'),
      }),
    ).resolves.toBe(true);
  });

  it('asks for a nonce, signs, and posts the message, signature, Turnstile token and transport', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(200, { nonce: 'abcdef0123456789abcdef0123456789', expiresAt: SESSION.expiresAt }),
      )
      .mockResolvedValueOnce(json(200, { ...SESSION, token: null }));
    const client = createApiClient({ origin: 'http://localhost:8787', fetch });
    const session = await siweSignIn({
      client,
      wallet: {
        address: account.address,
        signMessage: (message) => account.signMessage({ message }),
      },
      chainId: 31337,
      turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
      transport: 'cookie',
      origin: new URL('http://localhost:8787'),
    });
    expect(session.user.handle).toBe('woolly');
    const body = JSON.parse(fetch.mock.calls[1]![1]?.body as string) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual([
      'message',
      'signature',
      'transport',
      'turnstileToken',
    ]);
    expect(parseSiweMessage(body.message!).nonce).toBe('abcdef0123456789abcdef0123456789');
  });
});

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <p>status: {auth.status}</p>
      <p>handle: {auth.me?.user.handle ?? 'none'}</p>
      <button onClick={() => void auth.verifyEmail('wool@flocked.test', '12345678')}>email</button>
      <button onClick={() => void auth.signInWithFarcaster()}>farcaster</button>
      <button onClick={() => void auth.signOut()}>out</button>
    </div>
  );
}

const wagmiConfig = createWagmiConfig();

describe('AuthProvider', () => {
  it('starts signed out when /me answers 401, and signs in with an email code (cookie)', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'Sign in' } }))
      .mockResolvedValueOnce(json(200, { ...SESSION, token: null }))
      .mockResolvedValueOnce(json(200, ME));
    render(
      <AuthProvider wagmiConfig={wagmiConfig} fetch={fetch} origin="http://app.test">
        <Probe />
      </AuthProvider>,
    );
    await screen.findByText('status: signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'email' }));
    await screen.findByText('status: signed-in');
    expect(screen.getByText('handle: woolly')).toBeInTheDocument();
    const verify = fetch.mock.calls[1]!;
    expect((verify[0] as URL).pathname).toBe('/api/v1/auth/email/verify');
    expect(JSON.parse(verify[1]?.body as string)).toEqual({
      email: 'wool@flocked.test',
      code: '12345678',
      transport: 'cookie',
    });
  });

  it('in the mini app, exchanges a Quick Auth token for a Bearer session and sends it', async () => {
    sessionStorage.clear();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'Sign in' } }))
      .mockResolvedValueOnce(json(200, { ...SESSION, token: 'bearer-token' }))
      .mockResolvedValueOnce(json(200, ME))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const miniApp: MiniApp = {
      user: { fid: 3, username: 'jay' },
      quickAuthToken: () => Promise.resolve('quick-auth-jwt'),
      ethereumProvider: () => Promise.resolve(undefined),
    openExternal: () => Promise.resolve(),
    };
    render(
      <AuthProvider
        wagmiConfig={wagmiConfig}
        fetch={fetch}
        origin="http://app.test"
        miniApp={miniApp}
      >
        <Probe />
      </AuthProvider>,
    );
    await screen.findByText('status: signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'farcaster' }));
    await screen.findByText('status: signed-in');
    expect(JSON.parse(fetch.mock.calls[1]![1]?.body as string)).toEqual({
      token: 'quick-auth-jwt',
      transport: 'bearer',
    });
    expect(sessionStorage.getItem('flocked.session')).toBe('bearer-token');
    // GET /me after sign-in carries the Bearer token.
    const meCall = fetch.mock.calls[2]![1];
    expect((meCall?.headers as Record<string, string>).authorization).toBe('Bearer bearer-token');
    await userEvent.click(screen.getByRole('button', { name: 'out' }));
    await waitFor(() => expect(sessionStorage.getItem('flocked.session')).toBeNull());
    await screen.findByText('status: signed-out');
  });
});
