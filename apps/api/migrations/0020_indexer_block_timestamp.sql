-- W7-F1 R18 (owner decision C4, Oct 12, 2026): the block timestamp of the indexer's position. Applies
-- on top of 0016 (0017 is W8-A's, 0018 W8-B's, 0019 W8-D's).
--
-- indexer_state.last_block_timestamp: the timestamp (Unix seconds, spec "Data model") of the block at
-- last_block_number, written by src/indexer/core.ts with every position it stores (the chunk's end
-- block, already read for its hash). The daily cap counts an unused ticket until the indexer has
-- processed past its expiry by this time (spec "Identity and personhood" › Entry tickets (Stakes);
-- src/stakes/cap.ts indexedThroughSec). NULL only for rows written before this migration, until the
-- indexer next advances.
ALTER TABLE indexer_state ADD COLUMN last_block_timestamp INTEGER
  CHECK (last_block_timestamp IS NULL OR last_block_timestamp >= 0);
