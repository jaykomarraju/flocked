-- 0008_settlement: the settlement pipeline (W5-A; spec "Sealed picks" › Invalid entries, safety net).
--
-- settlement_holds gains the reason 'void_rate': when a mode's VOID entries exceed 2 % of its
-- entries and number at least 10, the SettlementDO holds that mode's settlement (either mode) and
-- alerts (ALERT_VOID_RATE). A VOID-rate hold comes from no transaction, so tx_hash is required only
-- for a foreign-entry hold. As before, only the guardian's admin action releases a hold (W11-A),
-- and nothing posts while released_at is NULL. SQLite cannot alter a CHECK, so the table is rebuilt
-- with the 0006 columns.
CREATE TABLE settlement_holds_new (
  round_id    TEXT    NOT NULL,
  mode        TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  reason      TEXT    NOT NULL CHECK (reason IN ('foreign_entry', 'void_rate')),
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
