// "Seal my pick" for a Free round: runs the entry flow (crypto/entry.ts) with this device's trusted
// chain, the API client and Turnstile, stores the pick and receipt, and reports what the screen shows.
// Turnstile: a token goes with the first Free entry of each New York game day; the game day of the last
// accepted token is remembered per user, and a 403 `turnstile_failed` asks for one anyway.
import type { RoundView } from '@flocked/shared';
import { useCallback, useState } from 'react';
import { ApiError, type ApiClient } from '../../api/client';
import { turnstileToken } from '../../auth/turnstile';
import { anchorReader } from '../../crypto/anchor';
import { ChainConfigError, clientChain } from '../../crypto/chain';
import { EntryRefused, submitFreeEntry, type SubmitDeps } from '../../crypto/entry';
import { writePick, type StoredPick } from '../../crypto/picks';
import { readLocal, writeLocal } from '../../lib/storage';
import { createEntry } from './api';
import { entryErrorMessage, refusalMessage } from './copy';

const turnstileKey = (userId: string) => `flocked.turnstile.${userId}`;

export type SealState =
  | { kind: 'idle' }
  | { kind: 'sealing' }
  | {
      kind: 'error';
      message: string;
      /** A 4xx or a refusal: the user can act on it. */ known: boolean;
    };

export interface FreeEntryInput {
  round: RoundView;
  optionIndex: 0 | 1;
  stake: bigint;
  userId: string;
}

/** Test seam: everything `submitFreeEntry` needs that isn't the API client. */
export type EntryEnv = Pick<SubmitDeps, 'chain' | 'reader' | 'turnstile'>;

function defaultEnv(): EntryEnv {
  const chain = clientChain();
  return { chain, reader: anchorReader(chain), turnstile: turnstileToken };
}

export function useFreeEntry(
  client: ApiClient,
  onSealed: (pick: StoredPick) => void,
  env: () => EntryEnv = defaultEnv,
) {
  const [state, setState] = useState<SealState>({ kind: 'idle' });

  const seal = useCallback(
    async (input: FreeEntryInput) => {
      setState({ kind: 'sealing' });
      try {
        const e = env();
        const { round, userId } = input;
        const { pick, usedTurnstile } = await submitFreeEntry(input, {
          ...e,
          passedTurnstileToday: readLocal(turnstileKey(userId)) === round.gameDay,
          post: (body) => client.call(createEntry, { params: { id: round.id }, body }),
        });
        if (usedTurnstile) writeLocal(turnstileKey(userId), round.gameDay);
        writePick(pick);
        setState({ kind: 'idle' });
        onSealed(pick);
      } catch (err) {
        if (err instanceof EntryRefused) {
          setState({ kind: 'error', message: refusalMessage(err.refusal), known: true });
        } else if (err instanceof ChainConfigError) {
          setState({
            kind: 'error',
            message: refusalMessage({ kind: 'chain', message: err.message }),
            known: true,
          });
        } else if (err instanceof ApiError) {
          setState({
            kind: 'error',
            message: entryErrorMessage(err.code),
            known: err.isClientError,
          });
        } else {
          setState({ kind: 'error', message: entryErrorMessage('internal'), known: false });
        }
      }
    },
    [client, env, onSealed],
  );

  const reset = useCallback(() => setState({ kind: 'idle' }), []);
  return { state, seal, reset };
}
