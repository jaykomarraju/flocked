# W5-B handoff: Personhood

## Status
complete: Coinbase sign-in, the callback, attestations, geo rules, the tombstone check and Stakes eligibility in `GET /me` are built and tested, and both mocks are in place. No `.2` session is needed.

## Summary
- `POST /me/personhood` returns the Coinbase authorize URL. It uses PKCE S256, a 32-byte state stored in `AuthDO` only as a hash and bound to the user, and a 10-minute TTL.
- `GET /me/personhood/callback` consumes the state once and attributes the result only to the state's user. It exchanges the code, reads `/v2/user` and `/v2/user/personal-details`, and stores:
  - `person_id` = HMAC-SHA256(`PERSON_ID_KEY`, Coinbase ID);
  - the country and region codes;
  - `kyc_status`;
  - a `coinbase` identity.

  The token is dropped after the callback. The callback answers JSON for `Accept: application/json`; otherwise it redirects 302 to `/settings?personhood=…`.
- Callback cases:
  - Another account holds the person ID: a pending merge (kept = earlier `created_at`, 7-day TTL, an open one is reused), plus a `merge_pending` notice to the holder.
  - The caller is bound to a different person: `person_mismatch`.
  - No personal details: the person ID is bound with `kyc_status = 'unverified'`, which counts as not verified.
  - A person tombstone exists: its cap state is copied into `limits` (the lower cap wins) and the tombstone is deleted.
- Attestations (`src/personhood/attestations.ts`):
  - reads Coinbase's indexer (`getAttestationUid`) and then EAS `getAttestation`;
  - checks the schema, recipient, Coinbase attester, revocation and expiry;
  - caches results per wallet in `identities.data_json.attestations` for 10 minutes. Tickets pass `attestationMaxAgeMs: 0`. A failed lookup is not cached and fails closed.
- `stakesEligibility(env, user, request, opts?)` (pinned) checks:
  - verified;
  - an attested wallet whose country equals the OAuth country;
  - `geo.stakes.allow` for that country and for the request's `cf.country`/`regionCode`;
  - proxy signals (Tor `T1`, Bot Management score < 30);
  - age and ToS;
  - self-exclusion and suspension;
  - the `mode.stakes.enabled` kill switch.

  `GET /me` and `PATCH /me` report it.
- Migration `0009_personhood.sql` adds two tables: `config` (key → JSON; holds `geo.stakes.allow` and `mode.stakes.enabled`, both off by default) and `person_tombstones`.
- W3-Z carry-over: `createAccount` deletes any unverified row for the same (provider, external_id) in the same batch. A sign-up that proves control no longer hits the unique index and answers 500.
- The mocks `e2e/mocks/coinbase` (OAuth and v2, PKCE checked) and `e2e/mocks/eas` (JSON-RPC indexer and EAS) each have a README.

## Branch and head commit
`w5-b-personhood` @ `fb34977` (code). The handoff commit follows it.

## Files touched
- New:
  - `apps/api/src/personhood/{config,config-store,deps,coinbase,attestations,geo,eligibility,verify,flow}.ts`
  - `apps/api/migrations/0009_personhood.sql`
  - `apps/api/test/personhood/{fixtures,callback,person-id,eligibility,unverified-identity}.test.ts` (`fixtures.ts` is not a test file)
  - `e2e/mocks/{coinbase,eas}/{server.mjs,README.md}`
  - `docs/sessions/W5-B.md`
- Edited:
  - `apps/api/src/routes/me.ts`: the personhood handlers, plus `meView` for `GET /me` and `PATCH /me`;
  - `apps/api/src/auth/accounts.ts`: only the carry-over fix;
  - `packages/shared/src/api/me.ts`;
  - `apps/api/test/{migrations,routes}.test.ts` and `apps/api/test/me/me.test.ts` (see Deviations).

## Tests run
| Command | Result |
| --- | --- |
| `pnpm check` (Node 22.23.1) | pass: abi 13, settle 66, tlock 176, shared 439, api 585 (546 before, +39), forge 202 |
| `pnpm format:check` | pass |
| Manual: `wrangler dev --local` + Farcaster, Coinbase and EAS mocks (spare ports) | Farcaster sign-up → `POST /me/personhood` → mock approve → callback `verified` (US) → replay → `invalid_state`. Then a wallet linked and the config set: `GET /me` reasons went `country_unverified` → `country_mismatch` (CA attested) → eligible (US attested). No Coinbase data appeared in the Worker log. |

## Traceability rows covered
- **ID-2:** `apps/api/test/personhood/person-id.test.ts` ::
  - "ID-2: one person ID per user: a second account with the same Coinbase account gets a pending merge"
  - "ID-2: the earlier account is kept even when it verifies second"
  - "ID-2: an account bound to one person cannot bind another"
- **ID-3:** `apps/api/test/personhood/callback.test.ts` ::
  - "ID-3 login CSRF: a callback carrying another user's cookie attributes only to the state's user"
  - "ID-3 replay: a used state fails and changes nothing"
- **NFR-8 (Coinbase part):** `person-id.test.ts` :: "no raw Coinbase ID, name, email or address is stored in D1 or KV after every personhood flow". Per-round person tags are still W6-B's.
- **Other required tests:**
  - `eligibility.test.ts` :: "a country mismatch makes the user ineligible";
  - `callback.test.ts` :: "missing personal details mean not verified: the person ID is bound, kyc_status is unverified";
  - `eligibility.test.ts` :: "missing personal details (kyc_status unverified) mean not verified; attestations are not read";
  - `unverified-identity.test.ts`: all three tests.

## Deviations
- **Files edited outside the prompt's list.**
  - `test/me/me.test.ts`: three exact `stakes.reasons` expectations now include `geo_blocked` and `stakes_disabled`. These are W5-B's defaults (empty allow list, kill switch off); no assertion was removed.
  - `test/routes.test.ts`: added the two personhood rows to `IMPLEMENTED`, which its header asks owners to do.
- **`GET /me` and `PATCH /me` go through `meView`** in `routes/me.ts`, which replaces `buildMe`'s `stakes` with `stakesEligibility`. `auth/profile.ts` `stakesReasons` is now computed and then overridden. I left it alone because `profile.ts` isn't mine (see Open issues).
- **Shared enum.** `STAKES_INELIGIBILITY_REASONS` was renamed to `INELIGIBLE_REASONS`, with `IneligibleReason` and `IneligibleReasonSchema`; deprecated aliases are kept. Three values were added: `country_unverified`, `country_mismatch`, `proxy_detected`. **This changes the response shape for Z:** `MeResponse.stakes.reasons` is wider.
- **Pinned signature.** `stakesEligibility` takes `user: Pick<SessionUser,'id'>` and an optional `opts`. It re-reads the user row rather than trusting the session's cached view.
- **Carry-over fix location.** It is in `createAccount`, not `findAccount`: an unverified claim is released by the sign-up that proves control. `findAccount` still ignores unverified rows.
- **Callback reasons.** The callback's `failed.reason` values are `PERSONHOOD_FAILURES` in `verify.ts`. The shared schema stays `z.string()`.

## Spec issues
1. **Coinbase API (gate 2; confirm with OA-09/W14).**
   - Confirmed from Coinbase's docs:
     - the `login.coinbase.com/oauth2/{auth,token}` endpoints and PKCE S256;
     - the Base and Base Sepolia indexer, attester and schema UIDs (github.com/coinbase/verifications);
     - `getAttestationUid(address,bytes32)`.
   - Not verifiable, and so assumptions:
     - the `/v2/user/personal-details` body (read as `data.address.{country_code|country, state|region}`; the one parser is `parsePersonalDetails`);
     - how a non-ID-verified account is answered (treated as 403, 404 or a body without a country);
     - the scope `identity:user:address:read`;
     - the `CB-VERSION` value.

   Recommend confirming these against the real app before gate 2.
2. **"Data model" has no table for flags and config.** The spec names `geo.stakes.allow` and `mode.stakes.enabled` but no store. Recommend adding `config(key, value_json, updated_at, updated_by)` as built (W11-A edits it).
3. **"Data model" has no tombstone table.** Recommend adding `person_tombstones(person_id, daily_stake_cap, pending_cap, pending_cap_effective_at, created_at)` as built. W7-B writes it.
4. **Unspecified durations.** The spec sets no TTL for a pending merge (built 7 days) or for the OAuth state (built 10 minutes).
5. **Geo granularity.** The verified country is checked at country level: it is allowed if any rule names that country. Region rules (`US-NJ`) apply to the request location only. Recommend writing that into Geo-fencing.
6. **Proxy signals.** Workers get no generic VPN or proxy flag. I built Tor (`T1`) and a Bot Management score below 30. Recommend that the spec name these.
7. **21+ regions.** "Configured per region" has no config key. Recommend a `geo.stakes.age21` list or an entry suffix, for W6-B/W11-A.
8. **Attestation network.** Real users' attestations live on Base mainnet even when staging runs on Base Sepolia, so attestation reads have their own RPC (`ATTESTATION_RPC_URL`). Recommend adding this to "Environments".
9. **Missing personal details.** I bind `person_id` with `kyc_status = 'unverified'`, so that Coinbase account can't verify a second account. A later re-verification without details downgrades `kyc_status`. Please confirm.

## Open issues
- **W6-B:**
  - the ticket path calls `stakesEligibility(env, user, request, { attestationMaxAgeMs: 0 })` and adds the per-round checks;
  - decide whether the entering wallet itself must hold the attestations. Today any linked wallet suffices.
- **W7-B:**
  - write `person_tombstones` on deletion;
  - build merge confirmation for coinbase merges;
  - refuse unlinking the coinbase identity;
  - delete `profile.ts` `stakesReasons`, or make `buildMe` take the eligibility.
- **W11-A:** edit `config`, with an `audit_log` row.
- **W13-D:** document `PERSON_ID_KEY` in the secrets runbook: hex of 32 bytes or more (`openssl rand -hex 32`), and it can never be rotated.
- **Later:**
  - an e2e stack test for personhood (`e2e/tests` isn't mine);
  - Coinbase tokens are discarded, not revoked. Adding `/oauth2/revoke` is optional.

## Notes for D and Z
- **`src/env.ts`:**
  - add the optional vars `ATTESTATION_NETWORK` (`base` everywhere; `base-sepolia` only for Coinbase's test attester) and `ATTESTATION_RPC_URL` (a Base mainnet RPC; a secret if it embeds a key);
  - add the local-only `COINBASE_LOGIN_ORIGIN` and `COINBASE_API_ORIGIN`;
  - then `PersonhoodEnv` in `personhood/config.ts` can become `Env`.
- **`wrangler.jsonc` header:** list `ATTESTATION_RPC_URL` and `ATTESTATION_NETWORK`, and the two local-only origins. `PERSON_ID_KEY` and `COINBASE_CLIENT_ID`/`_SECRET` are already listed.
- **Stack (`e2e/stack/up.mjs`):**
  - start `e2e/mocks/coinbase/server.mjs` (port 8790) and `e2e/mocks/eas/server.mjs` (port 8791) the way the Farcaster mock is started, and add rows for them to `stack:status`;
  - write these `.dev.vars`:
    - `PERSON_ID_KEY`: fresh, 32 bytes of hex;
    - `COINBASE_CLIENT_ID=mock-client-id` and `COINBASE_CLIENT_SECRET=mock-client-secret`;
    - `COINBASE_LOGIN_ORIGIN` and `COINBASE_API_ORIGIN`, both set to the Coinbase mock;
    - `ATTESTATION_NETWORK=base`;
    - `ATTESTATION_RPC_URL`: the EAS mock.
- **Mock behaviour.** To approve as a given account, append `mock_user=` to the authorize URL; `mock_deny=1` declines. The callback redirect goes to `APP_ORIGIN`, so a stack test should re-target its path and query to the API. Miniflare's local `cf` reported US.
- **OA-09 (owner):** register the redirect URI `${APP_ORIGIN}/api/v1/me/personhood/callback` with both scopes.
- **Diffs worth reading:**
  - `verify.ts` `bindStatements`: the `limits` upsert from the tombstone;
  - the `DELETE` in `accounts.ts` `createAccount`;
  - `routes/me.ts` `meView`.
