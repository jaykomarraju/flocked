# W6-B handoff: Ticket signer and `/prepare`

## Status

complete — the signer Worker, `/prepare` with every eligibility branch, the 21+ rule, migration 0012 and the stack test are done, and `pnpm check` is green.

## Summary

- **`apps/signer` (new):**
  - The default export is a `WorkerEntrypoint` with one RPC method, `signTicket({ roundId, wallet, personTag, expiry, ticketHash }) → { signature }` (the pinned shape).
  - `fetch` answers 404, and it has no route and `workers_dev: false`.
  - Before signing it checks the kill switch, recomputes the EIP-712 digest from its own `CHAIN_ID` and deployment, and requires a `stakes_tickets` row with that hash whose wallet, tag, expiry and escrow round ID match. It refuses expired tickets.
  - A refusal rejects with `ticket_refused: <reason>`.
- **Read-only D1:** D1 has no read-only binding, so the signer is read only by construction. Only `src/store.ts` touches `DB`, with two fixed SELECTs (`SIGNER_SQL`). `test/isolation.test.ts` fails on any other `prepare`, `batch`, `exec`, `dump` or `withSession`, or any write SQL, in the signer's source. Both reads hit the primary, so the row apps/api commits first is always visible.
- **`POST /rounds/:id/entries/stakes/prepare` (`apps/api/src/stakes/prepare.ts`).** The checks run in this order:
  1. the kill switch;
  2. the mode is open: D1 says `pending`, the escrow round exists, the time is within `[opensAt, closesAt)`, and the RoundDO is open with no void requested;
  3. `stakesEligibility(…, { attestationMaxAgeMs: 0 })`;
  4. the wallet is linked and verified;
  5. room rounds: membership, and an account at least 24 h older than `closesAt`;
  6. no entry yet;
  7. the daily cap by the round's game day: indexed entries plus used or live tickets, one stake per round.

  Then a conditional insert issues at most one live ticket per user per game day (and per person tag per round). Live means unused, with expiry + 30 s still ahead. Then the signer signs. If the signer fails, the row is deleted and the request answers 503.
- **Person tag:** `personTag` = HMAC-SHA256(`PERSON_TAG_KEY`, "flocked/personTag/v1" ‖ person_id ‖ round ULID).
- **21+:**
  - `geo.stakes.age21` is read in `config-store.ts`, with the same format as the allow list. The rules are in `personhood/age.ts`.
  - An attestation below the required age reads as `age_unattested`.
  - `TosState.ageRequired` names the age in the checkbox.
  - `POST /me/tos` records `users.age_attested_min` and never lowers it.

## Branch and head commit

`w6-b-signer` @ the commit that adds this file (pushed).

## Files touched

- **New:**
  - `apps/signer/**`;
  - `apps/api/src/stakes/{signer,person-tag,cap,prepare}.ts` and `apps/api/src/personhood/age.ts`;
  - `apps/api/migrations/0012_stakes_tickets.sql`;
  - `apps/api/test/stakes/{helpers,prepare.test,isolation.test}.ts`;
  - `e2e/tests/stakes-ticket.test.ts`.
- **Edited:**
  - `apps/api/src/routes/{stakes,me}.ts` and `apps/api/src/personhood/{config-store,eligibility}.ts`;
  - `apps/api/src/auth/profile.ts`: `tosView` and `buildMe` take `ageRequired`;
  - `packages/shared/src/api/me.ts`: `TosState.ageRequired`, optional;
  - `apps/api/test/{migrations,routes}.test.ts`, `apps/api/test/me/me.test.ts` and `apps/api/test/auth/migration.test.ts`;
  - `pnpm-lock.yaml` (the `apps/signer` importer only).

## Tests run

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` (Node 22.23.1) | pass: node:test 20, abi 13, settle 66, tlock 176, shared 439, signer 18, api 722, forge 202 |
| `pnpm format:check` | pass |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run tests/stakes-ticket.test.ts` | pass (3) |
| `pnpm --filter @flocked/e2e exec vitest run` (every stack test, with the new file) | pass: 6 files, 22 tests (329 s) |

## Traceability rows covered

- **ID-5:** `apps/api/test/stakes/prepare.test.ts`:
  - "ID-5: an eligible player gets a signed ticket" (3 tests, including "any linked wallet…");
  - "ID-5: every ineligible branch is refused with its reason…" (14 tests): the kill switch; geo by location and by verified country; country attestation; proxy; not verified, ToS, self-excluded and suspended; age 21+ by request region and by verified country; GET /me plus POST /me/tos; linked wallet; round and mode states; a requested void; room rounds; already entered;
  - "ID-5: the daily cap counts indexed stakes and live tickets by game day" (4 tests, including "a ticket spanning the game-day boundary…").
- **AC-4 (API half):** `prepare.test.ts` › "one person cannot hold tickets for one round on two wallets; a new one only after expiry + 30 s, with the same tag".
- **Concurrency:** `prepare.test.ts` › "concurrency: two simultaneous requests for one person issue one ticket".
- **The signer refuses a hash with no row:** `apps/signer/test/sign.test.ts` › "refuses to sign a hash with no stakes_tickets row".
- **NFR-7:**
  - `apps/api/test/stakes/isolation.test.ts` (4 tests: not a binding, not a var in any environment, not an `Env` field, not read or imported);
  - `apps/signer/test/isolation.test.ts` (Env keys, wrangler per environment, env reads, read-only SQL);
  - `e2e/tests/stakes-ticket.test.ts` › "the escrow trusts the stack key, and the API holds no copy of it".
- **NFR-8 (person tags):**
  - `prepare.test.ts` › "NFR-8: person tags and person IDs never reach a log";
  - `sign.test.ts` › "a refusal logs its reason and round, never the person tag, wallet or ticket hash".
- **Integration:** `e2e/tests/stakes-ticket.test.ts` › "enter accepts the signer's ticket, and Entered carries its hash and person tag". The escrow's `ticketDigest` equals the API's hash, and a ticket signed by any other key reverts with `InvalidTicketSignature`.

## Deviations

- **Edits outside my file list, all minimal:**
  - `test/routes.test.ts`: the IMPLEMENTED row, as that file asks owners to add;
  - `test/me/me.test.ts`: `ageRequired: 18` in a `toEqual`;
  - `test/auth/migration.test.ts`: the users NOT NULL columns gain `age_attested_min`;
  - `meView` in `routes/me.ts`: GET /me must report `ageRequired`.
- **`TosState.ageRequired` is optional** only because `packages/shared/test/fixtures/api/me.json` (not mine) lacks it. Make it required once the fixtures carry it.
- **The e2e test signs through `apps/signer/src/sign.ts`** with an in-memory ticket store, because `/prepare` on the stack needs the `SIGNER` binding and `PERSON_TAG_KEY`, which are D's to wire. It loads the file at runtime, as `indexer-reorg` loads apps/api.
- **Test noise:** workerd logs each refused `signTicket` RPC in the signer tests as "uncaught exception … hung". vitest exits 0 with no "Errors" summary, like W5-Z's DO RPC noise.

## Spec issues

- **Data model:** migration 0012 adds `stakes_tickets.game_day` (the game day of the ticket's round, for the conditional insert) and `users.age_attested_min` (18 or 21). Recommend adding both to the spec.
- **Age and terms:** `AcceptTosRequest.ageAttested` is `true`, so the server records the age it computes for that request. If the location changes between showing the checkbox and posting, it could record an age the user wasn't shown. Recommend `ageAttested: 18 | 21`, the age the checkbox named.
- **`geo.stakes.age21` and the verified country:** only a whole-country entry names the verified country. Region entries apply to the request location only, mirroring the Oct 12 geo rule. Confirm.
- **personTag's `roundId`:** it is the round's ULID (the spec doesn't say which ID). Confirm.
- **Cap gap:** a ticket used in its last seconds but indexed more than 30 s after its expiry isn't counted in between. Recommend counting a ticket until the indexer has passed its expiry, or W6-A setting `used_tx` at ingestion. Today it matters only with several Stakes rounds on one game day.

## Open issues

- **W6-A:** set `stakes_tickets.used_tx`, and write Stakes `entries` rows (with `user_id`, `wallet`, `person_tag`) at ingestion. The cap and the "already entered" check read both.
- **W13:** rotating `PERSON_TAG_KEY` mid-round would give a person a second tag in that round, so rotate it only between rounds. Add it, and `TICKET_SIGNER_KEY` (signer only), to the secrets runbook.
- **W7-B (limits route):** reuse `effectiveDailyCap` and `DEFAULT_DAILY_STAKE_CAP` (100 USDC) from `src/stakes/cap.ts`.

## Notes for D and Z

- **`src/env.ts`:** add `SIGNER: Service` with `signTicket` (`TicketSignerRpc` in `apps/api/src/stakes/signer.ts`), then replace `StakesEnv` with `Env`. Without the binding, `/prepare` answers 503.
- **`apps/api/wrangler.jsonc`:** per environment, add `"services": [{ "binding": "SIGNER", "service": "flocked-signer-local" | "flocked-signer-staging" | "flocked-signer" }]`.
- **Secrets:**
  - `PERSON_TAG_KEY`: an API secret, 32+ bytes of hex. Add it to the stack's `.dev.vars` (fresh each run).
  - `TICKET_SIGNER_KEY`: in `apps/signer` only (`wrangler secret put TICKET_SIGNER_KEY --env <env>`).
- **Stack:**
  - Run the signer beside the API in one `wrangler dev` (`-c apps/api/wrangler.jsonc -c apps/signer/wrangler.jsonc`, so the service binding resolves), with the same `--persist-to` so they share the local D1.
  - The signer's env file is `e2e/stack/.run/ticket-signer.dev.vars` plus `LOCAL_DEPLOYMENT`.
  - The signer has no migrations of its own (`migrations_dir` is unset).
- **Stack workflow:** add a `stakes-ticket` step. The test creates its own escrow round with `OPERATOR_KEY`, so the indexer sees a `RoundCreated` and an `Entered` that no app round owns.
- **Risky diffs to read:** `prepare.ts` (the check order, the conditional insert, the delete on signer failure) and `routes/me.ts` (`POST /me/tos` now writes `age_attested_min`).
