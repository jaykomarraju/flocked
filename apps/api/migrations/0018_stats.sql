-- 0018_stats: W8-B (docs/plan/wave-8.md "W8-B"; spec "Profiles, leaderboards and rooms",
-- "Share cards and distribution" › Referral, "Anti-abuse" › Points farming).
--
-- stats_days: each daily-round mode whose final outcome `user_stats` has absorbed. Days are applied
-- strictly in order per mode (src/stats/apply.ts), so a mode that becomes final late (a Stakes hold,
-- a Free rule-8 refund) holds the later days back instead of counting out of order. `after_user`
-- is the entrant chunk cursor (entrants are applied in user ID order) and `done_at` is set once the
-- day is complete, with the non-entrants' streaks reset in the same batch. Every write checks the
-- row it expects, so a retried or concurrent call applies each chunk once.
CREATE TABLE stats_days (
  round_id   TEXT    NOT NULL,
  mode       TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  closes_at  INTEGER NOT NULL,
  game_day   TEXT    NOT NULL CHECK (game_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  outcome    TEXT    NOT NULL CHECK (outcome IN ('settled', 'refunded', 'voided')),
  winner     INTEGER CHECK (winner IS NULL OR winner IN (0, 1)),
  after_user TEXT    NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  done_at    INTEGER,
  PRIMARY KEY (round_id, mode),
  CONSTRAINT stats_days_winner CHECK ((outcome = 'settled') = (winner IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX stats_days_mode_closes ON stats_days (mode, closes_at);
-- At most one day in progress per mode.
CREATE UNIQUE INDEX stats_days_applying ON stats_days (mode) WHERE done_at IS NULL;

-- stats_wins: a settled day's winners with the stray streak they reached that day (the Strays board
-- of any game day; spec Leaderboards: ties go to the best stray streak, then the earlier entry).
CREATE TABLE stats_wins (
  round_id          TEXT    NOT NULL,
  mode              TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  user_id           TEXT    NOT NULL,
  stray_streak      INTEGER NOT NULL CHECK (stray_streak >= 1),
  best_stray_streak INTEGER NOT NULL CHECK (best_stray_streak >= stray_streak),
  entered_at        INTEGER NOT NULL,
  PRIMARY KEY (round_id, mode, user_id)
) STRICT;
CREATE INDEX stats_wins_board_idx
  ON stats_wins (round_id, mode, stray_streak DESC, best_stray_streak DESC, entered_at);

-- stats_weeks: wins and net per ISO week of the game day (the Weekly board; tie-break net).
CREATE TABLE stats_weeks (
  user_id    TEXT    NOT NULL,
  mode       TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  iso_week   TEXT    NOT NULL CHECK (iso_week GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]'),
  wins       INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  net        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mode, iso_week)
) STRICT;
CREATE INDEX stats_weeks_board_idx ON stats_weeks (mode, iso_week, wins DESC, net DESC);

-- The Streaks board: best stray streak, then the current streak, then rounds played.
CREATE INDEX user_stats_streaks_idx
  ON user_stats (mode, best_stray_streak DESC, stray_streak DESC, rounds_played DESC);

-- referrals.reward_week: the ISO week (of the game day) a referral was rewarded in, for the cap of
-- 10 per referrer per week, which the reward batch checks itself. referrals.checked_at: the last
-- reward attempt of a qualified referral (one that failed the farming rule or the cap waits), so
-- attempts rotate through every waiting referral (src/referrals/reward.ts).
ALTER TABLE referrals ADD COLUMN reward_week TEXT
  CHECK (reward_week IS NULL OR reward_week GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]');
ALTER TABLE referrals ADD COLUMN checked_at INTEGER;
CREATE INDEX referrals_reward_week_idx ON referrals (referrer_user_id, reward_week)
  WHERE reward_week IS NOT NULL;
CREATE INDEX referrals_qualified_idx ON referrals (checked_at, created_at)
  WHERE status = 'qualified';
