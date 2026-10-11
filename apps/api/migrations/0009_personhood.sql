-- W5-B: personhood and Stakes eligibility. Applies on top of 0006 (0007 is W4-F1's, 0008 W5-A's).
--
-- config: admin-editable flags and config (spec "Admin console" › Flags and config; "Modes: Free and
-- Stakes" flags; "Compliance and responsible play" › Geo-fencing). One JSON value per key. The spec
-- names the keys but no table, so this is W5-B's (recorded as a spec issue); W11-A edits it and
-- writes `audit_log`. Keys read so far (src/personhood/config-store.ts):
--   geo.stakes.allow     JSON array of ISO 3166-1 alpha-2 countries ("GB") or ISO 3166-2
--                        subdivisions ("US-NJ"); missing or empty = Stakes unavailable everywhere
--   mode.stakes.enabled  JSON boolean; missing = false (the kill switch is off until configured)
CREATE TABLE config (
  key        TEXT    NOT NULL PRIMARY KEY,
  value_json TEXT    NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT    -- user ID of the admin who set it; NULL for migrations and seeds
) STRICT;

-- person_tombstones: a deleted account's person ID with its daily cap state (spec "Identity and
-- personhood" › Account deletion; Decision log, Oct 7). W7-B writes one when it deletes a verified
-- account. When the same person verifies a new account, the callback copies the cap state into the
-- new account's `limits` row and deletes the tombstone in the same batch.
CREATE TABLE person_tombstones (
  person_id                TEXT    NOT NULL PRIMARY KEY,
  daily_stake_cap          INTEGER CHECK (daily_stake_cap IS NULL OR daily_stake_cap >= 0),
  pending_cap              INTEGER CHECK (pending_cap IS NULL OR pending_cap >= 0),
  pending_cap_effective_at INTEGER,
  created_at               INTEGER NOT NULL,
  CONSTRAINT person_tombstones_pending_cap_pair
    CHECK ((pending_cap IS NULL) = (pending_cap_effective_at IS NULL))
) STRICT;
