-- 0006_indexer: the chain indexer (W4-B; spec "Architecture" Chain indexer, "Data model"
-- indexer_state). src/indexer/** writes these tables; nothing else writes chain_events.

-- chain_events: every FlockedEscrow and FlockedAnchor log, mirrored (wave-4 pinned interface: chain_id,
-- contract, block_number, block_hash, tx_hash, log_index, event, args_json, removed). One row per
-- (chain_id, tx_hash, log_index). A reorg never deletes a row: a log that leaves the canonical chain
-- gets removed = 1, and one that comes back gets removed = 0. Each change a handler must see (removed
-- flips, or the decoded event changes) bumps `revision`. Handlers see each revision once
-- (chain_event_handled); dispatched_revision is the last revision every handler has seen, NULL before
-- the first dispatch. args_json is the decoded event (uint as decimal strings, bytes as 0x hex).
CREATE TABLE chain_events (
  chain_id            INTEGER NOT NULL,
  contract            TEXT    NOT NULL, -- lowercase address
  block_number        INTEGER NOT NULL CHECK (block_number >= 0),
  block_hash          TEXT    NOT NULL,
  block_timestamp     INTEGER NOT NULL, -- Unix seconds
  tx_hash             TEXT    NOT NULL,
  log_index           INTEGER NOT NULL CHECK (log_index >= 0),
  event               TEXT    NOT NULL, -- the ABI event name, or 'unknown' (args_json then holds topics and data)
  args_json           TEXT    NOT NULL CHECK (json_valid(args_json)),
  removed             INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
  revision            INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  dispatched_revision INTEGER CHECK (dispatched_revision IS NULL OR dispatched_revision <= revision),
  dispatch_attempts   INTEGER NOT NULL DEFAULT 0,
  dispatch_error      TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
) STRICT;
CREATE INDEX chain_events_contract_block_idx ON chain_events (chain_id, contract, block_number);
CREATE INDEX chain_events_event_idx ON chain_events (chain_id, event, block_number);
-- The dispatch queue: rows some handler has not yet seen at their current revision.
CREATE INDEX chain_events_pending_idx ON chain_events (chain_id, block_number, log_index)
  WHERE dispatched_revision IS NOT revision;

-- chain_event_handled: one row per (event, revision, handler) once that handler has run. A handler's
-- own D1 statements commit in the same batch as this row, so a replayed range never applies them twice.
CREATE TABLE chain_event_handled (
  chain_id   INTEGER NOT NULL,
  tx_hash    TEXT    NOT NULL,
  log_index  INTEGER NOT NULL,
  revision   INTEGER NOT NULL,
  handler    TEXT    NOT NULL,
  handled_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index, revision, handler)
) STRICT;

-- sent_txs: every transaction the backend broadcast (operator and anchor keys), recorded through
-- recordSentTx (src/indexer/sent.ts) when it is sent. A role-only event whose transaction is not here
-- raises ALERT_FOREIGN_EVENT (ALERT-8). round_key is '' when the transaction has no single round key.
CREATE TABLE sent_txs (
  chain_id   INTEGER NOT NULL,
  tx_hash    TEXT    NOT NULL,
  round_key  TEXT    NOT NULL DEFAULT '',
  kind       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, round_key)
) STRICT;

-- settlement_holds: a mode whose settlement waits for the guardian (spec "Identity and personhood" ›
-- Entry tickets: a foreign entry holds that round's settlement until the guardian vetoes or lets it
-- settle). The settlement coordinator does not post while a hold has released_at NULL.
CREATE TABLE settlement_holds (
  round_id    TEXT    NOT NULL,
  mode        TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  reason      TEXT    NOT NULL CHECK (reason IN ('foreign_entry')),
  tx_hash     TEXT    NOT NULL, -- the event that raised the hold (the first one)
  created_at  INTEGER NOT NULL,
  released_at INTEGER,
  released_by TEXT,             -- the admin who recorded the guardian's decision
  PRIMARY KEY (round_id, mode, reason),
  CONSTRAINT settlement_holds_release CHECK ((released_at IS NULL) = (released_by IS NULL))
) STRICT;
