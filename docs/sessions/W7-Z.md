# Wave 7 summary

## Status

Merged to `main` at `7af610f`, a `--no-ff` merge of `w7-integration` @ `a40567d`. The tag `wave-7` is on `main`'s head: the commit that adds the wave-8 prompts after this summary. Wave-8 worktrees therefore contain them, and `main` equals the tag.

- All five handoffs were `complete`: W7-A, W7-B, W7-C, W6-F1 (the wave-6 review fixes) and W7-D.
- **Review findings on a green wave** (plan.md 2.6, Oct 11 option, owner decision Oct 12): W7-Z's four adversarial reviews (W7-A, W7-B, W6-F1, W7-D) found no high defect and no reveal leak or room-gating bypass, but 3 medium and about 12 low defects that no test caught. Wave 8's A, B and C don't edit those files, so W7-Z merged and **W7-F1** runs alongside W8-A/B/C from the tag `wave-7`; W8-D merges it (`wave-7.md` "W7-F1", R1–R18). The third medium (the `ui` project's two-phase rule, latent until a `ui` spec exists) goes to W8-C.
- **W7-Z's own fix** (`98af33f`, test hardening, no behaviour change): two W7-A WebSocket tests failed under load. `coalescing.test.ts` measured `counts` gaps at the receiver (855 and 871 ms against 900), so the hub now stamps each fan-out with `releasedAt` and the test checks the hub's spacing. `reveal-gating.test.ts` (and DO-5's window step) read a fresh snapshot right after a D1-only change, and a new socket on an earlier socket's shard got the 1 s kept snapshot; `freshSnapshot()` waits it out. The coalescing mutation (no spacing) still fails both tests. `fanout.test.ts` compares results with `toMatchObject` because of the new field.
- `git diff audit-candidate-1 HEAD -- contracts/src` is empty on `w7-integration` and on `main` after the merge.

CI:

- `w7-integration` @ `1541362` (W7-D's head with the W7-Z prompt): CI run 38328906692 (check, contracts, properties, static-analysis), Stack run 38328906604 (eight steps) and E2E run 38328906592 (19 tests) passed.
- `w7-integration` @ `a40567d` (W7-Z's test fix, spec, plan and copy): CI run 38342267490 (check, contracts, properties, static-analysis), Stack run 38342267454 (eight steps) and E2E run 38342267577 passed..
- `main` @ `7af610f`: CI run 38344201841, Stack run 38344201864 and E2E run 38344201862 (on the merge; its tree equals `a40567d`'s). Locally on `main`: `pnpm install --frozen-lockfile && pnpm check` (node:test 20, abi 13, settle 66, tlock 176, shared 468, signer 19, api 950, forge 202), `pnpm format:check` and `git diff audit-candidate-1 HEAD -- contracts/src` (empty) passed..

Local checks on `w7-integration` (Node 22.23.1; the stack on `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239`, because another project's `workerd` held 9229):

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` at `1541362`, twice, with four review agents loading the machine | failed: `ws/reveal-gating.test.ts` (both runs), `ws/coalescing.test.ts` (871 ms) and a 10 s hook timeout in `read/claims.test.ts` (second run, load) |
| `vitest run test/ws/` after the fix, three runs | 5 files, 18 passed each time |
| `pnpm check` at `a40567d` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 468, signer 19, api 950, forge 202 |
| `pnpm format:check` | pass |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | 202 passed (325 s) |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run` + `stack:down` | 8 files, 30 passed (about 9.5 min) |
| fresh stack: `pnpm stack:up && pnpm e2e && pnpm stack:down` | 19 passed (api 16, api-warp 3) in 19.1 min |

- Nothing was skipped or weakened. Each handoff lists the tests it changed (W7-A: three `/ws` stub pins; W7-B: the `ageAttested` literals, email and AuthDO tests; W6-F1: the refund-veto test for O1, `prepare.test.ts` for R10 and O2; W7-D: `stakes-ticket.test.ts`, a cast in `fanout.test.ts`). W7-Z changed the three WS tests above.

## On main now

- **WebSocket (W7-A, `src/ws/`, `do/round-viewer-do.ts`):** `GET /rounds/:id/ws` behind `requireRoundAccess` → a `RoundViewerDO` shard by FNV-1a(connection ID) mod `WS_VIEWER_SHARDS` (16 by default), WebSocket Hibernation, a `state` snapshot (D1, gated by `revealed_at`; kept 1 s per shard, patched by `counts`), 30 s catch-up, `counts` coalesced to one per second per round, `revealing` at beacon time, `refunded.provisional`/`finalAt`. 256 sockets over 16 shards in the Workers runtime.
- **Identity (W7-B, `src/identity/`, `src/limits/`):** linking with proof (SIWE, Farcaster, email code; Coinbase through W5-B), Farcaster-verified wallet offers (`FARCASTER_HUB_URL`, unset: none), unlink limits, pending merges with every refusal and the kept-account transfers in one D1 batch, deletion (anonymize, tombstone with `user_id` and cap state, card re-renders queued), the cap (decrease now, raise after 24 h), self-exclusion, `security_notice` enqueues, audit rows; reserved handles, no email enumeration, email codes in AuthDO, suspended accounts read-only.
- **W6-F1:** R1–R13 and O1–O5 (the operator nonce after a reorg, reorged Stakes events undone in D1, the `refund_vetoed` hold and its seam release, the cache key, live-proposal proofs, room-round 404s on entry routes, the signer's expiry bound, the cap until the indexer passes expiry, `payoutAddress` frozen at lock, `roomClaims`), each with a mutation-checked test.
- **e2e (W7-D):** Playwright 1.64 in `e2e/` (`pnpm e2e`: projects `api` then `api-warp`), fixtures `stack`, `wallet`, `user`, `clock`, `rounds`, `http`, `phase`; six API-level specs (lifecycle, stakes-claims, stakes-veto, stakes-copy, drand-outage, stakes-timeout); `e2e.yml` in CI; a Turnstile siteverify mock (`:8792`); the seam's 404 body, `holds` and question category.
- **Design (W7-C):** the Paper page `Admin` (41 states × desktop and tablet, 82 exports in `docs/design/exports/admin/`), the Oct 12 fixes on Core flow, Components, Social and Cards (flocked.xyz, "@woolgatherer"), and `screens.md`'s Freeze column now `frozen` for Foundations, Components, Core flow and Cards (W7-Z).

## Interfaces changed or added

- `packages/shared/src/ws.ts`: `refunded` gains `provisional` and `finalAt` (a provisional Free refund is refused).
- `packages/shared/src/api/me.ts`: `AcceptTosRequest.ageAttested: 18 | 21`, `TosState.ageRequired` required; `reserved-handles.ts` exported. `api/claims.ts`: `ClaimsResponse.roomClaims?` (`{chainRoundId, kind, account, amount, proof, claimsOpenAt}`, only with `?wallet=`). `config.ts`: `StakesLockedConfig.payoutAddress?`.
- `apps/api/src/env.ts`: `WS_VIEWER_SHARDS?`, `FARCASTER_HUB_URL?`; `TURNSTILE_SITEVERIFY_URL` honoured only in `local`. `do/types.ts`: `AuthDORpc` replaced by `AuthDOMethods` (`do/auth-do.ts`). The `broadcast()` seam is `rounds/hooks.ts`; `ws/hub.ts` `FanoutResult.releasedAt` (W7-Z).
- Signer: `RefusalReason` `expiry_too_far`. `settlement/apply/stakes.ts`: `ProposalHeldError`.
- Migrations: `0015` (identity: `person_tombstones.user_id`, offers, …), `0016` (`settlement_holds` rebuilt with `refund_vetoed`). `0014` unused.
- Seam: `POST /__test/holds/release`, `holds` in `GET /__test/rounds/:id`, the app's 404 body.
- Copy: `merge_pending` push and email (W7-Z, owner-approved). Tokens: `type.caption.weight` 500 (W7-Z).

## Decisions

All are owner decisions from Oct 12, 2026; the owner took every recommendation. Five Decision log rows (W7-Z): real time and claims; identity and responsible play; reorgs, holds and tickets; admin, questions and analytics; design language.

Sections edited in `Product_Spec.md`: "Round lifecycle" (a reorged Stakes event), "Settlement and payout math" (creator and `payoutAddress` at lock), "Modes: Free and Stakes" (Free kill switch, `geo.deny`), "Identity and personhood" (Identities: suspended accounts, account deletion; Merging accounts; Entry tickets (Stakes)), "Data model" (`settlement_holds`, `person_tombstones`, `config`, `indexer_state`, AuthDO email codes), "API" (the `/me/merges/:id/confirm`, `/claims` and `/me/limits` rows; Reveal gating), "Real-time and the reveal" (RoundDO responsibilities, WebSocket messages, Reveal choreography), "Question pipeline" (Approve; House questions), "Client app" (RoundDO down), "Profiles, leaderboards and rooms" (Game day and streaks, Leaderboards, Rooms), "Notifications" (`question_rejected`; `identity_unlinked`), "Admin console" (queue, pause, search), "Compliance and responsible play" (Geo-fencing, Responsible play), "Analytics" (Dashboard metrics), "Testing and acceptance criteria" (E2E-6). In `Design_Language.md`: "Typography" (caption Inter 500 muted; `mono`) and "Shape and layout" (no switch; destructive confirms).

- **Real time:** `refunded.finalAt` is when the RoundDO learns of a final refund (D1 `final_at` is the record); a refunded mode's snapshot has `result: null`; the Stakes reveal is the confirmed `OutcomeProposed`.
- **Identity and responsible play:** email codes in AuthDO, nonces in KV; `person_tombstones.user_id`; either account confirms a merge by proving one of the other's identities, one pending merge per pair, only different person IDs refuse for good; **the merged cap is the lower cap in force, and only that side's pending raise survives** (re-verification by the same rule); **no chained merges** (30 days for both accounts); **maximum daily cap 1,000 USDC** (`limits.stakes.maxDailyCap`); timed → permanent restarts the 6-month clock, permanent again cancels a lift, calendar months; a deleted owner's rooms pass to the oldest member; `identity_unlinked` notice; suspended accounts may still lower the cap, self-exclude and edit notification prefs.
- **Reorgs, holds, claims:** a reorged Stakes event's D1 effect is undone and alerts; a second refund veto reopens the hold, history from `audit_log`; `roomClaims` named; `indexer_state.last_block_timestamp` for "processed past expiry"; the creator and `payoutAddress` set together at lock.
- **Admin, pipeline, analytics:** pause blocks Stakes entries only and `/prepare` refuses while paused; the Streaks pill wraps the top live streak's current streak; Approve `submitted → queued`, `question_rejected` with the reason, backlog alert below 14, a day with nothing to lock has no round (neutral for streaks); `geo.deny` blocks both modes and wins over allow, `mode.free.enabled` is Free's kill switch; dashboard metric definitions; RoundDO-down client state; admin search matching; `mono` token; no switch; destructive confirms keep the accent CTA.
- **E2E wording:** E2E-6 "holds until the guardian releases it, then is proposed again and finalizes"; AC-1 unchanged, its evidence split; `/claims` lists the live proposal's payouts during the window.
- **Copy and design:** the merge-notice copy approved and applied; the caption token 500; the share sheets' "J" avatar → "W", Settings keeps "6 of 9 on", nav labels stay ink 400 ("nav label"), the Admin geo lists stay placeholders for OA-21.
- **Fixes:** merge the green wave and run W7-F1 alongside wave 8 (plan.md 2.6, Oct 11 option).

## Traceability

- **Closed (✅):** DO-5 (`ws/snapshot.test.ts` › "DO-5…"), ID-1 (`test/identity/{link,unlink,merge,delete,cap}.test.ts`), E2E-6 (`stakes-veto.spec.ts`), E2E-10 (`stakes-copy.spec.ts`), E2E-14 (`drand-outage.spec.ts`).
- **Advanced (🟡):** PIPE-1 (WS half: `ws/reveal-gating.test.ts`; cards W10-A, log scan W13-C), E2E-1 and E2E-2 (API: `lifecycle.spec.ts`; UI halves later), AC-1 (local: `lifecycle.spec.ts` + `stakes-claims.spec.ts`), E2E-4 (API: `stakes-claims.spec.ts`; UI W10-D), AC-5 (timeout part: `stakes-timeout.spec.ts`), E2E-9 (API: `limits/limits.test.ts` › "E2E-9 (API)…"; UI W12-D), AC-2 and AC-4 (W6-F1 and WS parts). W6-F1's tests are added to ID-5, NFR-6 and NFR-7.
- Every row assigned to wave 7 has a named, passing test; `docs/plan/traceability.md` names them. R1–R13 and O1–O5 each have W6-F1's named, mutation-checked test (`W6-F1.md` table; 35 mutations re-run on the merged tree by W6-F1, and W7-D's merges touched none of its source files).

## Carry-over

- **W7-F1** (`wave-7.md` "W7-F1"; alongside W8-A/B/C, merged by W8-D; migration `0020`): R1 a late viewer never gets `revealing` (medium); R2 the merge cap rule (medium); R3 the 1,000 USDC maximum; R4–R6 catch-up order, the hub chain's `.catch` and timeout, `revealed` after the D1 commit; R7–R12 deletion, live-ticket, `person_id` and bind races, chained merges, `/prepare` status, suspended personhood; R13–R17 the re-included veto, `newNonce` with a lagging count, who writes `bundle_hash`, `payoutRoot` compared, `holds.ts` types; R18 `indexer_state.last_block_timestamp`.
- **W8-A:** creator and `payoutAddress` at lock; the pipeline rules and the no-round day (`scheduler/lock.ts`); a check on `questions.category`; `account_suspended`; the `question_rejected` event with draft copy for W8-Z. **W8-B:** no-round days neutral; boards exclude deleted and merged accounts; `GET /me/referrals`. **W8-C:** the `ui` two-phase rule (medium, latent), `globalTimeout`, no game clock behind anvil after a warp, the GET retry opt-out; the Foundations caption row and the nav-label note in Paper; the `mono` token. **W8-D:** merge W7-F1; a deleted owner's rooms; `account_suspended` on rooms; the Stakes `onModeFinal` call.
- **W8-Z:** the OA-D3 review and its Paper fixes with the Streaks pill and the "W" avatar (a design subagent, before W11); approve W8-A's `question_rejected` copy.
- **Later:** W9-A (`identity_unlinked`, `question_rejected` copy; push subscribe stays open to suspended accounts), W9-C (RoundDO-down state, WS client rules, no reveal animation for refunded modes), W10-A (deleted accounts' cards and cache purge), W10-C ("claimable at"), W10-D (Smart Wallet stand-in), W11-A (pause and `/prepare`, `geo.deny`, `mode.free.enabled`, admin search, W7-C's schema gaps, holds), W11-D (WebSocket tokens for the mini app; the Farcaster hub), W12-B (the delete sheet's "Claim all", the maximum cap, suspended limits), W12-D (dashboard metrics), W13-B (a restored refund with no driver; re-sending a dropped operator tx), W13-C (WS upgrade limits), W14-D (e2e time; hibernation under load). Migrations from wave 9 shift by one (W9-A `0021`, W9-D `0022`, wave 10 `0023`/`0024`, wave 11 `0025`/`0026`, wave 12 `0027`).
- Each is written into the later wave file's "Carry-over from W7-Z" section.

## Owner actions

- **OA-20 (gate 3, audit):** in talks with an auditor (Oct 12), not booked, no report date. It is the critical path: W15 needs the report. `contracts/src` is still unchanged from `audit-candidate-1`.
- **OA-D5 (Admin):** review before **W11** (moved up from W12; W11-A builds the admin API from it). W7-C's open questions were answered (avatar, "6 of 9", nav labels, placeholders).
- **OA-D3 (Social, Settings):** review by W11; W8-Z applies its fixes.
- **OA-D2 (Core flow):** frozen Oct 12. **OA-D1:** still frozen after W7-C's kit fixes; W8-C starts with wave 8.
- **OA-09:** the Coinbase OAuth app (redirect `${APP_ORIGIN}/api/v1/me/personhood/callback`, scopes `wallet:user:read`, `identity:user:address:read`): start now (W8).
- **OA-11:** Farcaster app, account, signer and manifest, plus the Farcaster hub for wallet offers (Neynar's needs an API key), by W11.
- **OA-04:** Workers Paid and the deploy token, start by W10. **OA-17:** the admin and guardian multisigs, start by W10.
- **OA-21:** legal text by W12; it also sets `geo.stakes.allow`, `geo.stakes.age21`, `geo.deny` and may lower `limits.stakes.maxDailyCap`. **OA-22:** checked by W14-A. **OA-07:** DNS and email for `flocked.xyz`, needed by W14 (start by W12).

## Next wave

The prompts are `docs/prompts/W8-A.md`, `W8-B.md`, `W8-C.md`, `W7-F1.md` and `W8-D.md`. W8-A, W8-B, W8-C and W7-F1 run in parallel from the tag `wave-7`; W8-D merges all four.

Migrations are reserved: W8-A `0017`, W8-B `0018`, W8-D `0019`, W7-F1 `0020`.

Changes from `wave-8.md` as first planned: W8-D merges W7-F1 and wires the Stakes `onModeFinal` call; W8-A may edit `scheduler/lock.ts` (creator at lock, the no-round day); W8-B edits only the referrals handler in `routes/me.ts`; W8-C fixes the e2e harness first and owns `e2e.yml` and two Paper text fixes; W8-Z applies the OA-D3 Paper fixes. OA-D1 is frozen, so W8-C starts now.
