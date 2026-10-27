-- W10-D: sponsorship quota and idempotence for the ERC-7677 paymaster proxy.
--
-- A final request first owns a short pending lease. Successful responses are retained so a wallet
-- retrying the same user operation gets the same sponsorship without consuming the daily cap
-- twice. Active leases reserve one of the ten slots while the provider call is in flight; expired
-- leases do not. `lease_token` fences a timed-out owner from committing over a newer owner.
CREATE TABLE paymaster_sponsorships (
  operation_key   TEXT    NOT NULL PRIMARY KEY,
  sender          TEXT    NOT NULL,
  utc_day         TEXT    NOT NULL
    CHECK (length(utc_day) = 10
           AND utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  status          TEXT    NOT NULL CHECK (status IN ('pending', 'succeeded')),
  lease_token     TEXT    NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  result_json     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  succeeded_at    INTEGER,
  CHECK ((status = 'pending' AND result_json IS NULL AND succeeded_at IS NULL)
      OR (status = 'succeeded' AND result_json IS NOT NULL AND succeeded_at IS NOT NULL))
) STRICT;

CREATE INDEX paymaster_sponsorships_sender_day_idx
  ON paymaster_sponsorships (sender, utc_day, status, lease_expires_at);
