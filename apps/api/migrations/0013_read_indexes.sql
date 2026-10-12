-- 0013_read_indexes: W6-D (docs/plan/wave-6.md "W6-D").
--
-- GET /claims?wallet= (src/read/claims.ts) finds a wallet's Stakes entries without sign-in. Without
-- this index every request scans every entry. `entries.wallet` is the lowercase address the indexer
-- mirrors from `Entered` (src/lifecycle/handlers.ts).
CREATE INDEX entries_stakes_wallet_idx ON entries (wallet, round_id) WHERE mode = 'stakes';
