-- I4: indexer checkpoints (W4-F1 indexer half; spec "Data model" indexer_state, "Architecture" Chain
-- indexer). src/indexer/core.ts writes one row with every indexer_state write: the (block, hash) the
-- position moved to. After a hash mismatch the indexer re-indexes from the newest checkpoint at or
-- below 5 blocks back that is still canonical, so a reorg deeper than 5 blocks is repaired whether or
-- not a stored event sits in the fork; with no canonical checkpoint it re-indexes from the deploy
-- block. Kept: the newest 32 per contract, plus the newest in each 1,024-block bucket of the last 64.
CREATE TABLE indexer_checkpoints (
  chain_id     INTEGER NOT NULL,
  contract     TEXT    NOT NULL, -- lowercase address
  block_number INTEGER NOT NULL CHECK (block_number >= 0),
  block_hash   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract, block_number)
) STRICT;
INSERT INTO indexer_checkpoints (chain_id, contract, block_number, block_hash, created_at)
  SELECT chain_id, contract, last_block_number, last_block_hash, updated_at FROM indexer_state;

-- I1, I2, I6, I10: chain_event_removals, the removals handlers must see. A chain_events row holds only
-- the current state of its (tx_hash, log_index), so when a live row leaves the chain, or the slot now
-- holds a different log (another event or args, or the same log in another block), the trigger below
-- copies the old content here as revision + 1, a removal that undoes revision. The row itself moves on
-- (removed = 1 at revision + 1, or the new content at revision + 2), and its dispatched_revision only
-- tracks additions. The dispatcher hands every pending removal, newest first, to each handler that saw
-- the revision it undoes, before any addition (src/indexer/dispatch.ts).
CREATE TABLE chain_event_removals (
  chain_id            INTEGER NOT NULL,
  tx_hash             TEXT    NOT NULL,
  log_index           INTEGER NOT NULL,
  revision            INTEGER NOT NULL CHECK (revision >= 1), -- undoes revision - 1
  contract            TEXT    NOT NULL,
  block_number        INTEGER NOT NULL,
  block_hash          TEXT    NOT NULL,
  block_timestamp     INTEGER NOT NULL,
  event               TEXT    NOT NULL,
  args_json           TEXT    NOT NULL CHECK (json_valid(args_json)),
  dispatched          INTEGER NOT NULL DEFAULT 0 CHECK (dispatched IN (0, 1)),
  dispatch_attempts   INTEGER NOT NULL DEFAULT 0,
  dispatch_error      TEXT,
  dispatch_alerted_at INTEGER,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index, revision)
) STRICT;
CREATE INDEX chain_event_removals_pending_idx ON chain_event_removals (chain_id, block_number, log_index)
  WHERE dispatched = 0;

-- Removals still pending under 0006's rules move here; their rows then have nothing left to dispatch.
INSERT INTO chain_event_removals (chain_id, tx_hash, log_index, revision, contract, block_number,
    block_hash, block_timestamp, event, args_json, created_at)
  SELECT chain_id, tx_hash, log_index, revision, contract, block_number, block_hash, block_timestamp,
         event, args_json, updated_at
  FROM chain_events WHERE removed = 1 AND dispatched_revision IS NOT revision AND revision >= 1;
UPDATE chain_events SET dispatched_revision = revision WHERE removed = 1;

CREATE TRIGGER chain_events_removal AFTER UPDATE ON chain_events
WHEN OLD.removed = 0
  AND (NEW.removed = 1 OR NEW.contract <> OLD.contract OR NEW.block_number <> OLD.block_number
       OR NEW.block_hash <> OLD.block_hash OR NEW.block_timestamp <> OLD.block_timestamp
       OR NEW.event <> OLD.event OR NEW.args_json <> OLD.args_json)
BEGIN
  INSERT INTO chain_event_removals (chain_id, tx_hash, log_index, revision, contract, block_number,
      block_hash, block_timestamp, event, args_json, created_at)
    VALUES (OLD.chain_id, OLD.tx_hash, OLD.log_index, OLD.revision + 1, OLD.contract, OLD.block_number,
            OLD.block_hash, OLD.block_timestamp, OLD.event, OLD.args_json, NEW.updated_at)
    ON CONFLICT DO NOTHING;
END;

-- I7: a row whose dispatch keeps failing repeats ALERT_DO_ERROR (every 30 min) instead of once.
ALTER TABLE chain_events ADD COLUMN dispatch_alerted_at INTEGER;
