-- 0007_review_fixes: the W4-F1 review fixes (docs/plan/wave-4.md "W4-F1").

-- T4: operator_txs gains the status 'cancelled'. An abandoned purpose (a `createRound` still pending
-- at opensAt, a `voidRound` abandoned at close) has its pending transaction replaced by a 0-value send
-- to the operator itself at the same nonce (src/chain/operator.ts cancelOperatorTx). 'cancelled': none
-- of the purpose's own versions was mined; tx_hash is the cancellation that was (or, when another
-- transaction took the nonce, the last version signed). SQLite can't change a CHECK in place, so the
-- table is rebuilt with the same columns and rows.
CREATE TABLE operator_txs_0007 (
  purpose    TEXT    NOT NULL PRIMARY KEY,
  status     TEXT    NOT NULL CHECK (status IN ('pending', 'mined', 'reverted', 'cancelled')),
  -- src/chain/tx.ts SentTx: nonce, every hash sent at that nonce, the latest raw tx and its fees.
  tx_json    TEXT    NOT NULL CHECK (json_valid(tx_json)),
  -- The mined transaction (status 'mined' or 'reverted'), or the cancellation ('cancelled').
  tx_hash    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT operator_txs_mined_hash CHECK ((status = 'pending') = (tx_hash IS NULL))
) STRICT;
INSERT INTO operator_txs_0007 (purpose, status, tx_json, tx_hash, created_at, updated_at)
  SELECT purpose, status, tx_json, tx_hash, created_at, updated_at FROM operator_txs;
DROP TABLE operator_txs;
ALTER TABLE operator_txs_0007 RENAME TO operator_txs;
