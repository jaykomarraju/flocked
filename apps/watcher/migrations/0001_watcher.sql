-- W10-B: the watcher's own D1, in its own Cloudflare account (plan.md 4.4, OA-05). It holds nothing
-- the backend can write and mirrors none of the API's schema: every row here is something this
-- Worker observed for itself, from the public API, the chain or drand.
--
-- round_snapshots: the round config as it was PUBLISHED AT LOCK, written once and never updated
-- (spec "Sealed picks" › Round config check: "The watcher snapshots the published config at lock and
-- checks it independently of the backend"). A later edit to the published config therefore cannot
-- change what the watcher compares `RoundCreated` against; it shows up as a mismatch instead.
CREATE TABLE round_snapshots (
  round_id       TEXT    NOT NULL PRIMARY KEY,
  game_day       TEXT    NOT NULL,
  kind           TEXT    NOT NULL,            -- 'daily' | 'room' (launch defaults differ)
  room_id        TEXT,
  opens_at       INTEGER NOT NULL,            -- unix seconds
  closes_at      INTEGER NOT NULL,            -- unix seconds
  beacon_round   INTEGER NOT NULL,
  beacon_delay   INTEGER NOT NULL,            -- seconds, from the published config
  chain_round_id TEXT,                        -- decimal string; null when the round has no Stakes mode
  is_house       INTEGER NOT NULL,            -- 1 when the question has no author
  config_json    TEXT    NOT NULL,            -- the published RoundConfigWire, verbatim
  snapshot_at    INTEGER NOT NULL             -- epoch ms, when this watcher first saw the lock
);
CREATE INDEX round_snapshots_closes_at ON round_snapshots (closes_at);

-- proposals: every `OutcomeProposed` log this watcher has seen, with the proposal block's timestamp.
-- A row with no matching verdict 30 minutes after `proposed_at` pages the guardian (spec: "Guardian
-- signers are paged on any mismatch, unable-to-verify, or missing verdict 30 minutes after a
-- proposal"). `missing_paged_at` keeps that page to one.
CREATE TABLE proposals (
  round_id         TEXT    NOT NULL,
  chain_round_id   TEXT    NOT NULL,
  bundle_hash      TEXT    NOT NULL,
  tx_hash          TEXT    NOT NULL,
  block_number     INTEGER NOT NULL,
  proposed_at      INTEGER NOT NULL,          -- unix seconds, the proposal block's timestamp
  seen_at          INTEGER NOT NULL,          -- epoch ms
  missing_paged_at INTEGER,                   -- epoch ms of the missing-verdict page, or null
  PRIMARY KEY (round_id, bundle_hash)
);

-- verdicts: one signed verdict per (subject, round). Write-once: a verdict is evidence, so a later
-- run never rewrites one, and `GET /verdicts/:subject/:id` serves the row as it was signed.
CREATE TABLE verdicts (
  subject      TEXT    NOT NULL,              -- src/verdict.ts VERDICT_SUBJECTS
  round_id     TEXT    NOT NULL,
  mode         TEXT    NOT NULL,              -- 'free' | 'stakes'
  verdict      TEXT    NOT NULL,              -- 'match' | 'mismatch' | 'unable'
  reasons_json TEXT    NOT NULL,              -- JSON array of strings
  checked_at   INTEGER NOT NULL,              -- epoch ms
  signature    TEXT    NOT NULL,              -- EIP-191 over src/verdict.ts verdictMessage()
  PRIMARY KEY (subject, round_id)
);

-- pages: what was sent (or still has to be sent) to the guardian paging webhook. A page survives a
-- failed delivery, so an unreachable webhook never loses a mismatch.
CREATE TABLE pages (
  id           TEXT    NOT NULL PRIMARY KEY,  -- dedupe key, e.g. verdict:<subject>:<roundId>
  kind         TEXT    NOT NULL,              -- 'verdict' | 'missing_verdict'
  body_json    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,              -- epoch ms
  attempts     INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,                       -- epoch ms, or null while undelivered
  last_error   TEXT
);
CREATE INDEX pages_undelivered ON pages (delivered_at, created_at);

-- round_state: what this watcher has learned about a round's place on the chain, so a tick does not
-- rescan from the deployment block every minute. Unlike the snapshot, these are the watcher's own
-- observations and may be filled in later.
CREATE TABLE round_state (
  round_id      TEXT    NOT NULL PRIMARY KEY,
  created_block INTEGER,                      -- the RoundCreated block, once found
  refunded_at   INTEGER                       -- unix seconds of the RoundRefunded block, once found
);
