// The ticket signer as apps/api sees it (wave-6 pinned interface): the service binding `SIGNER` to
// apps/signer, whose one RPC method signs a ticket this Worker has already recorded in
// stakes_tickets. The API never holds TICKET_SIGNER_KEY (NFR-7).
//
// Until W6-D registers the binding in src/env.ts and wrangler.jsonc, `StakesEnv` types it here; a
// deployment without it answers 503 `unavailable` (never a local signature).
import type { Address, Hex } from 'viem';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';

/** apps/signer/src/types.ts `SignTicketRequest`. */
export interface SignTicketRequest {
  /** The FlockedEscrow round ID (uint256, decimal), as signed. */
  roundId: string;
  /** Lowercase. */
  wallet: Address;
  /** bytes32, lowercase. */
  personTag: Hex;
  /** Unix seconds, as signed. */
  expiry: number;
  /** The ticket's EIP-712 digest (`stakes_tickets.ticket_hash`). */
  ticketHash: Hex;
}

/** The `SIGNER` binding's RPC surface. A refusal rejects with `ticket_refused: <reason>`. */
export interface TicketSignerRpc {
  signTicket: (req: SignTicketRequest) => Promise<{ signature: Hex }>;
}

/** The Worker env plus the signer binding (until W6-D adds it to `Env`). */
export type StakesEnv = Env & { SIGNER?: TicketSignerRpc };

export function ticketSigner(env: StakesEnv): TicketSignerRpc {
  if (!env.SIGNER) {
    log.error('ticket_signer_missing', {});
    throw new HttpError('unavailable', 'Stakes tickets are unavailable right now');
  }
  return env.SIGNER;
}
