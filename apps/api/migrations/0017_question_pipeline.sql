-- 0017_question_pipeline: the question pipeline (W8-A; spec "Question pipeline", "Anti-abuse" spam
-- bullet, "Data model"; decisions E4 and C5, Oct 12, 2026).
--
-- questions is rebuilt (SQLite cannot add a CHECK) with:
--   - a CHECK on category, the fixed list of "Core game rules" › Question format. D1 values are served
--     unchecked, and a bad one once broke GET /rounds/:id for clients while the API answered 200 (W7-D);
--   - needs_review: moderation could not decide (a refusal, a failed model call or a failed duplicate
--     lookup), so the question waits in `submitted` for an admin instead of entering the vote queue;
--   - rejection_reason and rejected_at, set together when a question is rejected (by moderation at
--     submit, or by an admin), for the author's notice and the 5-rejections-in-7-days block.
-- score keeps its meaning (votes with a 3-day half-life) in a form SQL can sort: the sum of each
-- vote's value times its weight, 2^((created_at − SCORE_EPOCH_MS) / half-life) (src/questions/score.ts).
-- The decayed score now is score × 2^(−(now − SCORE_EPOCH_MS) / half-life), the same factor for every
-- question, so ORDER BY score is the decayed order.
CREATE TABLE questions_new (
  id               TEXT    NOT NULL PRIMARY KEY,
  author_user_id   TEXT,   -- NULL for house questions
  prompt           TEXT    NOT NULL,
  options_json     TEXT    NOT NULL,
  category         TEXT    NOT NULL
                           CHECK (category IN ('food', 'life', 'tech', 'money', 'pop', 'hypothetical', 'other')),
  status           TEXT    NOT NULL DEFAULT 'submitted'
                           CHECK (status IN ('submitted', 'rejected', 'queued', 'scheduled', 'used')),
  moderation_json  TEXT    CHECK (moderation_json IS NULL OR json_valid(moderation_json)),
  score            REAL    NOT NULL DEFAULT 0, -- Σ value × weight (see above)
  created_at       INTEGER NOT NULL,
  needs_review     INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  rejection_reason TEXT,
  rejected_at      INTEGER,
  CONSTRAINT questions_two_options
    CHECK (json_valid(options_json) AND json_type(options_json) = 'array'
           AND json_array_length(options_json) = 2),
  CONSTRAINT questions_rejection
    CHECK ((status = 'rejected') = (rejected_at IS NOT NULL)
           AND (rejected_at IS NULL) = (rejection_reason IS NULL)),
  CONSTRAINT questions_review CHECK (needs_review = 0 OR status = 'submitted')
) STRICT;

INSERT INTO questions_new (id, author_user_id, prompt, options_json, category, status,
                           moderation_json, score, created_at, needs_review, rejection_reason, rejected_at)
  SELECT id, author_user_id, prompt, options_json,
         CASE WHEN category IN ('food', 'life', 'tech', 'money', 'pop', 'hypothetical', 'other')
              THEN category ELSE 'other' END,
         status, moderation_json, score, created_at, 0,
         CASE WHEN status = 'rejected' THEN 'Rejected' END,
         CASE WHEN status = 'rejected' THEN created_at END
  FROM questions;

DROP TABLE questions;
ALTER TABLE questions_new RENAME TO questions;

CREATE INDEX questions_status_score_idx ON questions (status, score);
CREATE INDEX questions_status_created_idx ON questions (status, created_at);
-- The 3-per-game-day limit counts an author's submissions by created_at.
CREATE INDEX questions_author_idx ON questions (author_user_id, created_at)
  WHERE author_user_id IS NOT NULL;
-- The 7-day block counts an author's rejections by rejected_at.
CREATE INDEX questions_author_rejected_idx ON questions (author_user_id, rejected_at)
  WHERE author_user_id IS NOT NULL AND rejected_at IS NOT NULL;

-- question_votes.weight: 2^((created_at − SCORE_EPOCH_MS) / half-life), fixed when the vote is cast,
-- so the question's score is recomputed from its votes in the same batch as each vote.
ALTER TABLE question_votes ADD COLUMN weight REAL NOT NULL DEFAULT 0;

-- question_splits: split quality per settled mode of a daily round ("Question pipeline" step 5),
-- 1 − (maxShare − 0.5) / 0.5 over valid headcount. Written once per (round, mode) by the post-final
-- creator handler (src/questions/final.ts); the Creators board averages it over used questions.
CREATE TABLE question_splits (
  round_id      TEXT    NOT NULL,
  mode          TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  question_id   TEXT    NOT NULL,
  split_quality REAL    NOT NULL CHECK (split_quality >= 0 AND split_quality <= 1),
  entrants      INTEGER NOT NULL CHECK (entrants > 0),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (round_id, mode)
) STRICT;
CREATE INDEX question_splits_question_idx ON question_splits (question_id);
