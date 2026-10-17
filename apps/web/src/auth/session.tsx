// The session (spec "Identity and personhood" › Identities): who is signed in, and the ways to sign
// in. Browser sessions are the API's HttpOnly cookie; mini app sessions are a Bearer token kept in
// memory and sessionStorage (that webview's tab only). `GET /me` is the source of truth: the app
// loads it at start and after every sign-in, and a 401 that means the session is gone signs out.
import type { AuthSessionResponse, MeResponse } from '@flocked/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Config } from 'wagmi';
import {
  ApiError,
  api,
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
} from '../api/client';
import { appChain } from './config';
import type { MiniApp } from './miniapp';
import { siweSignIn } from './siwe';
import { turnstileToken } from './turnstile';
import { connectWallet } from './wallet';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

export interface Auth {
  status: AuthStatus;
  me: MeResponse | null;
  /** The mini app context, or null in a browser. */
  miniApp: MiniApp | null;
  /**
   * The app's one wagmi config: sign-in uses it to connect and sign, and Stakes to send its
   * sponsored user operations through the same connected wallet (W10-C).
   */
  wagmiConfig: Config;
  client: ApiClient;
  /** SIWE with an injected wallet or the smart wallet (in the mini app: the client's wallet). */
  signInWithWallet: () => Promise<void>;
  /**
   * Farcaster: Quick Auth inside the mini app; in a browser, the relay flow, which hands the
   * approval URL (and a cancel) to `onApprove` so the sign-in sheet can open it and wait.
   */
  signInWithFarcaster: (opts?: {
    onApprove?: (url: string, cancel: () => void) => void;
  }) => Promise<void>;
  /** Sends a sign-in code to a linked, verified email (answers the same for any address). */
  startEmail: (email: string) => Promise<void>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<Auth | null>(null);

const TOKEN_KEY = 'flocked.session';

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token lives in memory only.
  }
}

export function AuthProvider({
  children,
  wagmiConfig,
  miniApp = null,
  fetch,
  origin,
}: {
  children: ReactNode;
  wagmiConfig: Config;
  miniApp?: MiniApp | null;
} & Pick<ApiClientOptions, 'fetch' | 'origin'>) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const token = useRef<string | null>(miniApp ? readToken() : null);

  const dropSession = useCallback(() => {
    token.current = null;
    writeToken(null);
    setMe(null);
    setStatus('signed-out');
  }, []);

  const client = useMemo(
    () =>
      createApiClient({
        fetch,
        origin,
        getToken: () => token.current,
        onSessionLost: () => dropSession(),
      }),
    [fetch, origin, dropSession],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await client.call(api.me);
      setMe(next);
      setStatus('signed-in');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        dropSession();
        return;
      }
      // Offline or a fault: keep what we had; screens show the global error and offline states.
      setStatus((s) => (s === 'loading' ? 'signed-out' : s));
      throw err;
    }
  }, [client, dropSession]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const adopt = useCallback(
    async (session: AuthSessionResponse) => {
      if (session.token) {
        token.current = session.token;
        writeToken(session.token);
      }
      await refresh();
    },
    [refresh],
  );

  const transport = miniApp ? ('bearer' as const) : ('cookie' as const);

  const signInWithWallet = useCallback(async () => {
    const wallet = await connectWallet(wagmiConfig);
    // Account creation needs a Turnstile token. Asked for once the wallet is connected: a token
    // lives 300 s, and asking before a slow wallet prompt could hand the API an expired one.
    const turnstile = turnstileToken();
    const session = await siweSignIn({
      client,
      wallet,
      chainId: appChain().id,
      turnstileToken: await turnstile,
      transport,
    });
    await adopt(session);
  }, [wagmiConfig, client, transport, adopt]);

  const signInWithFarcaster = useCallback(
    async (opts: { onApprove?: (url: string, cancel: () => void) => void } = {}) => {
      const quickAuth = async () => {
        if (miniApp) return miniApp.quickAuthToken();
        const { startBrowserFarcaster } = await import('./farcaster-browser');
        const request = await startBrowserFarcaster({});
        opts.onApprove?.(request.url, request.cancel);
        return request.token;
      };
      // Turnstile after the Farcaster token: the browser's relay approval can take minutes, and a
      // Turnstile token lives 300 s.
      const token = await quickAuth();
      const turnstile = await turnstileToken();
      const session = await client.call(api.farcaster, {
        body: { token, transport, ...(turnstile ? { turnstileToken: turnstile } : {}) },
      });
      await adopt(session);
    },
    [miniApp, client, transport, adopt],
  );

  const startEmail = useCallback(
    async (email: string) => {
      await client.call(api.emailStart, { body: { email } });
    },
    [client],
  );

  const verifyEmail = useCallback(
    async (email: string, code: string) => {
      const session = await client.call(api.emailVerify, { body: { email, code, transport } });
      await adopt(session);
    },
    [client, transport, adopt],
  );

  const signOut = useCallback(async () => {
    try {
      await client.call(api.logout);
    } finally {
      dropSession();
    }
  }, [client, dropSession]);

  const value = useMemo<Auth>(
    () => ({
      status,
      me,
      miniApp,
      wagmiConfig,
      client,
      signInWithWallet,
      signInWithFarcaster,
      startEmail,
      verifyEmail,
      signOut,
      refresh,
    }),
    [
      status,
      me,
      miniApp,
      wagmiConfig,
      client,
      signInWithWallet,
      signInWithFarcaster,
      startEmail,
      verifyEmail,
      signOut,
      refresh,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth outside AuthProvider');
  return auth;
}
