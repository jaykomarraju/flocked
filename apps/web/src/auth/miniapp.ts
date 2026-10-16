// The Farcaster / Base mini app (spec "Client app": detected through the mini app SDK). Inside it,
// sign-in is Farcaster Quick Auth: the client's token is exchanged at POST /auth/farcaster for a
// Bearer session (transport `bearer`; the mini app's webview may not keep our cookie).
import { sdk } from '@farcaster/miniapp-sdk';
import type { EIP1193Provider } from 'viem';

export interface MiniApp {
  /** The Farcaster account the client is signed in to. */
  user: { fid: number; username?: string; displayName?: string; pfpUrl?: string };
  /** Asks the client for a Quick Auth token (it may prompt the user). */
  quickAuthToken: () => Promise<string>;
  /** The client's wallet, for the wallet fallback. */
  ethereumProvider: () => Promise<EIP1193Provider | undefined>;
}

/** The mini app context, or null in a plain browser. Tells the client the app is ready. */
export async function detectMiniApp(): Promise<MiniApp | null> {
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
