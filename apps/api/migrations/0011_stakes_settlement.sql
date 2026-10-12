-- 0011_stakes_settlement: W6-A (docs/plan/wave-6.md "W6-A").
--
-- Stakes settlement reads a round's entries in chain order, (block_number, log_index), a page at a
-- time (src/settlement/prepare.ts), and checks them against the entry set streamed from the chain.
-- Without this index each page sorts every entry of the round.
--
-- A foreign Stakes entry (no ticket, user_id NULL) gets no `payouts` row: its payout lives only in the
-- payout tree and the bundle (W2-Z carry-over), so payouts.user_id stays NOT NULL.
CREATE INDEX entries_round_stakes_chain_idx ON entries (round_id, block_number, log_index)
  WHERE mode = 'stakes';
