-- W7-B: identities, merges and account deletion. Applies on top of 0013 (0014 is W7-A's, 0016
-- W6-F1's).
--
-- person_tombstones.user_id: the deleted account the tombstone came from. The daily cap counts a
-- person's stakes per game day (spec "Identity and personhood" › Entry tickets), but stakes and
-- tickets are counted by user ID (src/stakes/cap.ts). When the same person verifies a new account,
-- the personhood callback re-points the deleted account's tickets for the current and later game
-- days to the new account, so a deletion never restarts the day's cap at zero (W6-Z carry-over).
-- NULL for a tombstone without an account to carry from.
ALTER TABLE person_tombstones ADD COLUMN user_id TEXT;

-- One pending merge per (kept, losing) pair: a link and a personhood callback racing for the same
-- two accounts reuse one row. A pending row past expires_at is marked expired before a new one is
-- created (src/identity/merge.ts).
CREATE UNIQUE INDEX merges_pending_pair ON merges (kept_user_id, losing_user_id)
  WHERE status = 'pending';

-- Account deletion re-renders the user's share cards without handle and avatar.
CREATE INDEX share_cards_user_idx ON share_cards (user_id);
