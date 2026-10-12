-- 0016_refund_vetoed_hold: a guardian veto of a Stakes refund proposal opens a settlement hold
-- (W6-F1 O1; owner decision, Oct 12, 2026; spec "Round lifecycle", refund_proposed → revealing).
--
-- settlement_holds gains the reason 'refund_vetoed'. The indexer's `stakes-veto` handler opens it
-- for (round, 'stakes') in the batch that supersedes the vetoed proposal; the coordinator proposes
-- again only once the guardian has released it (the admin action: released_at, released_by and an
-- audit_log row), because the re-proposal is deterministic and would repeat the same refund. A second
-- refund veto of the same round reopens the released row (PK (round_id, mode, reason)). Like a
-- void_rate hold it carries no tx_hash (spec "Data model"); the veto's transaction is in its
-- audit_log row. SQLite cannot alter a CHECK, so the table is rebuilt as 0008 did, with every column
-- and row; it has no index besides its primary key.
CREATE TABLE settlement_holds_new (
  round_id    TEXT    NOT NULL,
  mode        TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  reason      TEXT    NOT NULL CHECK (reason IN ('foreign_entry', 'void_rate', 'refund_vetoed')),
  tx_hash     TEXT,             -- foreign_entry: the event that raised the hold (the first one)
  created_at  INTEGER NOT NULL,
  released_at INTEGER,
  released_by TEXT,             -- the admin who recorded the guardian's decision
  PRIMARY KEY (round_id, mode, reason),
  CONSTRAINT settlement_holds_release CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CONSTRAINT settlement_holds_tx CHECK ((reason = 'foreign_entry') = (tx_hash IS NOT NULL))
) STRICT;

INSERT INTO settlement_holds_new (round_id, mode, reason, tx_hash, created_at, released_at, released_by)
  SELECT round_id, mode, reason, tx_hash, created_at, released_at, released_by FROM settlement_holds;

DROP TABLE settlement_holds;
ALTER TABLE settlement_holds_new RENAME TO settlement_holds;
