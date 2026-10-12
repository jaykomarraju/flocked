# Wave 6 summary

## Status

Merged to `main` at `3a2d76f`, a `--no-ff` merge of `w6-integration` @ `ae4ed3a`. The tag `wave-6` is on `main`'s head: the commit that adds this summary and the wave-7 prompts. Wave-7 worktrees therefore contain them, and `main` equals the tag.

- All four handoffs were `complete`: W6-A, W6-B, W6-C (with W6-C.2, run in the same session) and W6-D.
- **Review findings on a green wave** (plan.md 2.6, Oct 11 option, owner decision Oct 12): W6-Z's three adversarial reviews found 1 high (after a reorg), 2 medium and about 13 low defects that no test caught, and none is a reveal leak or a room-gating bypass. Wave 7's A, B and C don't edit those files, so W6-Z merged and **W6-F1** runs alongside W7-A/B/C from the tag `wave-6`; W7-D merges it (`wave-6.md` "W6-F1").
- `git diff audit-candidate-1 HEAD -- contracts/src` is empty, on `w6-integration` and on `main` after the merge.

CI:

- `w6-integration` @ `e429b41` (W6-D's code, handoff and the W6-Z prompt): CI run 38262493905 (check, contracts, properties, static-analysis) and Stack run 38262493923 (eight test steps) passed.
- `w6-integration` @ `ae4ed3a` (with W6-Z's spec, plan and `ENDPOINTS` row): CI run 38304543663 (check, contracts, properties, static-analysis) and Stack run 38304543654 (eight test steps) passed.
- `main` @ `3a2d76f`: CI run 38305750514 and Stack run 38305750622 (CI: all four jobs passed. Stack: attempt 1 failed at `free-settle`, where one of the 50 entry POSTs got workerd's non-JSON "Error: Network connection lost" from `wrangler dev`; the re-run (attempt 2) passed all eight steps. W7-D carries the flake). Its tree equals `ae4ed3a`'s. Locally on `main`: `pnpm install --frozen-lockfile && pnpm check` (node:test 20, abi 13, settle 66, tlock 176, shared 453, signer 18, api 844, forge 202) and `pnpm format:check` passed (the format check first flagged settle vectors inside the subagent worktrees under `.claude/worktrees/`, which Prettier scans in the main checkout; it passed once they were removed), and `git diff audit-candidate-1 HEAD -- contracts/src` is empty.

Local checks on `w6-integration` (Node 22.23.1):

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` (at `e429b41`) | abi 13, settle 66, tlock 176, shared 448, signer 18, api 843, forge 202 |
| `pnpm format:check` | pass |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | 202 passed (233 s) |
| `pnpm stack:up` + each stack file in CI order, then `stack:down` | 8 files, 30 passed (smoke 6, lifecycle-open-close 3, free-settle 3, anchor-tx 3, indexer-reorg 4, stakes-ticket 5, stakes-settle 4, claims-wallet 2), about 10 min; `stack:status` `signer` ok before and after |
| After W6-Z's edits: `pnpm check`, `pnpm format:check` | node:test 20, abi 13, settle 66, tlock 176, shared 453, signer 18, api 844, forge 202; format pass |

- Nothing was skipped or weakened. W6-A, W6-B and W6-D each list the tests they changed and why (their Deviations). W6-Z changed `apps/api/test/routes.test.ts` and `test/gating/` only to cover the bundle route's new `ENDPOINTS` row.

## On main now

- **Stakes settlement (W6-A, `settlement/stakes/`, `apply/stakes.ts`, `chain/safe-head.ts`, `indexer/handlers/stakes.ts`):**
  - the RoundDO's close step starts the Stakes SettlementDO. It streams `Entered` logs into R2 (`entered-nnnn.json`), never past the safe head, in 2,000-block ranges halved on refusal;
  - once the safe head passes the close block (`ALERT_SAFE_HEAD_LAG` at beacon + 60 s) it reconciles count and stake sum against `entryCount` / `roundBalance`; a mismatch alerts and is re-read from `BASE_RPC_URL_FALLBACK`, and a second one posts nothing;
  - `prepare` checks D1's entries against the streamed set and each ciphertext against its onchain commitment; the manifest carries `closeBlock`;
  - `applyStakes` reads the chain first, writes the record, outcomes and `bundle_hash`, then `propose`s at most once per `propose:<roundId>:<seq>`;
  - the coordinator follows the proposal: `finalize` at `claimsOpenAt`, a new proposal when the round is Open again, `refundTooFew` (no reveal, no bundle), `refundTimeout` at closesAt + 72 h;
  - handlers for `OutcomeProposed`, `ProposalVetoed` (both directions), `RoundFinalized` (payouts) and `RoundRefunded` 1, 2, 3, 5, 6 (`refund` payouts);
  - ingestion stores each ticketed entry with its ciphertext, un-counts a removal, and keeps a re-add's new block fields;
  - one D1-claimed owner of the operator nonce; S5 (a sent commit stays open until the head passes beacon time); `ManifestAnchored` removals resubmitted; the void receipt lag is an indefinite answer.
- **Ticket signer and `/prepare` (W6-B):**
  - `apps/signer`: a `WorkerEntrypoint` with one RPC method, `signTicket`, no routes, `workers_dev: false`. It recomputes the EIP-712 digest from its own config and signs only a hash whose `stakes_tickets` row matches; two fixed SELECTs are its only D1 access;
  - `POST /rounds/:id/entries/stakes/prepare` runs every check in order (kill switch, mode open incl. a requested void, eligibility, linked verified wallet, room membership and account age, no entry yet, the daily cap by game day), issues one live ticket per user per game day through a conditional insert, then calls the signer (a failure deletes the row and answers 503);
  - `personTag` = HMAC(`PERSON_TAG_KEY`, "flocked/personTag/v1" ‖ person ID ‖ round ULID); 21+ by `geo.stakes.age21`; `POST /me/tos` records `users.age_attested_min`.
- **Read APIs, claims, reveal gating (W6-D, `src/read/`):** `GET /rounds/today` (with the first-visit grant), `/rounds/:id`, `/rounds`, `/rounds/:id/me` (re-signed receipt, inclusion proof, result, payouts, claim proof), `/rounds/:id/verify`, `/rounds/:id/bundles/:mode/:file`, `GET /claims` (merged accounts too) and `?wallet=` (from the bundle alone, root checked). Every per-option field reads through `revealed_at`; room rounds are members-only (anonymous 401, non-member 404), `private, no-store`; anonymous public reads are edge-cached 5 s. `Claimed` / `RefundClaimed` mark `payouts.claimed_at`. Rule 4 writes `refund` payouts for Free and Stakes. `applyFree` sets `revealed_at` before any credit.
- **Design (W6-C):** Paper page `Cards and notifications` (92 artboards: 63 cards in three variants, 16 share screens, 13 notification sheets and emails), exported to `docs/design/exports/{cards,notifications}/`, **frozen** (OA-D4, Oct 12). `packages/shared/src/copy/notifications.ts` holds the final copy as data.
- **Stack:** the signer runs in the API's `wrangler dev`; eight stack tests (`stakes-ticket`, `stakes-settle`, `claims-wallet` added) run in CI's order through `e2e/vitest.config.ts`'s sequencer; `stack:status` has a `signer` row; the Stack workflow has eight steps and a 30-minute timeout.

## Interfaces changed or added

- `apps/signer` (new): `signTicket({ roundId, wallet, personTag, expiry, ticketHash }) → { signature }` over the service binding `SIGNER` (`flocked-signer-local` / `-staging` / `flocked-signer`). `Env.SIGNER` is `TicketSignerRpc` (`src/stakes/signer.ts`) and optional: no binding → `/prepare` answers 503. The API's tests bind a stand-in signer that refuses every ticket (`apps/api/vitest.config.ts`).
- `apps/api/src/chain/safe-head.ts`: `closeBlockFor(client, closesAtSec)`, `safeHeadPast(client, { number, hash })` (a viem client first, unlike the pin). `safeHeadReady(env, roundId, mode, deps?)` and `applyStakes(env, result, deps?)` take optional deps. The Stakes manifest has `closeBlock` (`docs/bundle-format.md`).
- `do/types.ts`: `StakesEntryEvent.removed?`. SettlementDO: Stakes stays in phase `proposing` until the round is final onchain; non-RPC fields `stakesDeps`, `hooks.stakesEntrySet`.
- Indexer handlers, registered by `registerLifecycleHandlers`: `stakes-proposal`, `stakes-veto`, `stakes-finalized`, `stakes-refunded`, and `anchor-confirmation` for `ManifestAnchored`.
- `src/stakes/cap.ts`: `effectiveDailyCap`, `DEFAULT_DAILY_STAKE_CAP` (100 USDC). `src/personhood/age.ts`; `geo.stakes.age21` in `config-store.ts`.
- `packages/shared`: `TosState.ageRequired?` (optional only because the `me.json` fixture lacks it; W7-B makes it required); `SettlementView.settledAt` nullable (a Stakes proposal isn't final); `ENDPOINTS`: `GET /rounds/:id`, `/verify`, `/ws` and `/rounds/:id/card/…` are `auth: 'optional'`, and **`GET /rounds/:id/bundles/:mode/:file`** is a new row (W6-Z, owner decision); `copy/notifications.ts` exported from the index.
- Migrations: `0011` (index `entries_round_stakes_chain_idx`), `0012` (`stakes_tickets` with `game_day`; `users.age_attested_min`), `0013` (index `entries_stakes_wallet_idx`).
- Seams (`src/local/seam.ts`): `POST /__test/stakes/tickets`; `stakes` and `free` options on `POST /__test/rounds/scheduled`; a `stakes` section in `GET /__test/rounds/:id`.

## Decisions

All are owner decisions from Oct 12, 2026. Four Decision log rows were added (Stakes settlement; tickets and age; cards and notifications; read APIs). Sections edited in `Product_Spec.md`: "Round lifecycle" (`revealed_at`; Stakes refund payouts; the Stakes rows), "Sealed picks (timelock encryption)" (Scheme › Round config check; Stakes mode specifics › Entry set), "Identity and personhood" (Identities › account deletion; Entry tickets › `personTag` and the cap), "Data model" (`users`, `rounds`, `stakes_tickets`, `settlement_holds`), "API" (the `/rounds/:id/me`, new bundle and `/claims` rows; Reveal gating), "Client app" (Verify), "Share cards and distribution" (intro; Card content), "Compliance and responsible play" (Age and terms). In `Design_Language.md`: "Share cards" (the accent).

- **Owner actions:** OA-20 (audit) is still not booked. OA-D4 is frozen as is. The domain is **flocked.xyz** (cards, emails, share URLs; W7-C swaps it on the frozen page).
- **Stakes settlement, spec as built:** the backend's coordinator calls `finalize`; every Stakes refund (1, 2, 3, 5, 6) writes `refund` payouts; each reconciliation mismatch alerts, a fallback read that reconciles proceeds, a second mismatch posts nothing; too few entrants → `refundTooFew`, no reveal, no bundle.
- **Refund-proposal veto (new behaviour, W6-F1 O1):** the coordinator alerts and opens a settlement hold (`refund_vetoed`), and proposes again only after the guardian releases it; `refundTimeout` stays the backstop.
- **Tickets and age:** `stakes_tickets.game_day` and `users.age_attested_min` are in the Data model; region entries in `geo.stakes.age21` apply to the request's location only, whole-country entries also to the verified country, and an unknown request region needs 21 when its country has a region entry (W6-F1 O3); personTag uses the round ULID; `ageAttested: 18 | 21` (W7-B); the cap counts an unused ticket until the indexer passes its expiry (W6-F1 O2). The owner had no preference on the last two, so W6-Z took the recommendation (fix both).
- **Cards and notifications:** the accent may also mark the streak pill and the smug sheep's glint; long questions and amounts step down 4 px (floors 32 px and 56 px); `outcome` gains `refundReason` (the share comes from the tally; W9-A); Free refund wording stays; "Got flocked again." after a loss the previous game day; no card image in the outcome email for now; W7-B checks the merge notices.
- **Read APIs:** `/rounds/:id/me` serves the re-signed Free receipt; a round is public only once locked; Free's `revealed_at` precedes any balance move; `payoutAddress` is frozen at lock (W6-F1 O4); the bundle route is in `ENDPOINTS` and the spec's API table (W6-Z); `?wallet=` serves the wallet's own room-round payouts, amount and proof only (W6-F1 O5); claimed foreign entries staying listed by `?wallet=` is an accepted low risk (W13-C re-checks).
- **Fixes:** merge the green wave and run W6-F1 alongside wave 7 (plan.md 2.6, Oct 11 option).

## Traceability

- **Closed (✅):** ID-5, SET-1b (rules 5, 6 close the row), NFR-6 (Stakes closes the row).
- **Advanced (🟡):** PIPE-1 (API, bundles; WS W7-A, cards W10-A, log scan W13-C open), AC-2 (API part), AC-4 (API half; watcher VOID recompute W10-B), ALERT-3 and ALERT-1 (Stakes detection; paging W13-A), NFR-4 (Stakes proposal on the stack; timing at load W14-D), NFR-7 (signer isolation; deploy review W13-D, multisigs OA-17, audit OA-20), NFR-8 (person tags; scan W13-C), E2E-4 (stack evidence: `e2e/tests/claims-wallet.test.ts`; W7-D and W10-D own it).
- Every row assigned to wave 6 has a named, passing test; `docs/plan/traceability.md` names them.

## Carry-over

- **W6-F1** (`wave-6.md` "W6-F1"; alongside W7-A/B/C, merged by W7-D):
  - review fixes R1–R13: the operator nonce gap after a reorg (high), a re-mined proposal stuck at `revealing` (medium), reorged veto/finalize/refund events, `applyStakes` rewrites, the reconciliation's archive read, Free credits checked before the reveal, the edge-cache key, the payout root vs the chain's, Stakes proofs after a reorged proposal, `POST /entries` and room existence, orphan refund rows, the signer's expiry bound, a second ticket for an entered round;
  - owner decisions O1–O5: the refund-veto hold (plus a seam to release it), the cap until the indexer passes expiry, unknown region → 21, `payoutAddress` frozen at lock, own room-round items by wallet.
- **W7-A:** `/ws` stays behind `requireRoundAccess` and sends nothing per option before `revealed_at`; the RoundDO's Stakes status stays `settle_proposed` after `RoundFinalized` (D1 is the record).
- **W7-B:** reuse `effectiveDailyCap` / `DEFAULT_DAILY_STAKE_CAP`; `ageAttested: 18 | 21`; make `TosState.ageRequired` required; keep the cap per person across merges and re-verification; check the merge notice copy.
- **W7-C:** on the frozen Cards and notifications page, "flocked.app" → "flocked.xyz", the "@jay" share previews → a sample handle; re-export.
- **W7-D:** merge W6-F1; E2E-6 releases the refund-veto hold through W6-F1's seam; anvil's clock lags wall time after `indexer-reorg` (mine before chain-time steps); the harness's HTTP helper handles `wrangler dev`'s dropped request (the `free-settle` flake on `main`, below).
- **W9-A:** Stakes notifications; `refundReason` in `outcome`. **W10-A:** the card route is already gated; satori notes per artboard, fonts as TTF, inlined SVG poses, the step-down, the accent rule, `flocked.xyz`. **W10-C:** lowercase `?wallet=`. **W11-A:** release a settlement hold. **W14-C:** the refund-veto runbook.
- **W13:** the `RoundFinalized` payouts insert at 100k and per-isolate proof trees (W13-B); retention of `entered-*.json` and Stakes ciphertexts, claimed foreign entries (W13-C); `PERSON_TAG_KEY` (rotate between rounds only), `TICKET_SIGNER_KEY` (signer only), `BASE_RPC_URL_FALLBACK` in staging and production (W13-D); ALERT-3 and ALERT-1 paging, the `refund_proposal_vetoed` alert (W13-A).
- Each is written into the later wave file's "Carry-over from W6-Z" section.

## Owner actions

- **OA-20 (gate 3, audit):** not booked as of Oct 12. It is the critical path: W15 needs the report. Send `docs/audit/package.md` with the contracts at `audit-candidate-1`, still unchanged after wave 6.
- **OA-D3:** review the Paper `Social` page and the Settings states. Needed by W11 (W7-C's Paper fixes touch the Streaks board and the Settings notifications row first).
- **OA-D2:** the Core flow freeze, needed by W9. Review it after W7-C removes the header link.
- **OA-D5:** the Admin console in Paper, after W7-C. Needed by W12.
- **OA-09:** the Coinbase OAuth app (redirect `${APP_ORIGIN}/api/v1/me/personhood/callback`, scopes `wallet:user:read`, `identity:user:address:read`). Start by W8.
- **OA-22:** policy confirmed; W14-A checks the response shape with OA-09's app (🟡).
- **OA-21:** legal text by W12; it also sets `geo.stakes.allow` and `geo.stakes.age21`.
- **OA-04:** Workers Paid and the deploy token. Start by W10.
- **OA-17:** the admin and guardian multisigs. Start by W10.
- **OA-07:** DNS and email sending for `flocked.xyz`, needed by W14 (start by W12).

## Next wave

The prompts are `docs/prompts/W7-A.md`, `W7-B.md`, `W7-C.md`, `W6-F1.md` and `W7-D.md`. W7-A, W7-B, W7-C and W6-F1 run in parallel from the tag `wave-6`; W7-D merges all four.

Migrations are reserved: W7-A `0014`, W7-B `0015`, W6-F1 `0016`. The session prompt reserved `0016` for W7-D; W6-Z gave it to W6-F1, because O1's `refund_vetoed` hold needs a `settlement_holds` rebuild (`0008`'s reason CHECK), and wave 8 starts at `0017`. W7-D has no number: a schema change it needs goes into `0016` before the merge to `main`.

Changes from `wave-7.md`: W7-D merges W6-F1 as a fourth branch; W7-A's `broadcast()` seam is `rounds/hooks.ts`, not a method of `round-do.ts`; W7-B takes `ageAttested: 18 | 21` and the cap across merges; W7-C swaps the domain on the frozen cards page; W7-D's E2E-6 releases the refund-veto hold.

Stack tests can reuse `POST /__test/rounds/scheduled` (with `stakes`), `POST /__test/stakes/tickets`, the cron driver, `GET /__test/rounds/:id` and `GET /__test/bundles/...`; the real `/prepare` path runs on the stack (`e2e/tests/stakes-ticket.test.ts`).
