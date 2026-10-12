-- W6-B: Stakes ticket issuance and the 21+ age attestation. Applies on top of 0009 (0010 is unused;
-- 0011 is W6-A's, 0013 W6-D's).
--
-- stakes_tickets.game_day: the game day (New York date of the round's closesAt, YYYY-MM-DD) the
-- ticket counts against. Issuance is serialised per person by a conditional insert that refuses
-- while the same user holds a live ticket (unused, expiry + 30 s not yet passed) on that game day
-- (spec "Identity and personhood" › Entry tickets (Stakes)); the column makes that one indexed
-- lookup. NULL only for rows written before this migration (there are none: W6-B issues the first).
ALTER TABLE stakes_tickets ADD COLUMN game_day TEXT
  CHECK (game_day IS NULL OR (length(game_day) = 10
         AND game_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'));
CREATE INDEX stakes_tickets_user_day_idx ON stakes_tickets (user_id, game_day);

-- users.age_attested_min: the age the user's latest age attestation named, 18 or 21 (spec
-- "Compliance and responsible play" › Age and terms: 21+ where `geo.stakes.age21` lists the verified
-- country or the request's region). Meaningful only while age_attested_at is set. Every attestation
-- before this migration was "I'm 18 or older", hence the default.
ALTER TABLE users ADD COLUMN age_attested_min INTEGER NOT NULL DEFAULT 18
  CHECK (age_attested_min IN (18, 21));
