// "Seal my pick" for a Stakes round: the round config check, tlock, the ticket and one sponsored
// user operation (`entry.ts`), with this device's trusted chain and the connected smart wallet, and
// what the screen shows at each step.
//
// The screen stays `pending` from the moment the user operation goes out until Base includes it
// (spec "Client app" › Entry flow (Stakes) step 3), and the RoundDO's counter catches up when the
// indexer sees `Entered`, which is why nothing here writes a count.
import type { RoundView } from '@flocked/shared';
import { StakesPrepareRequestSchema, StakesPrepareResponseSchema } from '@flocked/shared';
import type { Config } from 'wagmi';
import { useCallback, useState } from 'react';
import type { Address } from 'viem';
import { ApiError, endpoint, type ApiClient } from '../../api/client';
import { ChainConfigError, clientChain } from '../../crypto/chain';
import { WalletError } from '../../wallet/send';
import { escrowReader, type ConfigCheck, type EscrowReader } from './configCheck';
import { CONFIG_UNREADABLE, prepareErrorMessage, walletErrorMessage } from './copy';
import { StakesRefused, submitStakesEntry } from './entry';
import { writeStakesPick, type StoredStakesPick } from './picks';

export const prepareStakesEntry = endpoint(
  'POST',
  '/rounds/:id/entries/stakes/prepare',
  StakesPrepareRequestSchema,
  StakesPrepareResponseSchema,
);

export type StakesEntryState =
  | { kind: 'idle' }
  /** The user operation is out; Base has not included it yet. */
  | { kind: 'pending' }
  /** The chain disagrees with the published config: the CTA is disabled under the notice. */
  | { kind: 'refused'; check: Extract<ConfigCheck, { ok: false }> }
  | { kind: 'error'; message: string; known: boolean };

export interface StakesEntryInput {
  round: RoundView;
  optionIndex: 0 | 1;
  wallet: Address;
  userId: string;
}

/** Test seam: everything the flow needs that isn't the API client or the wallet. */
export interface StakesEnv {
  chain: ReturnType<typeof clientChain>;
  reader: EscrowReader;
  origin?: string;
}

function defaultEnv(): StakesEnv {
  const chain = clientChain();
  return { chain, reader: escrowReader(chain) };
}

export function useStakesEntry(
  client: ApiClient,
  wagmi: Config,
  onEntered: (pick: StoredStakesPick) => void,
  env: () => StakesEnv = defaultEnv,
) {
  const [state, setState] = useState<StakesEntryState>({ kind: 'idle' });

  const enter = useCallback(
    async (input: StakesEntryInput) => {
      setState({ kind: 'pending' });
      try {
        const e = env();
        const result = await submitStakesEntry(input, {
          chain: e.chain,
          reader: e.reader,
          origin: e.origin,
          wagmi,
          prepare: (wallet) =>
            client.call(prepareStakesEntry, {
              params: { id: input.round.id },
              body: { wallet },
            }),
        });
        const pick: StoredStakesPick = {
          v: 1,
          userId: input.userId,
          roundId: input.round.id,
          mode: 'stakes',
          optionIndex: result.optionIndex,
          nonce: result.nonce,
          stake: result.stake.toString(),
          ciphertext: result.ciphertext,
          wallet: result.wallet.toLowerCase(),
          txHashes: result.sent.txHashes,
          savedAt: Date.now(),
        };
        writeStakesPick(pick);
        setState({ kind: 'idle' });
        onEntered(pick);
      } catch (err) {
        setState(entryError(err));
      }
    },
    [client, wagmi, env, onEntered],
  );

  const reset = useCallback(() => setState({ kind: 'idle' }), []);
  return { state, enter, reset };
}

/** What a failure puts on the screen. A refusal is its own state: it shows the mismatch notice. */
export function entryError(err: unknown): StakesEntryState {
  if (err instanceof StakesRefused) return { kind: 'refused', check: err.check };
  if (err instanceof ChainConfigError) {
    return { kind: 'error', message: CONFIG_UNREADABLE, known: true };
  }
  if (err instanceof WalletError) {
    return {
      kind: 'error',
      message: walletErrorMessage(err.kind),
      // Only a refusal the player made themselves needs no retry.
      known: err.kind === 'rejected',
    };
  }
  if (err instanceof ApiError) {
    return { kind: 'error', message: prepareErrorMessage(err.code), known: err.isClientError };
  }
  return { kind: 'error', message: prepareErrorMessage('internal'), known: false };
}
