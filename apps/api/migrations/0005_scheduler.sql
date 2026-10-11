-- 0005_scheduler: the scheduler, question lock and AnchorDO (W4-A).

-- rounds: one daily round per close time, so two overlapping cron runs cannot both create the same
-- game day's round (src/scheduler/create.ts inserts with ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX rounds_daily_closes_at ON rounds (closes_at) WHERE kind = 'daily';

-- rounds: frozen at question lock (spec "Round lifecycle" › Scheduling: "Nothing in a locked round
-- can change; the only option is to void it before close"). Status still moves.
CREATE TRIGGER rounds_locked_immutable
BEFORE UPDATE OF kind, room_id, question_id, opens_at, closes_at, beacon_round, locked_at, config_json
ON rounds
WHEN OLD.locked_at IS NOT NULL
  AND (NEW.kind IS NOT OLD.kind OR NEW.room_id IS NOT OLD.room_id
       OR NEW.question_id IS NOT OLD.question_id OR NEW.opens_at IS NOT OLD.opens_at
       OR NEW.closes_at IS NOT OLD.closes_at OR NEW.beacon_round IS NOT OLD.beacon_round
       OR NEW.locked_at IS NOT OLD.locked_at OR NEW.config_json IS NOT OLD.config_json)
BEGIN
  SELECT RAISE(ABORT, 'round_locked: a locked round cannot change');
END;

-- anchors.block_timestamp is the block's Unix seconds (an onchain value), never epoch ms. Anything
-- at or above 10^11 (the year 5138 in seconds, 1973 in ms) is a unit mix-up.
CREATE TRIGGER anchors_block_timestamp_seconds_insert
BEFORE INSERT ON anchors
WHEN NEW.block_timestamp IS NOT NULL
  AND (NEW.block_timestamp < 0 OR NEW.block_timestamp >= 100000000000)
BEGIN
  SELECT RAISE(ABORT, 'anchors.block_timestamp must be Unix seconds');
END;

CREATE TRIGGER anchors_block_timestamp_seconds_update
BEFORE UPDATE OF block_timestamp ON anchors
WHEN NEW.block_timestamp IS NOT NULL
  AND (NEW.block_timestamp < 0 OR NEW.block_timestamp >= 100000000000)
BEGIN
  SELECT RAISE(ABORT, 'anchors.block_timestamp must be Unix seconds');
END;

-- operator_txs: the operator key's transactions that must happen at most once (src/chain/operator.ts),
-- e.g. `createRound:<roundId>`. The signed transaction is stored before it is broadcast, so a crash or
-- an overlapping cron run never signs a second one with a new nonce: a retry polls, rebroadcasts or
-- replaces this one (same nonce, higher fees). A signed transaction is public once sent; no secret here.
CREATE TABLE operator_txs (
  purpose    TEXT    NOT NULL PRIMARY KEY,
  status     TEXT    NOT NULL CHECK (status IN ('pending', 'mined', 'reverted')),
  -- src/chain/tx.ts SentTx: nonce, every hash sent at that nonce, the latest raw tx and its fees.
  tx_json    TEXT    NOT NULL CHECK (json_valid(tx_json)),
  -- The mined transaction (status 'mined' or 'reverted').
  tx_hash    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT operator_txs_mined_hash CHECK ((status = 'pending') = (tx_hash IS NULL))
) STRICT;
