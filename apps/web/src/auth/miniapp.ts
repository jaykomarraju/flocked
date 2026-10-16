// The Farcaster / Base mini app (spec "Client app": detected through the mini app SDK). Inside it,
// sign-in is Farcaster Quick Auth: the client's token is exchanged at POST /auth/farcaster for a
// Bearer session (transport `bearer`; the mini app's webview may not keep our cookie). The SDK is
// loaded only when the page is framed or in a native webview, so the browser bundle stays small.
import type { EIP1193Provider } from 'viem';

export interface MiniApp {
  /** The Farcaster account the client is signed in to. */
  user: { fid: number; username?: string; displayName?: string; pfpUrl?: string };
  /** Asks the client for a Quick Auth token (it may prompt the user). */
  quickAuthToken: () => Promise<string>;
  /** The client's wallet, for the wallet fallback. */
  ethereumProvider: () => Promise<EIP1193Provider | undefined>;
}

/** True when the page could be a mini app: inside a frame or a React Native webview. */
export function mayBeMiniApp(win: Window = window): boolean {
  return win.parent !== win || 'ReactNativeWebView' in win;
}

/** The mini app context, or null in a plain browser. Tells the client the app is ready. */
export async function detectMiniApp(): Promise<MiniApp | null> {
  if (!mayBeMiniApp()) return null;
  const { sdk } = await import('@farcaster/miniapp-sdk');
  if (!(await sdk.isInMiniApp())) return null;
  const context = await sdk.context;
  await sdk.actions.ready();
  return {
    user: context.user,
    quickAuthToken: async () => (await sdk.quickAuth.getToken()).token,
    ethereumProvider: async () =>
      (await sdk.wallet.getEthereumProvider()) as EIP1193Provider | undefined,
  };
}
