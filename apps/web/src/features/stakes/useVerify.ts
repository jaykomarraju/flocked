// "Verify with Coinbase" (spec "Client app" › Entry flow (Stakes) step 1; "Identity and personhood"
// › Personhood): accept the terms and the age attestation (`POST /me/tos`), start the OAuth flow
// (`POST /me/personhood`, which answers with Coinbase's authorize URL), open it, and wait.
//
// In a browser the tab goes to Coinbase and comes back to the app, so there is nothing to poll.
// Inside the mini app the flow cannot finish in the webview, so it opens an **external browser** and
// this hook polls `/me` until the player is eligible, or until it gives up and lets them start
// again. The polling is the spec's: the app has no other way to learn that a flow it cannot see has
// finished.
import {
  AcceptTosRequestSchema,
  AcceptTosResponseSchema,
  StartPersonhoodResponseSchema,
  type AgeAttestation,
} from '@flocked/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { endpoint, type ApiClient } from '../../api/client';
import type { MiniApp } from '../../auth/miniapp';

export const acceptTos = endpoint(
  'POST',
  '/me/tos',
  AcceptTosRequestSchema,
  AcceptTosResponseSchema,
);
export const startPersonhood = endpoint(
  'POST',
  '/me/personhood',
  null,
  StartPersonhoodResponseSchema,
);

/** How often the mini app asks `/me` whether the external browser has finished. */
export const VERIFY_POLL_MS = 3000;
/** How long it keeps asking before it stops on its own. */
export const VERIFY_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export type VerifyState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  /** The flow is out at Coinbase; in the mini app, in a browser we can only poll `/me` for. */
  | { kind: 'waiting' }
  | { kind: 'error'; message: string };

export interface UseVerifyOptions {
  client: ApiClient;
  /** The ToS version `/me` is serving, and the age its checkbox must name. */
  tosVersion: string;
  /** True once `/me` says the player may play Stakes: the wait is over. */
  eligible: boolean;
  /** Re-fetches the session's `/me`. */
  refresh: () => Promise<unknown>;
  /** The mini app context, or null in a plain browser. */
  miniApp: MiniApp | null;
  /** Overridden by the tests and the design sheets; never in production. */
  open?: (url: string) => void | Promise<void>;
  pollMs?: number;
  /** Turns a thrown API error into the line the sheet shows. */
  onError: (err: unknown) => string;
}

export function useVerify({
  client,
  tosVersion,
  eligible,
  refresh,
  miniApp,
  open,
  pollMs = VERIFY_POLL_MS,
  onError,
}: UseVerifyOptions) {
  const [state, setState] = useState<VerifyState>({ kind: 'idle' });
  const startedAt = useRef(0);

  // The wait ends the moment `/me` says the player is eligible.
  useEffect(() => {
    if (eligible) setState({ kind: 'idle' });
  }, [eligible]);

  // Only the mini app polls: a browser tab left for Coinbase and reloads the app on its way back.
  useEffect(() => {
    if (state.kind !== 'waiting' || !miniApp) return;
    const timer = setInterval(() => {
      if (Date.now() - startedAt.current > VERIFY_POLL_TIMEOUT_MS) {
        setState({ kind: 'idle' });
        return;
      }
      void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [state.kind, miniApp, refresh, pollMs]);

  const verify = useCallback(
    async (age: AgeAttestation) => {
      setState({ kind: 'starting' });
      try {
        // The age and the terms are stored before the OAuth flow, so `/me` can answer with both.
        await client.call(acceptTos, { body: { tosVersion, ageAttested: age } });
        const { authorizeUrl } = await client.call(startPersonhood, {});
        startedAt.current = Date.now();
        setState({ kind: 'waiting' });
        const go = open ?? openWith(miniApp);
        await go(authorizeUrl);
      } catch (err) {
        setState({ kind: 'error', message: onError(err) });
      }
    },
    [client, tosVersion, open, miniApp, onError],
  );

  return { state, verify, reset: () => setState({ kind: 'idle' }) };
}

/** Outside the webview in the mini app; in the tab itself in a browser. */
function openWith(miniApp: MiniApp | null): (url: string) => void | Promise<void> {
  if (miniApp) return (url) => miniApp.openExternal(url);
  return (url) => window.location.assign(url);
}
