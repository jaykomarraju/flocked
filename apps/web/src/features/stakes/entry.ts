// The Stakes entry flow (spec "Client app" › Entry flow (Stakes)):
//   1. the round config check (`configCheck.ts`): every onchain `RoundConfig` field against the
//      record published at lock, read through the client's own public RPC. A mismatch refuses;
//   2. encrypt the pick with tlock, before any call that carries it — the same plaintext and
//      ciphertext as a Free entry, so the settlement opens both the same way;
//   3. `POST /rounds/:id/entries/stakes/prepare` for the signed ticket;
//   4. one sponsored user operation: `approve(escrow, stake)` then `enter`, sent through the smart
//      wallet with the app's ERC-7677 paymaster, and awaited until Base includes it.
// Nothing about the pick leaves the device before step 2, and a failed check never reaches step 3.
import type { RoundView, StakesPrepareResponse } from '@flocked/shared';
import type { Config } from 'wagmi';
import type { Address } from 'viem';
import type { ClientChain } from '../../crypto/chain';
import { sealPick } from '../../crypto/entry';
import { toBase64Url } from '@flocked/tlock';
import { entryCalls } from '../../wallet/calls';
import { sendSponsoredCalls, WalletError, type SentCalls } from '../../wallet/send';
import {
  checkRoundConfig,
  type ConfigCheck,
  type EscrowReader,
  type NonDefault,
} from './configCheck';

/** Why the client refused to build the entry. Nothing was sent, and no USDC moved. */
export class StakesRefused extends Error {
  constructor(readonly check: Extract<ConfigCheck, { ok: false }>) {
    super(`stakes entry refused: ${check.reason}`);
    this.name = 'StakesRefused';
  }
}

/** The ticket request, as the API client makes it; throws `ApiError` on failure. */
export type PrepareTicket = (wallet: Address) => Promise<StakesPrepareResponse>;

export interface StakesEntryDeps {
  chain: ClientChain;
  reader: EscrowReader;
  prepare: PrepareTicket;
  wagmi: Config;
  /** Where the paymaster proxy lives (the specs point it at their own mock). */
  origin?: string;
  randomBytes?: (n: number) => Uint8Array;
}

export interface StakesEntryResult {
  sent: SentCalls;
  /** The ciphertext as it went onchain, base64url, kept so Sealed can show the pick. */
  ciphertext: string;
  optionIndex: 0 | 1;
  /** The plaintext nonce, hex, for the Verify page. */
  nonce: `0x${string}`;
  stake: bigint;
  wallet: Address;
  /** Where the locked config differs from the launch defaults (the Today notice shows these). */
  nonDefaults: NonDefault[];
}

/**
 * Steps 1–4 for one pick. Throws `StakesRefused` before anything is sent, the API's error from
 * `prepare`, or a `WalletError` once the user operation is out.
 */
export async function submitStakesEntry(
  i: { round: RoundView; optionIndex: 0 | 1; wallet: Address },
  deps: StakesEntryDeps,
): Promise<StakesEntryResult> {
  const check = await checkRoundConfig({
    round: i.round,
    chain: deps.chain,
    reader: deps.reader,
  });
  if (!check.ok) throw new StakesRefused(check);

  const sealed = await sealPick({
    round: i.round,
    optionIndex: i.optionIndex,
    chain: deps.chain,
    randomBytes: deps.randomBytes,
  });
  const ciphertext = toBase64Url(sealed.ciphertext);

  const prepared = await deps.prepare(i.wallet);
  // The ticket has to be for this wallet, this chain and the escrow the client trusts; otherwise
  // the entry is not the one the player asked for, and it is not sent.
  const escrowMatches =
    prepared.verifyingContract.toLowerCase() === deps.chain.escrow.toLowerCase();
  if (
    prepared.ticket.wallet.toLowerCase() !== i.wallet.toLowerCase() ||
    prepared.chainId !== deps.chain.chainId ||
    !escrowMatches
  ) {
    throw new WalletError('failed');
  }

  const sent = await sendSponsoredCalls(deps.wagmi, {
    account: i.wallet,
    chainId: deps.chain.chainId,
    origin: deps.origin,
    calls: entryCalls({
      escrow: deps.chain.escrow,
      usdc: deps.chain.usdc,
      ciphertext,
      prepared,
    }),
  });

  return {
    sent,
    ciphertext,
    optionIndex: sealed.optionIndex,
    nonce: sealed.nonce,
    stake: BigInt(prepared.stake),
    wallet: i.wallet,
    nonDefaults: check.nonDefaults,
  };
}
