// Ticket signing (spec "Identity and personhood" › Entry tickets (Stakes); wave-6 pinned interface).
// The signer trusts nothing in the request it can check itself:
//   * the kill switch `mode.stakes.enabled` is on (it stops tickets immediately, even one apps/api
//     has already recorded);
//   * `ticketHash` is the EIP-712 digest of the request's fields under this deployment's escrow
//     domain, which the signer derives from its own vars;
//   * a `stakes_tickets` row with that hash exists (apps/api commits it before calling), and its
//     wallet, person tag, expiry and round's escrow round ID are the request's;
//   * the ticket has not expired.
// Only then does it sign the digest. It writes nothing and logs no person tag. This file has no
// Workers types, so e2e/tests/stakes-ticket.test.ts signs through it on the local stack.
import { addressesFor, LOCAL_CHAIN_ID } from '@flocked/abi';
import { ticketDigest, type Eip712Target } from '@flocked/shared';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  TicketRefused,
  type SignTicketRequest,
  type SignTicketResult,
  type TicketStore,
} from './types.js';

export interface SignerDeps {
  store: TicketStore;
  /** The ticket signer's private key. */
  key: Hex;
  /** FlockedEscrow's EIP-712 target on this deployment. */
  escrow: Eip712Target;
  /** Unix seconds now. */
  nowSec: number;
}

const UINT = /^(0|[1-9][0-9]{0,77})$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;

function wellFormed(req: SignTicketRequest): boolean {
  return (
    typeof req.roundId === 'string' &&
    UINT.test(req.roundId) &&
    typeof req.wallet === 'string' &&
    ADDRESS.test(req.wallet) &&
    typeof req.personTag === 'string' &&
    HEX32.test(req.personTag) &&
    Number.isSafeInteger(req.expiry) &&
    req.expiry > 0 &&
    typeof req.ticketHash === 'string' &&
    HEX32.test(req.ticketHash)
  );
}

/** The signer's key from `TICKET_SIGNER_KEY`; refuses (`not_configured`) when it is missing. */
export function signerKey(env: { TICKET_SIGNER_KEY?: string | undefined }): Hex {
  const raw = env.TICKET_SIGNER_KEY ?? '';
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!KEY.test(key)) throw new TicketRefused('not_configured');
  return key as Hex;
}

/** FlockedEscrow's EIP-712 target: `CHAIN_ID`, and the escrow from @flocked/abi (or the stack's file). */
export function escrowTarget(env: {
  CHAIN_ID: string;
  LOCAL_DEPLOYMENT?: string | undefined;
}): Eip712Target {
  const chainId = Number(env.CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TicketRefused('not_configured');
  try {
    const local =
      chainId === LOCAL_CHAIN_ID && env.LOCAL_DEPLOYMENT !== undefined
        ? (JSON.parse(env.LOCAL_DEPLOYMENT) as unknown)
        : undefined;
    return { chainId, verifyingContract: addressesFor(chainId, local).escrow };
  } catch {
    throw new TicketRefused('not_configured');
  }
}

/** Signs the ticket, or throws `TicketRefused` with the first check that failed. */
export async function signTicket(
  deps: SignerDeps,
  req: SignTicketRequest,
): Promise<SignTicketResult> {
  if (!wellFormed(req)) throw new TicketRefused('bad_request');
  if (!(await deps.store.stakesEnabled())) throw new TicketRefused('stakes_disabled');

  const digest = ticketDigest(deps.escrow, {
    roundId: BigInt(req.roundId),
    wallet: req.wallet,
    personTag: req.personTag,
    expiry: BigInt(req.expiry),
  });
  if (digest.toLowerCase() !== req.ticketHash) throw new TicketRefused('hash_mismatch');

  const row = await deps.store.ticket(req.ticketHash);
  if (!row) throw new TicketRefused('no_row');
  if (
    row.wallet !== req.wallet ||
    row.personTag !== req.personTag ||
    row.expiry !== req.expiry ||
    row.chainRoundId !== req.roundId
  ) {
    throw new TicketRefused('row_mismatch');
  }
  if (row.expiry <= deps.nowSec) throw new TicketRefused('expired');

  const signature = await privateKeyToAccount(deps.key).sign({ hash: digest });
  return { signature: signature.toLowerCase() as Hex };
}
