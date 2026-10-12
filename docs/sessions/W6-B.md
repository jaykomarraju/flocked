# W6-B handoff: Ticket signer and `/prepare`

## Status
partial — signer Worker, `/prepare`, migration 0012 and the API/signer tests are done; the e2e stack test and a confirmed full `pnpm check` are left for W6-B.2 (usage limit).

## Summary
- `apps/signer` (new): default-export `WorkerEntrypoint` with one RPC method `signTicket` (pinned shape); `fetch` answers 404, no route, `workers_dev: false`. It checks the kill switch, recomputes the EIP-712 digest from its own `CHAIN_ID`/deployment, requires a `stakes_tickets` row with that hash whose wallet/tag/expiry/escrow round match, refuses expired tickets, then signs. Refusals reject with `ticket_refused: <reason>`.
- D1 is kept read only by construction: only `src/store.ts` touches `DB`, with two fixed SELECTs (`SIGNER_SQL`); `test/isolation.test.ts` fails on any other prepare/batch/exec/write SQL. D1 has no read-only binding mode.
- `POST /rounds/:id/entries/stakes/prepare` (`apps/api/src/stakes/prepare.ts`): kill switch → mode open (D1 `pending` + RoundDO open, no void requested) → `stakesEligibility(…, {attestationMaxAgeMs: 0})` → wallet linked → room membership + 24 h account age → no entry → daily cap by game day (indexed entries + used/live tickets, one stake per round) → conditional insert (one live ticket per user per game day, and per person tag per round; live = unused and expiry + 30 s ahead) → signer. A signer failure deletes the row and answers 503.
- `personTag` = HMAC-SHA256(PERSON_TAG_KEY, "flocked/personTag/v1" ‖ person_id ‖ round ULID).
- 21+: `geo.stakes.age21` in `config-store.ts`; `personhood/age.ts`; `age_unattested` when the attested age is below the requirement; `TosState.ageRequired`; `POST /me/tos` records `users.age_attested_min` (never lowered).

## Branch and head commit
`w6-b-signer` @ (see `git log`; pushed)

## Files touched
New: `apps/signer/**`, `apps/api/src/stakes/{signer,person-tag,cap,prepare}.ts`, `apps/api/src/personhood/age.ts`, `apps/api/migrations/0012_stakes_tickets.sql`, `apps/api/test/stakes/{helpers,prepare.test,isolation.test}.ts`.
Edited: `apps/api/src/routes/{stakes,me}.ts`, `apps/api/src/personhood/{config-store,eligibility}.ts`, `apps/api/src/auth/profile.ts` (`tosView`, `buildMe` take `ageRequired`), `packages/shared/src/api/me.ts` (`TosState.ageRequired`, optional), `apps/api/test/{migrations,routes}.test.ts`, `apps/api/test/me/me.test.ts`, `pnpm-lock.yaml` (signer importer).

## Tests run
| Command | Result |
| --- | --- |
| `apps/signer`: typecheck, lint, `vitest run` | pass (18) |
| `apps/api`: typecheck, lint | pass |
| `apps/api`: `vitest run test/stakes test/migrations.test.ts test/routes.test.ts test/me test/personhood` | pass (283) |
| `pnpm check`, `pnpm format:check` | started, result not confirmed before the limit: W6-B.2 runs them first |
| e2e `stakes-ticket.test.ts` | not written |

## Traceability rows covered
- ID-5: `apps/api/test/stakes/prepare.test.ts` (issue; any linked wallet; kill switch; geo; country attestation; proxy; verified/ToS/self-exclusion/suspended; age 21+ by region and by verified country; GET /me + POST /me/tos; linked wallet; round/mode states; requested void; room rounds; already entered; cap with live tickets, indexed stakes, cap raise/decrease, game-day boundary).
- AC-4 (API half): `prepare.test.ts` › "one person cannot hold tickets for one round on two wallets…".
- Concurrency: `prepare.test.ts` › "concurrency: two simultaneous requests for one person issue one ticket".
- Signer refuses a hash with no row: `apps/signer/test/sign.test.ts` › "refuses to sign a hash with no stakes_tickets row".
- NFR-7: `apps/api/test/stakes/isolation.test.ts`, `apps/signer/test/isolation.test.ts`.
- NFR-8 (person tags): `prepare.test.ts` › "NFR-8 … across issue, every refusal and a signer failure"; signer `sign.test.ts` › logs.
- Open: e2e integration (ticket verifies in `FlockedEscrow.enter` on anvil).

## Deviations
- Edited outside the list, minimally: `test/routes.test.ts` (IMPLEMENTED row, as that file asks owners), `test/me/me.test.ts` (`ageRequired: 18` in a `toEqual`), and `meView` in `routes/me.ts` (GET /me must report `ageRequired`).
- `TosState.ageRequired` is optional only because `packages/shared/test/fixtures/api/me.json` (not mine) lacks it.
- workerd logs each refused `signTicket` RPC as "uncaught exception … hung" in signer tests; vitest exits 0 (like W5-Z's DO RPC noise).

## Spec issues
- Data model: new `stakes_tickets.game_day` and `users.age_attested_min` (0012). Recommend adding both.
- Age and terms: `POST /me/tos` takes `ageAttested: true`, so the server records the age it computes for that request; recommend `ageAttested: 18 | 21`.
- `geo.stakes.age21` and the verified country: only a whole-country entry names it (region entries apply to the request only). Confirm.
- personTag's `roundId` is the round ULID (spec ambiguous). Confirm.
- Cap gap: a ticket used in its last seconds but indexed more than 30 s after expiry isn't counted in between. Recommend counting a ticket until the indexer has passed its expiry, or W6-A setting `used_tx` at ingestion.

## Open issues
- W6-B.2: e2e test, full `pnpm check` + `format:check`, finish this handoff.
- W6-A: set `stakes_tickets.used_tx` and write Stakes `entries` rows at ingestion (the cap and "already entered" read them).
- W13: rotating `PERSON_TAG_KEY` mid-round would give a person a second tag in that round; rotate only between rounds.

## Notes for D and Z
- `env.ts`: `SIGNER: Service` with `signTicket` (see `apps/api/src/stakes/signer.ts` `TicketSignerRpc`); then drop `StakesEnv`.
- `apps/api/wrangler.jsonc` per env: `"services": [{ "binding": "SIGNER", "service": "flocked-signer[-staging|-local]" }]`.
- Secrets: `PERSON_TAG_KEY` (API, 32+ bytes hex), `TICKET_SIGNER_KEY` (signer only).
- Stack: run `apps/signer` beside the API (`wrangler dev -c apps/api/wrangler.jsonc -c apps/signer/wrangler.jsonc`, same `--persist-to` so they share D1), with `e2e/stack/.run/ticket-signer.dev.vars` plus `LOCAL_DEPLOYMENT` for the signer; add `PERSON_TAG_KEY` to the API's `.dev.vars`.
