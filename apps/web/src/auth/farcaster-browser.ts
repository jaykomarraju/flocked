// Farcaster in a plain browser (spec "Identity and personhood" › Identities). Quick Auth is a mini app
// feature, so the browser takes the long way to the same token: Sign In With Farcaster through the
// Farcaster relay (the user approves in a Farcaster app, opened at `url`), then the Quick Auth server
// turns that signed message into the Quick Auth token the mini app would get, and POST /auth/farcaster
// exchanges it as everywhere. Both libraries load only when the user picks Farcaster.

/** The two network calls, injectable for tests. */
export interface FarcasterBrowserDeps {
  /** Quick Auth: a nonce, and a token for a verified SIWF message. */
  quickAuth: {
    generateNonce: () => Promise<string>;
    verifySiwf: (o: {
      domain: string;
      message: string;
      signature: string;
    }) => Promise<{ token: string }>;
  };
  /** The relay: a channel the Farcaster app signs into, and its status. */
  relay: {
    createChannel: (o: {
      siweUri: string;
      domain: string;
      nonce: string;
    }) => Promise<{ channelToken: string; url: string }>;
    status: (
      channelToken: string,
    ) => Promise<{ state: 'pending' | 'completed'; message?: string; signature?: string }>;
  };
}

export interface FarcasterBrowserRequest {
  /** Where the user approves: open it (a deep link on phones, Farcaster's web app on desktop). */
  url: string;
  /** The Quick Auth token once approved; rejects on timeout or cancel. */
  token: Promise<string>;
  cancel: () => void;
}

export const FARCASTER_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 1500;

async function realDeps(): Promise<FarcasterBrowserDeps> {
  const [{ createAppClient, viemConnector }, { createLightClient }] = await Promise.all([
    import('@farcaster/auth-client'),
    import('@farcaster/quick-auth/light'),
  ]);
  const app = createAppClient({ ethereum: viemConnector() });
  const qa = createLightClient();
  return {
    quickAuth: {
      generateNonce: async () => (await qa.generateNonce()).nonce,
      verifySiwf: (o) => qa.verifySiwf(o),
    },
    relay: {
      createChannel: async (o) => {
        const res = await app.createChannel(o);
        if (res.isError) throw new Error('Farcaster sign-in is unavailable');
        return res.data;
      },
      status: async (channelToken) => {
        const res = await app.status({ channelToken });
        if (res.isError) throw new Error('Farcaster sign-in is unavailable');
        return res.data;
      },
    },
  };
}

export async function startBrowserFarcaster(opts: {
  origin?: URL;
  deps?: FarcasterBrowserDeps;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<FarcasterBrowserRequest> {
  const origin = opts.origin ?? new URL(window.location.origin);
  const deps = opts.deps ?? (await realDeps());
  const nonce = await deps.quickAuth.generateNonce();
  const channel = await deps.relay.createChannel({
    siweUri: origin.origin,
    domain: origin.host,
    nonce,
  });
  let cancelled = false;
  const deadline = Date.now() + (opts.timeoutMs ?? FARCASTER_TIMEOUT_MS);
  const token = (async () => {
    for (;;) {
      if (cancelled) throw new Error('Farcaster sign-in was cancelled');
      if (Date.now() > deadline) throw new Error('Farcaster sign-in timed out');
      const s = await deps.relay.status(channel.channelToken);
      if (s.state === 'completed' && s.message && s.signature) {
        const { token } = await deps.quickAuth.verifySiwf({
          domain: origin.host,
          message: s.message,
          signature: s.signature,
        });
        return token;
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? POLL_MS));
    }
  })();
  return {
    url: channel.url,
    token,
    cancel: () => {
      cancelled = true;
    },
  };
}
