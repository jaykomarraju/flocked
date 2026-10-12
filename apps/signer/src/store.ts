// The signer's only access to D1, kept read only by construction: the binding is wrapped here and
// nowhere else, and the wrapper runs exactly two fixed SELECTs (test/isolation.test.ts fails if any
// other file touches `DB` or any SQL here is not a SELECT). D1 has no read-only binding mode.
//
// Both reads go to D1's primary (the signer never opens a read-replica session), so a ticket row
// apps/api committed before calling the signer is always visible.
import type { TicketStore } from './types.js';

const TICKET_SQL =
  'SELECT t.ticket_hash, t.person_tag, t.wallet, t.expiry, m.chain_round_id FROM stakes_tickets t ' +
  "LEFT JOIN round_modes m ON m.round_id = t.round_id AND m.mode = 'stakes' WHERE t.ticket_hash = ?1";

const ENABLED_SQL = "SELECT value_json FROM config WHERE key = 'mode.stakes.enabled'";

/** Every statement the signer can run (test/isolation.test.ts checks each is a SELECT). */
export const SIGNER_SQL = [TICKET_SQL, ENABLED_SQL] as const;

export function d1TicketStore(db: D1Database): TicketStore {
  return {
    async ticket(ticketHash) {
      const row = await db.prepare(TICKET_SQL).bind(ticketHash).first<{
        ticket_hash: string;
        person_tag: string;
        wallet: string;
        expiry: number;
        chain_round_id: string | null;
      }>();
      if (!row) return null;
      return {
        ticketHash: row.ticket_hash,
        personTag: row.person_tag,
        wallet: row.wallet,
        expiry: row.expiry,
        chainRoundId: row.chain_round_id,
      };
    },
    async stakesEnabled() {
      const row = await db.prepare(ENABLED_SQL).first<{ value_json: string }>();
      return row?.value_json === 'true';
    },
  };
}
