-- W9-A: notification delivery (spec "Notifications"). Applies on top of 0020.
--
-- notification_log: one row per dedupe key (the spec's key formats, built by each producer), written by
-- the notify queue consumer (src/notify/consumer.ts). A redelivered or re-enqueued message finds its
-- row and sends nothing twice:
--   * source: what claimed the key. For `outcome:{gameDay}:{userId}` it is `{roundId}:{mode}`, so a
--     second mode's outcome on the same game day is told apart from a redelivery of the first; for
--     every other event it is the key itself;
--   * claimed_until: a consumer's lease (epoch ms) while it delivers; a second consumer that finds a
--     live lease retries later instead of sending in parallel;
--   * channels: the channels already delivered (a JSON array), so a retry after a partial failure
--     sends only the rest;
--   * done_at: delivered, or nothing to deliver (no channel on, the user excluded or gone).
-- user_id is NULL for a send to no user (the daily official cast, W9-A.2).
CREATE TABLE notification_log (
  dedupe_key    TEXT    NOT NULL PRIMARY KEY,
  user_id       TEXT,
  event         TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  claimed_until INTEGER,
  channels      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(channels)),
  done_at       INTEGER,
  created_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX notification_log_created_idx ON notification_log (created_at);

-- farcaster_notification_tokens: Farcaster mini app notification tokens, one per (fid, client app),
-- from the mini app's webhook events (notifications enabled / disabled, app added / removed). The
-- consumer finds a user's tokens through identities (provider farcaster, external_id = fid), so a
-- merge or an unlink needs no change here. url is the client's notification endpoint.
CREATE TABLE farcaster_notification_tokens (
  fid        INTEGER NOT NULL CHECK (fid > 0),
  app_fid    INTEGER NOT NULL CHECK (app_fid > 0),
  url        TEXT    NOT NULL,
  token      TEXT    NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (fid, app_fid)
) STRICT;
CREATE INDEX farcaster_notification_tokens_token_idx ON farcaster_notification_tokens (url, token);
