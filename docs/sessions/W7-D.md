# W7-D handoff: e2e harness and backend lifecycle e2e

## Status

complete — wave 7 and W6-F1 are merged on `w7-integration` with `contracts/src` unchanged; `pnpm e2e` runs the six API-level specs green on a fresh stack, and `e2e.yml` runs them in CI.

## Summary

- **Merge:** W6-F1, W7-A, W7-B, W7-C with `--no-ff` (in that order). Conflicts: `apps/api/test/routes.test.ts` (W7-A's and W7-B's `IMPLEMENTED` rows) and `test/migrations.test.ts` (W7-B's `0002`/`0015` blocks and W6-F1's `0016`); every side kept. W7-B's `prepare.test.ts` `ageAttested` edit merged cleanly into W6-F1's file.
- **Registrations ("Notes for D"):** `Env.WS_VIEWER_SHARDS?` (W7-A) and `Env.FARCASTER_HUB_URL?` (W7-B), both unset, listed in the `wrangler.jsonc` header; the casts in `ws/shards.ts` and `identity/offers.ts` dropped. `AuthDORpc` removed from `do/types.ts` (`AuthDOMethods` in `do/auth-do.ts` is the surface). W7-B's `reserved-handles` export and W6-F1's migration and seam route came with the merges; the seam route's row is in `e2e/stack/README.md`. No `cap.ts` change (W7-B: none needed).
- **W3-Z carry-over:** a Turnstile siteverify mock (`e2e/mocks/turnstile`, `:8792`) runs on the stack; the API calls it through `TURNSTILE_SITEVERIFY_URL`, honoured only when `ENVIRONMENT` is `local` (`lib/turnstile.ts` `siteverifyUrl`). No stack test calls Cloudflare now (the mock counted 109 calls over the eight stack files). The seam's 404 body is the app's (`Not found`).
- **Harness:** `e2e/playwright.config.ts` (Playwright 1.64.0), `pnpm e2e`, fixtures `stack`, `wallet`, `user`, `clock` (`e2e/fixtures/`), and an HTTP helper that names a non-JSON answer and retries only idempotent requests (a Free entry is one; a retry that finds it landed reads it back from `/rounds/:id/me`).
- **Specs** (`e2e/tests/*.spec.ts`): lifecycle, stakes-claims, stakes-veto, stakes-copy, drand-outage, stakes-timeout. Projects `api` and `api-warp` (see Deviations).
- **Fixes found by the specs:** the seam's questions had category `'test'`, outside `CATEGORIES`, so `GET /rounds/:id` failed `RoundDetailResponseSchema` for every seam round; now `'other'`. `e2e/tests/stakes-ticket.test.ts` sent `ageAttested: true`, which W7-B's `18 | 21` refuses; it now sends `GET /me`'s `ageRequired`.

## Branch and head commit

`w7-integration` @ `c645a33` (code; this handoff and the W7-Z prompt are the next commits)

## Files touched

- New: `e2e/playwright.config.ts`, `e2e/fixtures/{index,http,stack,wallet,user,clock,rounds,phase}.ts`, `e2e/tests/{lifecycle,stakes-claims,stakes-veto,stakes-copy,drand-outage,stakes-timeout}.spec.ts`, `e2e/mocks/turnstile/{server.mjs,README.md}`, `e2e/ui/README.md`, `.github/workflows/e2e.yml`, `docs/sessions/W7-D.md`, `docs/prompts/W7-Z.md`.
- Edited (mine): `apps/api/src/env.ts`, `wrangler.jsonc`, `src/do/types.ts`, `src/lib/turnstile.ts`, `src/local/seam.ts` (404 body, `holds` in the round view, question category), tests `test/local-seam.test.ts`, `test/lib.test.ts`; `e2e/stack/{env,up,status}.mjs`, `e2e/stack/README.md`, `e2e/package.json`, `e2e/tsconfig.json`, root `package.json`, `pnpm-lock.yaml`.
- Integration fixes in A/B files: `src/ws/shards.ts`, `src/identity/offers.ts` (casts), `src/do/auth-do.ts` (comment), `test/ws/fanout.test.ts` (an `as Env` and its import, now unneeded), `e2e/tests/stakes-ticket.test.ts` (`ageAttested`).

## Tests run

| Command | Result |
| --- | --- |
| `pnpm lint && pnpm typecheck && pnpm test` after the merges and registrations | pass: node:test 20, abi 13, settle 66, tlock 176, shared 468, signer 19, api 950 |
| `pnpm format:check` | pass |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run` (merged tree) | pass: 8 files, 30 tests; `stack:status` ok with the new `turnstile` row |
| `pnpm e2e`, first pass, spec by spec on one stack | 23 tests pass after two spec fixes (an `undefined` mode, `/claims` listing a payout in the window by design) and the seam's category fix |
| `pnpm stack:up && pnpm e2e && pnpm stack:down`, fresh stack, first try | 9 passed, then the API died: another project on the Mac (`ad-studio/…/buyananswer`) started its own `wrangler dev` on port 8787 mid-run and our `wrangler dev` and cron driver stopped. Not a Flocked failure; its processes were left alone |
| the same with `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239`, fresh stack | pass: 19 tests (api 16, api-warp 3) in 19.1 min; `stack:status` all ok before and after (drand back after the outage spec) |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | pass, 202 (262 s); `git diff audit-candidate-1 HEAD -- contracts/src` empty |
| `pnpm install --frozen-lockfile && pnpm check` at `c645a33`, first try | 1 failure: W7-A's `test/ws/coalescing.test.ts` › "a steady stream for about 2.5 s…" measured an 855 ms gap between `counts` messages (it allows 900). The machine was loaded (setup 608 s); see Open issues |
| `pnpm check` again, machine idle | pass: node:test 20, abi 13, settle 66, tlock 176, shared 468, signer 19, api 950, forge 202 |
| CI / Stack / E2E on `w7-integration` @ `c645a33` | CI run 38325813122 (check, contracts, properties, static-analysis), Stack run 38325813123 (eight steps) and E2E run 38325813257 (19 passed in 19.5 min; job 21 min): success |
| Mutation checks (one replacement, the test file with `-t`, restore) | 4 of 4 caught: the seam's old 404 message; the siteverify override honoured outside `local`; `holds` dropped from the seam view; the seam question's `'test'` category |
| `git diff wave-6 HEAD -- contracts/src` | empty |

## Traceability rows covered

- **E2E-1 (API):** `e2e/tests/lifecycle.spec.ts` › "E2E-1: players sign in and verify, and the round is scheduled (setup)" (SIWE, Coinbase OAuth mock, EAS attestation, the Terms) and "E2E-1: the scheduler locks and opens it; every player enters Free and Stakes" (`POST /entries`; `/prepare` → signer → `enter`).
- **E2E-2 (API):** same file › "E2E-2: it closes, the beacon arrives, and both modes reveal on their own" (Free settled, Stakes proposed, both `revealedAt` ≥ beacon time, the tally, the proposal's amounts) and "E2E-2: each player sees the Free result and their outcome".
- **AC-1 (local):** all of `lifecycle.spec.ts`, moved only by the cron driver and the DOs' alarms; "AC-1: no seam call after the setup" checks the seam counter. The Stakes half ends at the proposal; its finalize after the 2 h window is E2E-4's (Deviations).
- **E2E-4 (API):** `stakes-claims.spec.ts` › "four players enter, and the backend proposes after the beacon" (in the window `/claims` lists each payout and the escrow refuses with `WrongStatus`) and "after the window: finalize, then each player claims exactly what /claims lists" (win, two rebates, a VOID refund; once only; payouts + fee + creator fee + dust = the stakes).
- **E2E-6:** `stakes-veto.spec.ts` › "a one-sided round: the backend proposes a refund", "the guardian vetoes it: Open again, the proposal superseded, a refund_vetoed hold", "nothing is proposed while held; once released, the coordinator proposes again", "after its window the round settles: refunded, every stake claimable".
- **E2E-10:** `stakes-copy.spec.ts` › "the second player enters the first one's ciphertext, byte for byte" and "both copies decrypt to the same pick, are tallied, and both win" (the root is @flocked/settle's with both).
- **E2E-14:** `drand-outage.spec.ts` › the four tests (drand stopped; commitment anchored; past beacon + 24 h, rule 8 refunds with no reveal; balances restored, and drand's late beacon changes nothing).
- **AC-5 (timeout part):** `stakes-timeout.spec.ts` › "three players and a foreign entry; the hold keeps every proposal back" and "past closesAt + 72 h the backend calls refundTimeout; every entrant is refunded". `stakes-claims.spec.ts` adds "exact claims after the window, losers only their rebate, claims ≤ derived totals".
- **W3-Z carry-over:** `apps/api/test/local-seam.test.ts` › "answers the app's own 404 body, closed or open"; `test/lib.test.ts` › "calls the siteverify override only in local".

## Deviations

- **A third Playwright project, `api-warp`** (the pin names `api` and `ui`). anvil's clock only moves forward and the escrow refuses `createRound` once its clock is past opensAt, so no round can be made after a warp, and three specs warp (claims +2 h, the veto's finalize +2 h, the timeout +72 h). `api` plays every spec's rounds; `api-warp` (depends on `api`) runs the `@warp`-tagged tests once all those rounds exist, each warping to at least its own target. A spec hands its round to its warp phase in `e2e/stack/.run/e2e/<spec>.json`. In a full run the timeout's warp also finalizes the veto round (its window ended earlier), so the veto's warp test finds it final.
- **E2E-6 ends in a finalized refund, not a winning settlement.** The re-proposal after the release is deterministic (spec "Round lifecycle" says so), so it repeats the refund; "the round settles" is that proposal finalized, with refunds claimed. See Spec issues.
- **AC-1's Stakes half stops at the proposal** (the reveal); finalize needs the contract's fixed 2 h window, which a no-manual-step spec can't wait for. E2E-4 finalizes and claims after the warp, also with no manual call.
- **The timeout scenario** keeps the operator from proposing with a real cause rather than a new seam: a foreign entry (a ticket signed with the stack's ticket-signer key that the API never issued) opens a `foreign_entry` hold.
- **No Coinbase Smart Wallet stand-in:** no API-level spec needs one (entries are EOA `enter` calls). `fixtures/wallet.ts` notes where W10-D's paymaster adds it.
- **The guardian** is impersonated by anvil (`asRole`): `stack:up` drops the guardian's key, and the prompt's "guardian's anvil key" isn't kept anywhere.
- Changed existing tests: `stakes-ticket.test.ts` (`ageAttested`, W7-B's schema) and `ws/fanout.test.ts` (a cast). Nothing skipped or weakened. No schema change, so `0016` is untouched.

## Spec issues

1. **"Testing and acceptance criteria" › E2E-6** ("a vetoed refund proposal is followed by a settlement") vs "Round lifecycle" (the re-proposal is deterministic and repeats the refund unless a fix is deployed). Recommend: "a vetoed refund proposal holds until the guardian releases it, then is proposed again and finalizes".
2. **AC-1** ("settles … automatically") for Stakes: within one daily round the automatic path ends at the proposal; finalize comes 2 h later. Recommend AC-1 read "Free settles and Stakes proposes", with finalize under AC-5/E2E-4.
3. **"API" › `/claims`:** during the challenge window it already lists the live proposal's payouts with their proof and `claimsOpenAt`, though the escrow refuses a claim until final. Recommend the row say so (clients show "claimable at").

## Open issues

- **D1 values are served unchecked:** the seam's `'test'` category broke `GET /rounds/:id` for clients only (the API answered 200). A reader that parses with the shared schemas (or a CHECK on `questions.category`) would catch a bad row. W8-A (questions) or W13-C.
- **W6-F1 open issue, not done here:** `OutcomeProposed.payoutRoot` is never compared in D1 (`indexer/handlers/stakes.ts`). W13-B.
- **W7-B optional, not done:** call `refreshFarcasterOffers` from `/auth/farcaster`. W8-B or later.
- **E2E time:** about 23 minutes on the owner's Mac (each Stakes round waits for its beacon and the safe head; the veto spec waits one hold poll). Running the warp specs' rounds concurrently would cut it; W14-D if CI time matters.
- **Smart wallet stand-in** for the paymaster specs: W10-D.
- **A wall-time flake in W7-A's coalescing test:** it times `counts` messages when the test receives them, so delivery jitter under load can shrink a gap below its 100 ms allowance (once in four full runs here). Recommend stamping each `counts` with its send time in the hub, or asserting the hub's own send log. W7-Z or W8.

## Notes for D and Z

- `pnpm e2e` needs a fresh stack (`api-warp` leaves anvil 72 h ahead); to re-run one spec, `cd e2e && npx playwright test --project=api tests/<spec>` and then `--project=api-warp --no-deps`.
- **Port clash:** if another local project uses port 8787, run the stack elsewhere: `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239 pnpm stack:up` (the fixtures read the URL from `.state.json`).
- `drand-outage` stops drand's containers and starts them again in `afterAll`; a run killed in between leaves drand down (`docker compose -f e2e/stack/docker-compose.yml start`).
- The RoundDO arms each alarm for (event time − game clock) of wall time, so pinning the clock forward does not fire an alarm armed earlier until its wall time. E2E-14 pins past beacon + 24 h before the beacon-time alarm fires, which then finds both events due.
- New seam field: `holds` in `GET /__test/rounds/:id`. New stack port: `turnstile` 8792 (`STACK_TURNSTILE_PORT`).
- Risky diffs worth reading: `e2e/fixtures/clock.ts` (`warpTo` never moves either clock back), `e2e/fixtures/http.ts` (retry rule), `apps/api/src/lib/turnstile.ts` (the override is local-only).
