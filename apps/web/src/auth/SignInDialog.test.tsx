// The sign-in dialog over the real session (AuthProvider) and a fake API: the wallet's connector and
// the browser Farcaster relay are the only stand-ins.
import { VOICE } from '@flocked/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { parseSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { json, ME, SESSION } from '../test/fixtures';
import { startBrowserFarcaster } from './farcaster-browser';
import type { MiniApp } from './miniapp';
import { AuthProvider, useAuth } from './session';
import { SignInDialog, isUserCancel, signInErrorMessage } from './SignInDialog';
import type * as WalletModule from './wallet';
import { connectWallet, createWagmiConfig } from './wallet';

vi.mock('./wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof WalletModule>()),
  connectWallet: vi.fn(),
}));
vi.mock('./farcaster-browser', () => ({ startBrowserFarcaster: vi.fn() }));

// anvil's first dev key: a throwaway test key, public in every Foundry install.
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const wagmiConfig = createWagmiConfig();
const UNAUTHORIZED = { error: { code: 'unauthorized', message: 'Sign in' } };

/** A fake API: `/me` answers 401 until a sign-in route answers a session; `routes` answer the rest. */
function fakeApi(routes: Record<string, (body: Record<string, unknown>) => Response>) {
  let signedIn = false;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url =
      input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ path, body });
    if (path === '/me') return Promise.resolve(signedIn ? json(200, ME) : json(401, UNAUTHORIZED));
    const route = routes[path];
    if (!route) return Promise.resolve(json(404, { error: { code: 'not_found', message: path } }));
    const res = route(body);
    if (res.ok && path !== '/auth/email/start' && path !== '/auth/siwe/nonce') signedIn = true;
    return Promise.resolve(res);
  });
  return { fetch, calls, bodyOf: (path: string) => calls.find((c) => c.path === path)?.body };
}

function Status() {
  const { status } = useAuth();
  return <p>status: {status}</p>;
}

/** The dialog as the shell drives it: open, closed by `onClose`, and a button to open it again. */
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Status />
      <button onClick={() => setOpen(true)}>Open sign-in</button>
      <SignInDialog
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      />
    </>
  );
}

function setup(routes: Parameters<typeof fakeApi>[0] = {}, miniApp: MiniApp | null = null) {
  const api = fakeApi(routes);
  const onClose = vi.fn();
  render(
    <AuthProvider
      wagmiConfig={wagmiConfig}
      fetch={api.fetch}
      origin="http://app.test"
      miniApp={miniApp}
    >
      <Harness onClose={onClose} />
    </AuthProvider>,
  );
  return { ...api, onClose };
}

const SIWE_ROUTES = {
  '/auth/siwe/nonce': () =>
    json(200, { nonce: 'abcdef0123456789abcdef0123456789', expiresAt: SESSION.expiresAt }),
  '/auth/siwe/verify': () => json(200, { ...SESSION, created: true }),
};

const EMAIL_ROUTES = {
  '/auth/email/start': () => json(200, { ok: true }),
  '/auth/email/verify': (body: Record<string, unknown>) =>
    body.code === '12345678'
      ? json(200, SESSION)
      : json(401, { error: { code: 'invalid_code', message: 'Wrong code; 4 attempts left' } }),
};

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(connectWallet).mockResolvedValue({
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
  });
});

afterEach(() => {
  vi.mocked(connectWallet).mockReset();
  vi.mocked(startBrowserFarcaster).mockReset();
});

describe('SignInDialog', () => {
  it('opens on the providers, as a dialog named by its title', async () => {
    setup();
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to Flocked' });
    expect(within(dialog).getByRole('button', { name: 'Continue with Farcaster' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Connect a wallet' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Email me a code' })).toBeVisible();
    expect(within(dialog).getByText(/Email works once it's linked to an account\./)).toBeVisible();
  });

  it('a wallet signs in with SIWE and the dialog closes', async () => {
    const { bodyOf, onClose } = setup(SIWE_ROUTES);
    await screen.findByText('status: signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'Connect a wallet' }));
    await screen.findByText('status: signed-in');
    expect(connectWallet).toHaveBeenCalledOnce();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const verify = bodyOf('/auth/siwe/verify')!;
    expect(parseSiweMessage(verify.message as string).nonce).toBe(
      'abcdef0123456789abcdef0123456789',
    );
    expect(verify.transport).toBe('cookie');
  });

  it('a rejected wallet request shows nothing; a fault shows the error line', async () => {
    const { onClose } = setup(SIWE_ROUTES);
    await screen.findByText('status: signed-out');
    vi.mocked(connectWallet).mockRejectedValueOnce(
      Object.assign(new Error('User rejected the request.'), {
        name: 'UserRejectedRequestError',
        code: 4001,
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Connect a wallet' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect a wallet' })).not.toHaveAttribute(
        'aria-busy',
      ),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    vi.mocked(connectWallet).mockRejectedValueOnce(new Error('No wallet connector'));
    await userEvent.click(screen.getByRole('button', { name: 'Connect a wallet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(VOICE.error);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('email: start, then the code, then verify, with the right arguments', async () => {
    const { bodyOf, onClose } = setup(EMAIL_ROUTES);
    await screen.findByText('status: signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    const field = screen.getByRole('textbox', { name: 'Email' });
    expect(field).toHaveFocus();
    await userEvent.type(field, '  wool@flocked.test ');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(bodyOf('/auth/email/start')).toEqual({ email: 'wool@flocked.test' });
    expect(
      screen.getByText('We sent an 8-digit code to wool@flocked.test. It works for 5 minutes.'),
    ).toBeInTheDocument();
    const code = screen.getByRole('textbox', { name: 'Code' });
    expect(code).toHaveFocus();
    await userEvent.type(code, '1234 5678{Enter}');
    await screen.findByText('status: signed-in');
    expect(bodyOf('/auth/email/verify')).toEqual({
      email: 'wool@flocked.test',
      code: '12345678',
      transport: 'cookie',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("email: an invalid_code 401 shows the API's message and keeps the code", async () => {
    const { onClose } = setup(EMAIL_ROUTES);
    await screen.findByText('status: signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Email' }),
      'wool@flocked.test{Enter}',
    );
    const code = await screen.findByRole('textbox', { name: 'Code' });
    await userEvent.type(code, '87654321');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong code; 4 attempts left');
    expect(code).toHaveValue('87654321');
    expect(screen.getByText('status: signed-out')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('email: a malformed address or a short code is the field error, with no call', async () => {
    const { calls } = setup(EMAIL_ROUTES);
    await screen.findByText('status: signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    const field = screen.getByRole('textbox', { name: 'Email' });
    await userEvent.type(field, 'wool{Enter}');
    expect(field).toHaveAccessibleDescription("That doesn't look like an email address.");
    expect(field).toHaveValue('wool');
    await userEvent.type(field, '@flocked.test{Enter}');
    const code = await screen.findByRole('textbox', { name: 'Code' });
    await userEvent.type(code, '1234{Enter}');
    expect(code).toHaveAccessibleDescription('The code is 8 digits.');
    expect(calls.some((c) => c.path === '/auth/email/verify')).toBe(false);
  });

  it('email: a resend asks for a new code and clears the old one', async () => {
    const { calls } = setup(EMAIL_ROUTES);
    await screen.findByText('status: signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Email' }),
      'wool@flocked.test{Enter}',
    );
    const code = await screen.findByRole('textbox', { name: 'Code' });
    await userEvent.type(code, '1111');
    await userEvent.click(screen.getByRole('button', { name: 'Send a new code.' }));
    expect(await screen.findByText(/A new code is on its way\./)).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/auth/email/start')).toHaveLength(2);
    expect(code).toHaveValue('');
  });

  it('in the mini app: "Continue as @jay" signs in with Quick Auth', async () => {
    const miniApp: MiniApp = {
      user: { fid: 3, username: 'jay' },
      quickAuthToken: () => Promise.resolve('quick-auth-jwt'),
      ethereumProvider: () => Promise.resolve(undefined),
      openExternal: () => Promise.resolve(),
    };
    const { bodyOf, onClose } = setup(
      { '/auth/farcaster': () => json(200, { ...SESSION, token: 'bearer-token' }) },
      miniApp,
    );
    const dialog = await screen.findByRole('dialog', { name: "You're in Farcaster" });
    expect(within(dialog).getByText('@jay')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Use a wallet instead' })).toBeVisible();
    await screen.findByText('status: signed-out');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue as @jay' }));
    await screen.findByText('status: signed-in');
    expect(bodyOf('/auth/farcaster')).toEqual({ token: 'quick-auth-jwt', transport: 'bearer' });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('in a browser, Farcaster waits on the approval link, and signs in once approved', async () => {
    let approve: (token: string) => void = () => undefined;
    const cancel = vi.fn();
    vi.mocked(startBrowserFarcaster).mockResolvedValue({
      url: 'https://farcaster.xyz/~/siwf?channelToken=abc',
      token: new Promise<string>((resolve) => (approve = resolve)),
      cancel,
    });
    const { bodyOf, onClose } = setup({
      '/auth/farcaster': () => json(200, SESSION),
    });
    await screen.findByText('status: signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Farcaster' }));
    expect(await screen.findByRole('heading', { name: 'Approve in Farcaster' })).toBeVisible();
    const link = screen.getByRole('link', { name: 'Open Farcaster' });
    expect(link).toHaveAttribute('href', 'https://farcaster.xyz/~/siwf?channelToken=abc');
    expect(link).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for your approval');
    await act(async () => {
      approve('relay-quick-auth-jwt');
      await Promise.resolve();
    });
    await screen.findByText('status: signed-in');
    expect(bodyOf('/auth/farcaster')).toEqual({
      token: 'relay-quick-auth-jwt',
      transport: 'cookie',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(cancel).not.toHaveBeenCalled();
  });

  it('in a browser, cancelling the Farcaster wait stops the relay and goes back', async () => {
    let fail: (err: Error) => void = () => undefined;
    const cancel = vi.fn(() => fail(new Error('Farcaster sign-in was cancelled')));
    vi.mocked(startBrowserFarcaster).mockResolvedValue({
      url: 'https://farcaster.xyz/~/siwf?channelToken=abc',
      token: new Promise<string>((_, reject) => (fail = reject)),
      cancel,
    });
    const { onClose } = setup();
    await screen.findByText('status: signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Farcaster' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: 'Sign in to Flocked' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape closes it, and it opens again on the providers', async () => {
    const { onClose } = setup();
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to Flocked' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Email me a code' }));
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open sign-in' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in to Flocked' })).toBeVisible();
  });

  it('"Not now" closes it', async () => {
    const { onClose } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Email me a code' }));
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('from tablet up', () => {
    beforeEach(() => {
      vi.spyOn(window, 'matchMedia').mockImplementation((query: string): MediaQueryList => ({
        matches: query === '(min-width: 768px)',
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }));
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('is a modal that a tap on the scrim closes', async () => {
      const { onClose } = setup();
      const dialog = await screen.findByRole('dialog', { name: 'Sign in to Flocked' });
      await userEvent.click(dialog.parentElement!);
      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});

describe('sign-in errors', () => {
  it("say the API's message for a 4xx and the error line otherwise", () => {
    expect(signInErrorMessage(new ApiError(429, 'rate_limited', 'Slow down'))).toBe('Slow down');
    expect(signInErrorMessage(new ApiError(503, 'internal', 'Down'))).toBe(VOICE.error);
    expect(signInErrorMessage(new ApiError(0, 'network', 'No answer from Flocked'))).toBe(
      VOICE.error,
    );
    expect(signInErrorMessage(new Error('boom'))).toBe(VOICE.error);
  });

  it('know a wallet rejection, also when wrapped', () => {
    expect(isUserCancel({ code: 4001 })).toBe(true);
    expect(isUserCancel(new Error('outer', { cause: { name: 'UserRejectedRequestError' } }))).toBe(
      true,
    );
    expect(isUserCancel(new Error('No wallet connector'))).toBe(false);
    expect(isUserCancel(null)).toBe(false);
  });
});
