-- 0003_round_do: RoundDO Free entries (W3-B).

-- daily_grant_skips: a daily grant skipped because the balance was ≥ 1,000 is final for that game
-- day and writes no ledger row (spec "Modes: Free and Stakes"; Decision log, Oct 8, 2026). This row
-- is what keeps a later visit or entry that day, after the balance has dropped, from granting. One
-- daily round per game day, so (user_id, round_id) is the game-day key. Written only by
-- src/rounds/grant.ts, inside the grant's own batch.
CREATE TABLE daily_grant_skips (
  user_id    TEXT    NOT NULL,
  round_id   TEXT    NOT NULL,
  balance    INTEGER NOT NULL, -- the global balance when the grant was skipped
  skipped_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, round_id)
) STRICT;
