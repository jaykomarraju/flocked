// The signer boundary (wave-6 pinned interface): `signTicket({ roundId, wallet, personTag, expiry,
// ticketHash }) → { signature }`. apps/api/src/stakes/signer.ts declares the same shape for its
// `SIGNER` service binding.
import type { Address, Hex } from 'viem';

export interface SignTicketRequest {
  /** The FlockedEscrow round ID (uint256, decimal), as signed. */
  roundId: string;
  /** The wallet that will call `enter` (lowercase). */
  wallet: Address;
  /** The per-round person tag (bytes32, lowercase hex). */
  personTag: Hex;
  /** Unix seconds, as signed. */
  expiry: number;
  /** The ticket's EIP-712 digest, the `stakes_tickets.ticket_hash` apps/api committed. */
  ticketHash: Hex;
}

export interface SignTicketResult {
  /** 65-byte ECDSA signature over `ticketHash` by the escrow's ticket signer. */
  signature: Hex;
}

/** Why the signer refused. Over RPC the caller sees `ticket_refused: <reason>`. */
export type RefusalReason =
  | 'bad_request'
  | 'not_configured'
  | 'stakes_disabled'
  | 'hash_mismatch'
  | 'no_row'
  | 'row_mismatch'
  | 'expired';

export const REFUSED = 'ticket_refused';

export class TicketRefused extends Error {
  override readonly name = 'TicketRefused';

  constructor(readonly reason: RefusalReason) {
    super(`${REFUSED}: ${reason}`);
  }
}

/** A `stakes_tickets` row, with its round's FlockedEscrow round ID. */
export interface TicketRow {
  ticketHash: string;
  personTag: string;
  wallet: string;
  /** Unix seconds, as signed. */
  expiry: number;
  /** `round_modes.chain_round_id` of the ticket's round (Stakes), or null. */
  chainRoundId: string | null;
}

/** What the signer reads (src/store.ts over D1; e2e/tests/stakes-ticket.test.ts in memory). */
export interface TicketStore {
  /** The ticket row with this hash, or null. */
  ticket: (ticketHash: string) => Promise<TicketRow | null>;
  /** `mode.stakes.enabled` (the kill switch); false when missing, as in apps/api. */
  stakesEnabled: () => Promise<boolean>;
}
