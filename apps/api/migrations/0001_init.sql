-- Flocked D1 schema, wave 2 (P2.4). Source of truth: Product_Spec.md "Data model".
--
-- Conventions (spec "Data model", first paragraph):
--   * IDs are ULIDs, stored as TEXT (26 chars, Crockford base32).
--   * Stored timestamps (`*_at`, `opens_at`, `closes_at`, `expires_at`) are UTC epoch milliseconds.
--     Exception: `stakes_tickets.expiry` is the ticket's EIP-712 `expiry` exactly as signed (Unix seconds).
--   * Money and points are INTEGER base units (USDC 6 decimals, or whole points).
--   * Hashes, roots, addresses and tx hashes are lowercase 0x-prefixed hex TEXT.
--   * Booleans are INTEGER 0/1. JSON columns are TEXT checked with json_valid().
--   * Every table is STRICT. Enum columns listed in "Data model" carry a CHECK.
--   * No FOREIGN KEY clauses: the spec lists none, and D1 always enforces them, which would make
--     later table rebuilds and anonymisation flows order-sensitive.
--
-- Later waves own their own numbered migrations (wave files reserve them); never edit this file
-- after wave 2 is tagged.

-- users: one row per person.
CREATE TABLE users (
  id                 TEXT    NOT NULL PRIMARY KEY,
  handle             TEXT    NOT NULL COLLATE NOCASE,
  display_name       TEXT,
  avatar_url         TEXT,
  role               TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status             TEXT    NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'suspended', 'merged', 'deleted')),
  merged_into        TEXT,
  -- show_card_amounts, show_stakes_net, creator payout wallet.
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
CREATE UNIQUE INDEX users_handle ON users (handle);
CREATE UNIQUE INDEX users_person_id ON users (person_id);
CREATE UNIQUE INDEX users_ref_code ON users (ref_code);
CREATE INDEX users_merged_into_idx ON users (merged_into) WHERE merged_into IS NOT NULL;

-- identities: sign-in and verification identities. Wallet external_id = lowercase address;
-- Coinbase external_id = person_id.
CREATE TABLE identities (
  id          TEXT    NOT NULL PRIMARY KEY,
  user_id     TEXT    NOT NULL,
  provider    TEXT    NOT NULL CHECK (provider IN ('farcaster', 'wallet', 'email', 'coinbase')),
  external_id TEXT    NOT NULL,
  verified_at INTEGER,
  data_json   TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  CONSTRAINT identities_wallet_lowercase CHECK (provider <> 'wallet' OR external_id = lower(external_id))
) STRICT;
CREATE UNIQUE INDEX identities_provider_external ON identities (provider, external_id);
CREATE INDEX identities_user_idx ON identities (user_id);

-- questions: options_json is exactly 2 entries of {label, emoji}.
CREATE TABLE questions (
  id              TEXT    NOT NULL PRIMARY KEY,
  author_user_id  TEXT,   -- NULL for house questions
  prompt          TEXT    NOT NULL,
  options_json    TEXT    NOT NULL,
  category        TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted', 'rejected', 'queued', 'scheduled', 'used')),
  moderation_json TEXT    CHECK (moderation_json IS NULL OR json_valid(moderation_json)),
  score           REAL    NOT NULL DEFAULT 0, -- votes with a time decay ("Question pipeline")
  created_at      INTEGER NOT NULL,
  CONSTRAINT questions_two_options
    CHECK (json_valid(options_json) AND json_type(options_json) = 'array'
           AND json_array_length(options_json) = 2)
) STRICT;
CREATE INDEX questions_status_score_idx ON questions (status, score);
CREATE INDEX questions_author_idx ON questions (author_user_id) WHERE author_user_id IS NOT NULL;

CREATE TABLE question_votes (
  question_id TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  value       INTEGER NOT NULL CHECK (value IN (1, -1)),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (question_id, user_id)
) STRICT;

-- rounds: config_json is frozen at question lock (per-mode stake rules, fees, cap, minEntrants,
-- beaconDelay, the resolved Stakes creator address, free.creatorAwardBps and the award recipient).
CREATE TABLE rounds (
  id           TEXT    NOT NULL PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('daily', 'room')),
  room_id      TEXT,
  question_id  TEXT,   -- may be unset until the scheduler fills the slot (before lock)
  opens_at     INTEGER NOT NULL,
  closes_at    INTEGER NOT NULL,
  beacon_round INTEGER CHECK (beacon_round IS NULL OR beacon_round > 0),
  status       TEXT    NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'open', 'closed')),
  locked_at    INTEGER,
  config_json  TEXT    CHECK (config_json IS NULL OR json_valid(config_json)),
  CONSTRAINT rounds_room_kind CHECK ((kind = 'room') = (room_id IS NOT NULL)),
  CONSTRAINT rounds_window CHECK (closes_at > opens_at),
  CONSTRAINT rounds_locked_complete
    CHECK (locked_at IS NULL
           OR (question_id IS NOT NULL AND beacon_round IS NOT NULL AND config_json IS NOT NULL))
) STRICT;
CREATE INDEX rounds_kind_closes_idx ON rounds (kind, closes_at);
CREATE INDEX rounds_status_opens_idx ON rounds (status, opens_at);
CREATE INDEX rounds_room_closes_idx ON rounds (room_id, closes_at) WHERE room_id IS NOT NULL;

-- round_modes: created at question lock. The two _proposed states are Stakes only.
CREATE TABLE round_modes (
  round_id        TEXT    NOT NULL,
  mode            TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'revealing', 'settle_proposed', 'refund_proposed',
                                            'settled', 'refunded', 'voided')),
  refund_reason   INTEGER CHECK (refund_reason IS NULL OR refund_reason BETWEEN 1 AND 8),
  chain_round_id  TEXT,   -- Stakes: FlockedEscrow round ID (uint256, decimal string)
  lock_tx         TEXT,   -- Stakes: createRound tx; Free: lock-leaf anchor tx
  commitment_root TEXT,   -- Free
  commit_tx       TEXT,   -- Free
  bundle_hash     TEXT,
  revealed_at     INTEGER,
  claims_open_at  INTEGER, -- Stakes, from the onchain proposal
  final_at        INTEGER, -- when the mode reached a terminal state
  PRIMARY KEY (round_id, mode),
  CONSTRAINT round_modes_proposed_stakes_only
    CHECK (mode = 'stakes' OR status NOT IN ('settle_proposed', 'refund_proposed')),
  CONSTRAINT round_modes_stakes_columns
    CHECK (mode = 'stakes' OR (chain_round_id IS NULL AND claims_open_at IS NULL)),
  CONSTRAINT round_modes_free_columns
    CHECK (mode = 'free' OR (commitment_root IS NULL AND commit_tx IS NULL)),
  CONSTRAINT round_modes_final_at
    CHECK ((status IN ('settled', 'refunded', 'voided')) = (final_at IS NOT NULL))
) STRICT;
CREATE INDEX round_modes_status_idx ON round_modes (status);

-- stakes_tickets: every issued ticket, committed before the signer signs. A person tag may hold
-- several unused tickets per round but at most one used one.
CREATE TABLE stakes_tickets (
  ticket_hash TEXT    NOT NULL PRIMARY KEY,
  round_id    TEXT    NOT NULL,
  person_tag  TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  wallet      TEXT    NOT NULL,
  expiry      INTEGER NOT NULL, -- EIP-712 ticket expiry, Unix seconds (as signed)
  issued_at   INTEGER NOT NULL,
  used_tx     TEXT
) STRICT;
CREATE INDEX stakes_tickets_round_person_idx ON stakes_tickets (round_id, person_tag);
CREATE UNIQUE INDEX stakes_tickets_round_person_used ON stakes_tickets (round_id, person_tag)
  WHERE used_tx IS NOT NULL;
CREATE INDEX stakes_tickets_user_idx ON stakes_tickets (user_id, round_id);

-- entries: one per (round, mode, user). Free entries carry receipt_seq; Stakes entries carry the
-- chain coordinates and person_tag. option_index stays NULL until the reveal; ciphertext is
-- NULLed by archival once durable in R2 (Free) or onchain (Stakes).
CREATE TABLE entries (
  id           TEXT    NOT NULL PRIMARY KEY,
  round_id     TEXT    NOT NULL,
  mode         TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  user_id      TEXT    NOT NULL,
  wallet       TEXT,
  person_tag   TEXT,
  stake        INTEGER NOT NULL CHECK (stake > 0),
  ciphertext   BLOB,
  commitment   TEXT    NOT NULL, -- keccak256(ciphertext)
  receipt_seq  INTEGER CHECK (receipt_seq IS NULL OR receipt_seq >= 0),
  tx_hash      TEXT,
  block_number INTEGER,
  log_index    INTEGER,
  option_index INTEGER CHECK (option_index IS NULL OR option_index IN (0, 1)),
  valid        INTEGER CHECK (valid IS NULL OR valid IN (0, 1)),
  void_reason  TEXT,
  created_at   INTEGER NOT NULL,
  CONSTRAINT entries_free_receipt CHECK ((mode = 'free') = (receipt_seq IS NOT NULL)),
  CONSTRAINT entries_stakes_person CHECK ((mode = 'stakes') = (person_tag IS NOT NULL)),
  CONSTRAINT entries_stakes_chain
    CHECK (mode = 'free'
           OR (wallet IS NOT NULL AND tx_hash IS NOT NULL AND block_number IS NOT NULL
               AND log_index IS NOT NULL)),
  CONSTRAINT entries_free_no_chain
    CHECK (mode = 'stakes' OR (tx_hash IS NULL AND block_number IS NULL AND log_index IS NULL)),
  CONSTRAINT entries_void_reason CHECK (void_reason IS NULL OR valid = 0)
) STRICT;
CREATE UNIQUE INDEX entries_round_mode_user ON entries (round_id, mode, user_id);
CREATE UNIQUE INDEX entries_tx_log ON entries (tx_hash, log_index);
-- Not in the spec table: one receipt seq per (round, mode), so the commitment tree is well formed.
CREATE UNIQUE INDEX entries_round_mode_seq ON entries (round_id, mode, receipt_seq)
  WHERE receipt_seq IS NOT NULL;
CREATE INDEX entries_user_created_idx ON entries (user_id, created_at);

-- settlements: one row per proposal; a vetoed proposal is kept and marked superseded.
CREATE TABLE settlements (
  round_id        TEXT    NOT NULL,
  mode            TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  proposal_seq    INTEGER NOT NULL CHECK (proposal_seq >= 0),
  outcome         TEXT    NOT NULL CHECK (outcome IN ('settled', 'refunded', 'voided')),
  formula_version INTEGER NOT NULL,
  tally_json      TEXT    NOT NULL CHECK (json_valid(tally_json)), -- per-option headcount and stake
  winners_json    TEXT    CHECK (winners_json IS NULL OR json_valid(winners_json)),
  loss_pool       INTEGER NOT NULL DEFAULT 0 CHECK (loss_pool >= 0),
  fee             INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
  creator_fee     INTEGER NOT NULL DEFAULT 0 CHECK (creator_fee >= 0),
  distributable   INTEGER NOT NULL DEFAULT 0 CHECK (distributable >= 0),
  rebate_pool     INTEGER NOT NULL DEFAULT 0 CHECK (rebate_pool >= 0),
  dust            INTEGER NOT NULL DEFAULT 0 CHECK (dust >= 0),
  payout_root     TEXT,
  manifest_r2_key TEXT,
  bundle_hash     TEXT,
  settled_at      INTEGER,
  tx_hash         TEXT,
  superseded_at   INTEGER,
  PRIMARY KEY (round_id, mode, proposal_seq)
) STRICT;
CREATE UNIQUE INDEX settlements_round_mode_current ON settlements (round_id, mode)
  WHERE superseded_at IS NULL;

-- payouts: Stakes payouts are claimed via the contract; Free payouts are written to the ledger
-- immediately (claimed_at set at write time).
CREATE TABLE payouts (
  round_id   TEXT    NOT NULL,
  mode       TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  user_id    TEXT    NOT NULL,
  wallet     TEXT,
  kind       TEXT    NOT NULL CHECK (kind IN ('win', 'rebate', 'void_refund', 'refund')),
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  claimed_at INTEGER,
  claim_tx   TEXT,
  CONSTRAINT payouts_stakes_wallet CHECK (mode = 'free' OR wallet IS NOT NULL)
) STRICT;
-- Not in the spec table: the natural key, so chunked settlement writes can be idempotent.
CREATE UNIQUE INDEX payouts_round_mode_user_kind ON payouts (round_id, mode, user_id, kind);
CREATE INDEX payouts_user_unclaimed_idx ON payouts (user_id) WHERE claimed_at IS NULL;
CREATE INDEX payouts_wallet_unclaimed_idx ON payouts (wallet) WHERE claimed_at IS NULL AND wallet IS NOT NULL;

-- point_balances: scope is 'global' (daily rounds) or a room id (room rounds). The named CHECK is
-- what aborts an atomic points batch on insufficient balance ("Atomic points movements").
CREATE TABLE point_balances (
  user_id    TEXT    NOT NULL,
  scope      TEXT    NOT NULL,
  balance    INTEGER NOT NULL DEFAULT 0 CONSTRAINT point_balances_non_negative CHECK (balance >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope)
) STRICT;

-- points_ledger: append-only. The unique key makes settlement retries fail instead of crediting
-- twice; ref_id is NOT NULL so the key always applies (SQLite treats NULLs as distinct).
CREATE TABLE points_ledger (
  id         TEXT    NOT NULL PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  scope      TEXT    NOT NULL,
  delta      INTEGER NOT NULL,
  reason     TEXT    NOT NULL
                     CHECK (reason IN ('signup', 'daily_grant', 'room_grant', 'stake', 'payout', 'rebate',
                                       'refund', 'void_refund', 'creator_award', 'referral', 'merge',
                                       'admin')),
  ref_id     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX points_ledger_user_scope_reason_ref ON points_ledger (user_id, scope, reason, ref_id);
CREATE INDEX points_ledger_user_created_idx ON points_ledger (user_id, created_at);

CREATE TRIGGER points_ledger_no_update BEFORE UPDATE ON points_ledger
BEGIN
  SELECT RAISE(ABORT, 'points_ledger is append-only');
END;

CREATE TRIGGER points_ledger_no_delete BEFORE DELETE ON points_ledger
BEGIN
  SELECT RAISE(ABORT, 'points_ledger is append-only');
END;

-- user_stats: daily rounds only; Stakes results count once final. net is points or USDC units.
CREATE TABLE user_stats (
  user_id           TEXT    NOT NULL,
  mode              TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  rounds_played     INTEGER NOT NULL DEFAULT 0 CHECK (rounds_played >= 0),
  wins              INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses            INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  refunds           INTEGER NOT NULL DEFAULT 0 CHECK (refunds >= 0),
  stray_streak      INTEGER NOT NULL DEFAULT 0 CHECK (stray_streak >= 0),
  best_stray_streak INTEGER NOT NULL DEFAULT 0 CHECK (best_stray_streak >= stray_streak),
  play_streak       INTEGER NOT NULL DEFAULT 0 CHECK (play_streak >= 0),
  net               INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, mode)
) STRICT;

-- rooms: Free mode only unless the Stakes-rooms flag is set.
CREATE TABLE rooms (
  id              TEXT    NOT NULL PRIMARY KEY,
  name            TEXT    NOT NULL,
  owner_user_id   TEXT    NOT NULL,
  invite_code     TEXT    NOT NULL,
  question_source TEXT    NOT NULL DEFAULT 'daily' CHECK (question_source IN ('daily', 'custom')),
  created_at      INTEGER NOT NULL
) STRICT;
-- Not in the spec table: POST /rooms/join looks rooms up by invite code.
CREATE UNIQUE INDEX rooms_invite_code ON rooms (invite_code);
CREATE INDEX rooms_owner_idx ON rooms (owner_user_id);

CREATE TABLE room_members (
  room_id   TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  role      TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
) STRICT;
CREATE INDEX room_members_user_idx ON room_members (user_id);

-- share_cards: variants per card are og, embed, square (R2 keys under r2_prefix).
CREATE TABLE share_cards (
  share_id   TEXT    NOT NULL PRIMARY KEY, -- opaque random
  round_id   TEXT    NOT NULL,
  mode       TEXT    NOT NULL CHECK (mode IN ('free', 'stakes')),
  user_id    TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('result', 'teaser')),
  r2_prefix  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX share_cards_round_mode_user_kind ON share_cards (round_id, mode, user_id, kind);

-- merges: confirmed_at enforces the 30-day merge limit.
CREATE TABLE merges (
  id             TEXT    NOT NULL PRIMARY KEY,
  kept_user_id   TEXT    NOT NULL,
  losing_user_id TEXT    NOT NULL,
  identity_id    TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'confirmed', 'refused', 'expired')),
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  confirmed_at   INTEGER,
  CONSTRAINT merges_distinct_users CHECK (kept_user_id <> losing_user_id),
  CONSTRAINT merges_confirmed_at CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
) STRICT;
CREATE INDEX merges_kept_confirmed_idx ON merges (kept_user_id, confirmed_at);
CREATE INDEX merges_losing_idx ON merges (losing_user_id);

-- referrals: only daily rounds qualify.
CREATE TABLE referrals (
  referrer_user_id   TEXT    NOT NULL,
  referee_user_id    TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'rewarded')),
  qualified_round_id TEXT,
  rewarded_at        INTEGER,
  created_at         INTEGER NOT NULL,
  CONSTRAINT referrals_distinct_users CHECK (referrer_user_id <> referee_user_id),
  CONSTRAINT referrals_rewarded_at CHECK ((status = 'rewarded') = (rewarded_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX referrals_referee ON referrals (referee_user_id);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_user_id);

-- sessions: the cookie (web) or Bearer token (mini app) holds the unhashed ID.
CREATE TABLE sessions (
  id_hash    TEXT    NOT NULL PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT
) STRICT;
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE notification_prefs (
  user_id TEXT    NOT NULL,
  channel TEXT    NOT NULL CHECK (channel IN ('farcaster', 'webpush', 'email')),
  event   TEXT    NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (user_id, channel, event)
) STRICT;

-- push_subscriptions: web push.
CREATE TABLE push_subscriptions (
  id        TEXT NOT NULL PRIMARY KEY,
  user_id   TEXT NOT NULL,
  endpoint  TEXT NOT NULL,
  keys_json TEXT NOT NULL CHECK (json_valid(keys_json))
) STRICT;
-- Not in the spec table: a push endpoint identifies one browser subscription.
CREATE UNIQUE INDEX push_subscriptions_endpoint ON push_subscriptions (endpoint);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- limits: responsible play. Excluded means self_exclusion_until > now, or permanent and not yet
-- lifted (exclusion_lift_effective_at unset or in the future). A raised cap waits 24 h in pending_cap.
CREATE TABLE limits (
  user_id                     TEXT    NOT NULL PRIMARY KEY,
  daily_stake_cap             INTEGER CHECK (daily_stake_cap IS NULL OR daily_stake_cap >= 0),
  pending_cap                 INTEGER CHECK (pending_cap IS NULL OR pending_cap >= 0),
  pending_cap_effective_at    INTEGER,
  self_exclusion_started_at   INTEGER,
  self_exclusion_until        INTEGER,
  self_exclusion_permanent    INTEGER NOT NULL DEFAULT 0 CHECK (self_exclusion_permanent IN (0, 1)),
  exclusion_lift_requested_at INTEGER,
  exclusion_lift_effective_at INTEGER,
  question_block_until        INTEGER,
  CONSTRAINT limits_pending_cap_pair
    CHECK ((pending_cap IS NULL) = (pending_cap_effective_at IS NULL))
) STRICT;

-- indexer_state: if the stored hash no longer matches the chain, re-index from 5 blocks back.
CREATE TABLE indexer_state (
  chain_id          INTEGER NOT NULL,
  contract          TEXT    NOT NULL,
  last_block_number INTEGER NOT NULL CHECK (last_block_number >= 0),
  last_block_hash   TEXT    NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract)
) STRICT;

-- anchors: one row per FlockedAnchor transaction (a replacement tx gets its own row).
CREATE TABLE anchors (
  id              TEXT    NOT NULL PRIMARY KEY,
  kind            TEXT    NOT NULL CHECK (kind IN ('lock', 'commit', 'manifest')),
  round_keys_json TEXT    NOT NULL
                          CHECK (json_valid(round_keys_json) AND json_type(round_keys_json) = 'array'),
  tx_hash         TEXT,
  block_timestamp INTEGER,
  created_at      INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX anchors_tx_hash ON anchors (tx_hash);
CREATE INDEX anchors_kind_created_idx ON anchors (kind, created_at);

-- audit_log: every admin action, merge and settlement.
CREATE TABLE audit_log (
  id         TEXT    NOT NULL PRIMARY KEY,
  actor      TEXT    NOT NULL CHECK (actor IN ('user', 'admin', 'system')),
  action     TEXT    NOT NULL,
  target     TEXT,
  data_json  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX audit_log_target_idx ON audit_log (target, created_at);
CREATE INDEX audit_log_created_idx ON audit_log (created_at);

-- analytics_events is not stored in D1; events go to Workers Analytics Engine (binding ANALYTICS).
