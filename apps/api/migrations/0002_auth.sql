-- W3-A: sign-in and sessions. Applies on top of 0001_init.sql.
--
-- `users.handle` becomes nullable. The spec's Data model says only "handle (unique)", and the pinned
-- API schemas (packages/shared `SessionUserSchema`, `PublicUserSchema`) say a new account has no
-- handle until the user picks one with PATCH /me; 0001 declared it NOT NULL, which would force
-- sign-up to invent one. SQLite cannot drop NOT NULL in place, so the table is rebuilt with every
-- other column, constraint and index exactly as in 0001. No table refers to users by FOREIGN KEY.
-- A unique index allows any number of NULL handles.

CREATE TABLE users_new (
  id                 TEXT    NOT NULL PRIMARY KEY,
  handle             TEXT    COLLATE NOCASE,
  display_name       TEXT,
  avatar_url         TEXT,
  role               TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status             TEXT    NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'suspended', 'merged', 'deleted')),
  merged_into        TEXT,
  -- show_card_amounts, show_stakes_net, creator_payout_wallet (src/auth/profile.ts).
  prefs_json         TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(prefs_json)),
  age_attested_at    INTEGER,
  tos_version        TEXT,
  tos_accepted_at    INTEGER,
  kyc_status         TEXT,
  person_id          TEXT,
  person_verified_at INTEGER,
  ref_code           TEXT    NOT NULL,
  coinbase_country   TEXT,
  coinbase_region    TEXT,
  created_at         INTEGER NOT NULL,
  CONSTRAINT users_merged_into CHECK (status <> 'merged' OR merged_into IS NOT NULL)
) STRICT;

INSERT INTO users_new (
  id, handle, display_name, avatar_url, role, status, merged_into, prefs_json, age_attested_at,
  tos_version, tos_accepted_at, kyc_status, person_id, person_verified_at, ref_code,
  coinbase_country, coinbase_region, created_at
)
SELECT
  id, handle, display_name, avatar_url, role, status, merged_into, prefs_json, age_attested_at,
  tos_version, tos_accepted_at, kyc_status, person_id, person_verified_at, ref_code,
  coinbase_country, coinbase_region, created_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE UNIQUE INDEX users_handle ON users (handle);
CREATE UNIQUE INDEX users_person_id ON users (person_id);
CREATE UNIQUE INDEX users_ref_code ON users (ref_code);
CREATE INDEX users_merged_into_idx ON users (merged_into) WHERE merged_into IS NOT NULL;
