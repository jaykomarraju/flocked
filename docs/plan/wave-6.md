# Wave 6: Stakes

**Goal.** Stakes works end to end at the API and contract level: tickets issued by an isolated signer after full eligibility checks, entries indexed, the tally proposed onchain after the safe head passes the close block, transitions tracked through finalize. All public read endpoints, claims and reveal gating exist. Share cards and notifications are designed.

**Base.** Tag `wave-5`. **Migrations reserved:** W6-A `0011`, W6-B `0012`, W6-D `0013`.

## Pinned interfaces

- **Signer boundary (W6-B):** `apps/signer` is a separate Worker with one RPC entrypoint, `signTicket({ roundId, wallet, personTag, expiry, ticketHash }) → { signature }`, reachable only through a service binding `SIGNER` from `apps/api`. It verifies that a `stakes_tickets` row with that `ticket_hash` exists (read-only D1 binding) before signing, and holds only `TICKET_SIGNER_KEY`.
- **Safe-head input (W6-A → W5-A's SettlementDO):** `apps/api/src/chain/safe-head.ts` exports `closeBlockFor(closesAt)` and `safeHeadPast(block)`. W6-A implements it. SettlementDO awaits `safeHeadReady(env, roundId, mode)` from `apps/api/src/settlement/safe-head.ts` (W5-A's stub: true for Free only); W6-A makes that predicate use `chain/safe-head.ts` and writes `closeBlock` into the Stakes manifest (`docs/bundle-format.md`).
- **Read models (W6-D):** responses conform to `packages/shared/src/api/{rounds,claims}.ts`. W6-A and W6-B don't touch `routes/rounds.ts` or `routes/claims.ts`.

## W6-A: Stakes settlement

- **Role / size:** build, M.
- **Objective.**
  - Between close and the beacon, stream `Entered` logs up to the close block into chunk files, and reconcile the count and stake sum against `entryCount`/`roundBalance` at that block. On a mismatch, retry with the second RPC provider and alert, and post nothing.
  - Wait for the safe head to pass the close block (ALERT-3 at beacon + 60 s).
  - `applyStakes`: post `propose` with (n0, n1, nVoid, payoutRoot, bundleHash). Stakes payout leaves come from the settle output (win, rebate when r > 0, void_refund).
  - Register the indexer handlers for `OutcomeProposed`, `ProposalVetoed` (both directions, superseding settlements), `RoundFinalized`, and `RoundRefunded` reasons 1 and 6.
  - Call `finalize` (gasless; operator-sent in backend) at `claimsOpenAt`.
  - Keep the `refundTooFew` and `refundTimeout` triggers available to anyone, and have the backend call them when due.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W5-Z.md`. This section. `docs/bundle-format.md`. Spec: "Round lifecycle" (Stakes rows), "Sealed picks (timelock encryption)" (only "Stakes mode specifics"), "Smart contract" (only "Rules the contract enforces" bullets for `propose`, `veto`, `finalize`, `refundTimeout`), "Settlement and payout math" (only "Stakes closed form", "Settlement output").
- **Owns.** `apps/api/src/settlement/apply/stakes.ts`, `apps/api/src/settlement/stakes/**`, `apps/api/src/chain/safe-head.ts`, `apps/api/src/indexer/handlers/stakes.ts` (D registers it), migration `0011`, `apps/api/test/settlement/stakes-*.test.ts`.
- **Required tests.** SET-1b (rules 5, 6). ALERT-1 (reconciliation), ALERT-3. A local-stack Stakes round proposes and the contract-derived amounts equal settle's (NFR-4 part). The veto of a refund proposal returns the mode to `revealing` and it settles again. Idempotent `propose` retries don't double-post (a retry checks onchain status first).
- **Risks.** RPC log limits; keeping the bundle hash identical across retries.

## W6-B: Ticket signer + `/prepare`

- **Role / size:** build, M.
- **Objective.** Build the `apps/signer` Worker, and `POST /rounds/:id/entries/stakes/prepare`. The endpoint runs every eligibility check: mode open and flag on, verified, wallet linked, geo (country and request) plus proxy signals, age and ToS current, not suspended or excluded, the daily cap counting indexed stakes plus live tickets, no entry yet, and room-round membership and account age. It computes `personTag` (HMAC), serializes issuance per person through a conditional D1 insert (one live ticket per person per game day; reissue only after expiry + 30 s), commits the `stakes_tickets` row, then calls the signer. The kill switch `mode.stakes.enabled` stops tickets immediately.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W5-Z.md`. This section. Spec: "Identity and personhood" (only "Entry tickets (Stakes)"), "Compliance and responsible play", "Modes: Free and Stakes" (flags paragraph).
- **Owns.** `apps/signer/**`, `apps/api/src/stakes/**`, `apps/api/src/routes/stakes.ts`, migration `0012`, `apps/api/test/stakes/**`.
- **Required tests.** ID-5 (all branches). A ticket signed by the signer verifies in `FlockedEscrow.enter` on anvil (integration). The signer refuses to sign a hash with no row. Concurrency: two simultaneous `/prepare` calls for one person issue one ticket. AC-4 (API half). NFR-7 (signer isolation: `apps/api` has no access to `TICKET_SIGNER_KEY`, asserted by a config test).
- **Risks.** Daily-cap arithmetic across game days; tickets spanning the game-day boundary.

## W6-C (design): share cards and notifications

- **Role / size:** design, M.
- **Objective.** Design the share cards (result win/loss/refund, Free and Stakes, amounts shown or multiple only, streak ≥ 2, teaser, generic round card) in all three variants (1200×630, 1200×800, 1080×1080), proven legible at 25% scale. Also the share sheet, OG landing page `/s/:shareId`, notification copy for every event per channel (Farcaster, web push, email), and the email templates.
- **Read first.** `plan.md` §5.4. `docs/design/README.md`, `docs/design/screens.md`. `Design_Language.md` (all, especially "Share cards"). Spec: "Share cards and distribution", "Notifications". Schemas: `packages/shared/src/api/cards.ts`, `packages/shared/src/queues.ts`.
- **First step.** Confirm the Paper MCP tools; if missing, stop as `blocked`.
- **Owns.** Paper page `Cards and notifications`; `docs/design/screens.md` (cards and notifications sections); `docs/design/exports/cards/**`, `docs/design/exports/notifications/**`; `packages/shared/src/copy/notifications.ts` (final notification copy as data, keyed by event and channel).
- **Note for W10-A.** Cards are rendered by satori, which supports a subset of CSS (flexbox, no grid). Design within it, and add a note on each card artboard about layout primitives.

## W6-D: Read APIs, claims, reveal gating

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C, then build the read endpoints:
  - `GET /rounds/today` (full locked config, Stakes `RoundConfig`, author handle and payout address, beacon round/time, counts; edge cache 5 s);
  - `GET /rounds/:id` (per-mode settlement once revealed);
  - `GET /rounds?before=&limit=`;
  - `GET /rounds/:id/me` (entries, receipts, inclusion proofs, result, payout, claim proof);
  - `GET /rounds/:id/verify`;
  - `GET /claims` (incl. merged accounts) and `GET /claims?wallet=` (from public bundle data, no sign-in).

  Enforce reveal gating everywhere (no per-option data before `revealed_at`; rooms members-only).
- **Read first.** `plan.md` §2, §3.4. Handoffs W6-A, B, C. Spec: "API" (rows above and "Reveal gating"), "Identity and personhood" (only the account-deletion bullet on `GET /claims?wallet=`).
- **Owns.** Registry files; `apps/api/src/routes/{rounds,claims}.ts`; `apps/api/src/read/**`; migration `0013`; `apps/api/test/gating/**`, `apps/api/test/read/**`.
- **Required tests.** PIPE-1 (API and bundle halves). AC-2 (API part): a test walks every GET route before and after the reveal and asserts no option-level data leaks pre-reveal. Claim proofs from `/claims?wallet=` verify against the onchain root in an anvil test.
- **Emits.** W6-Z prompt.

## W6-F1: Wave-6 review fixes (added by W6-Z, Oct 12, 2026; alongside W7-A/B/C, merged by W7-D)

- **Why.** Wave 6 was green, but W6-Z's three adversarial reviews found defects no test caught, and five owner decisions (Oct 12) need small code changes. Wave 7's A, B and C don't edit these files, so the owner chose the Oct 11 option (plan.md 2.6): W6-Z merged wave 6, and W6-F1 runs alongside W7-A/B/C from the tag `wave-6`. W7-D merges it as a fourth branch.
- **Role / size:** fix, M. Branch `w6-f1-review-fixes`, worktree `../flocked-w6-f1`. Migration `0016` (W7-D's number, reassigned by W6-Z on Oct 12): O1's reason `refund_vetoed` is not in `settlement_holds`'s reason CHECK (`0008_settlement.sql`), so the table is rebuilt as `0008` did. No change to `contracts/src` (the audit candidate).
- **Owns.** `apps/api/src/chain/operator.ts`, `src/indexer/handlers/stakes.ts`, `src/settlement/{apply/free,apply/stakes,stakes/entry-set}.ts`, `src/do/settlement-do.ts`, `src/read/{cache,proofs,me,claims}.ts`, `src/routes/entries.ts`, `src/rounds/entry.ts`, `src/lifecycle/handlers.ts`, `src/stakes/{cap,prepare}.ts`, `src/personhood/age.ts`, `src/scheduler/lock.ts`, `src/local/seam.ts` (one route), `apps/signer/src/**`, and their tests. Not `src/do/round-do.ts`'s `broadcast()`, `src/ws/**` (W7-A), `src/routes/me.ts`, `src/identity/**`, `src/limits/**` (W7-B), or `e2e/**` (W7-D).
- **Review fixes** (each with a test that fails without it):
  - R1 (high, after a reorg): the operator nonce allocator (`newNonce`) puts a new nonce past every stored row for the key, whatever its status, so a mined or reverted transaction that a reorg drops leaves a gap no send fills, and every later operator send (createRound, voidRound, propose, finalize, refunds) stalls. Only `pending` rows may push the next nonce up; a finished row at a nonce at or above the chain's pending count frees that nonce.
  - R2 (medium): a proposal re-mined after its removal was handled (the removal and the re-add in different polls) leaves D1 at `revealing` with no payouts, and `RoundFinalized` then finds no record. On an `OutcomeProposed` add with no current record, un-supersede the latest record with the same bundle hash.
  - R3: removals of `ProposalVetoed`, `RoundFinalized` and `RoundRefunded` only alert. Restore the D1 state a re-mined or replaced event needs (at least: a dropped veto must not leave `refund` payouts beside a later `RoundFinalized`).
  - R4: `applyStakes` rewrites every entry row on each call (every ~23 s while a propose is pending). Skip the writes when this `seq`'s record already exists with the same bundle hash.
  - R5: reconciliation reads `getRound` at the close block; a provider without that historical state errors, which is retried but never moves to the fallback provider. Treat it as a provider failure: re-read from `BASE_RPC_URL_FALLBACK`.
  - R6: `applyFree`'s credit integrity checks (`creditsOf`) run after the `revealed_at` update, so a credit bug leaves a round revealed but never paid. Compute the credits before the reveal.
  - R7: the edge cache keys on the full URL, and unknown query parameters pass validation, so `?x=<random>` bypasses the cache (and `/claims?wallet=` rebuilds payout trees each time). Key on the path plus the validated, sorted query.
  - R8: `/claims?wallet=` compares the rebuilt payout root only with the manifest's. Also check it against the root recorded from the chain (`settlements` / `round_modes.bundle_hash` from `OutcomeProposed`).
  - R9: after a reorg removes `OutcomeProposed`, Stakes `revealed_at` stays set and `/me` serves proofs for a proposal not onchain. Gate Stakes proofs on the status too.
  - R10: `POST /rounds/:id/entries` tells a signed-in non-member that a room round exists (`not_member`, after Turnstile); answer 404 like the read routes.
  - R11: an `Entered` removal deletes the entry but leaves any `refund` payouts row written for it. Delete it too.
  - R12: the signer signs any expiry. Refuse an expiry more than the ticket lifetime plus a small slack ahead.
  - R13: the per-person-per-round branch of the ticket insert requires `used_tx IS NULL`, so a second-wallet ticket can be issued for an entered round (the escrow rejects the entry). Drop that condition.
- **Owner decisions (Oct 12, 2026; spec edited by W6-Z):**
  - O1: after a guardian veto of a refund proposal, the coordinator alerts and opens a settlement hold (reason `refund_vetoed`, PK `(round_id, mode, reason)`; a second refund veto of the same round reuses the released row, so reopen it); it proposes again only once the guardian releases it (the admin action, like any hold). `refundTimeout` at closesAt + 72 h stays the backstop. Add a keyed seam route that releases a hold (`src/local/seam.ts`, local only) for W7-D's E2E-6; the admin API (W11-A) releases it in staging and production.
  - O2: the daily cap counts an unused ticket until the indexer has processed past its expiry, not only until expiry + 30 s.
  - O3: `geo.stakes.age21`: when the request has no region code and an entry names a region of the request's country, 21 is required.
  - O4: the Stakes `payoutAddress` is frozen into the round's `config_json` at lock (`scheduler/lock.ts`) and read from there.
  - O5: `GET /claims?wallet=` also lists the wallet's own unclaimed room-round payouts with only the chain round ID, amount and proof: no question, room or other members' data.
- **Optional, if the budget allows:** a kill-switch refusal from the signer mid-request answers `stakes_disabled`, not 503; a failed DELETE after a signer failure is retried.
- **Required tests.** One per item above, each mutation-checked. `pnpm check`, `pnpm format:check` and the stack tests in CI order stay green.

## W6-Z checklist

- ID-5, SET-1b (5, 6), PIPE-1 (API, bundles), ALERT-3, AC-4 (API half) proven.
- Ask the owner to review Cards and notifications in Paper (OA-D4 before W10).
- Migrations for wave 7: W7-A `0014`, W7-B `0015`, W7-D `0016`.

## Carry-over from W2-Z (Oct 8, 2026)

- **W6-D:** `GET /rounds/:id`, `/rounds/:id/verify`, `/rounds/:id/ws` and `/rounds/:id/card` are `auth: 'none'` in `ENDPOINTS`, but room rounds are members-only. Gate room rounds on membership (make them `optional`) and keep room-round responses out of the unauthenticated edge cache.
- **W6-A:** `payouts.user_id` is NOT NULL, but a foreign entry (Decision log, Oct 8: `entries.user_id` NULL with `foreign_entry` = 1) has no user. If the guardian lets such a round settle, its payout lives only in the Stakes payout tree and bundle, or W6-A makes `payouts.user_id` nullable in its migration. Decide and test it.

## Carry-over from W3-Z (Oct 9, 2026)

- **W6-D:** the first-visit daily grant: `GET /rounds/today` with a session calls `applyDailyGrant` (`apps/api/src/rounds/grant.ts`), never `grantMovement`, or a skipped grant could be credited later that day.
- **W6-A:** Stakes ingestion beyond the `ingestStakesEntry` counters W4-D adds.

## Carry-over from W4-Z (Oct 11, 2026)

- **W6-A:**
  - The rest of Stakes ingestion. That includes un-counting a reorged `Entered`: `StakesEntryEvent` has no `removed`, and the handler only logs `stakes_entry_removed`.
  - Handlers for `OutcomeProposed`, `ProposalVetoed`, the other `RoundRefunded` reasons and `RoundFinalized`, plus `finalize` at `claimsOpenAt`. Register them with `registerHandler(event, name, fn)` in `apps/api/src/indexer/handlers.ts`, and keep handler names stable. Effects outside D1 are at least once.
  - A serialised operator nonce: `createRound` (cron), `voidRound` (RoundDO alarm), and `propose` / `finalize` (indexer) share `OPERATOR_KEY`. W4-F1 hardens `TxSender`, but a single owner of the nonce is still needed.
  - Stakes settlement doesn't post while `settlement_holds` has an open hold.
- **W6-B:** ticket issuance refuses while the RoundDO has a void requested (`getState().voidRequested`) or the Stakes `round_modes.status` isn't `pending` (Decision log, Oct 11). `round_modes` alone misses a pending void.
- **W6-D:** the first-visit grant calls `recordPriorTransactions` (`apps/api/src/rounds/grant.ts`) before `applyDailyGrant`, so a wallet-only account's onchain history counts.

## Carry-over from W5-Z (Oct 12, 2026)

- **All:** read `docs/sessions/W5-Z.md` for the spec sections changed on Oct 12 and for W5-F1, the review fixes W5-Z ran before merging (settlement retries and the anchored root, `TxSender` and void proof, the personhood callback). Stack tests can reuse `POST /__test/rounds/scheduled`, the cron driver, `GET /__test/rounds/:id` (settlement fields), `GET /__test/bundles/:id/:mode/:file`, and `e2e/tests/free-settle.test.ts`'s pattern.
- **W6-A:**
  - the safe head (see Pinned interfaces) and `closeBlock` in the manifest;
  - Stakes ciphertexts: `prepare` reads them from `entries.ciphertext` and throws without them, so Stakes ingestion must store them from `Entered`;
  - `applyStakes(env, result)` (the hooks take `env`; W5-A). SettlementDO already checks `settlementHold` first, and a held job sits in phase `applying` with `error: "held:<reason>"`;
  - from W4-F1: after a block move `ingestStakesEntry` gets a re-add with new block fields, but it is idempotent by (tx, logIndex), so the stored fields stay old. Update them, and un-count a removed entry;
  - a confirmed manifest anchor that is reorged out is never resubmitted (`applyFree` skips any known anchor state, and no handler resubmits on removal). Resubmit it for both modes, as W4-F1 did for `Locked` / `Committed`;
  - the serialised operator nonce (W4-Z carry-over) builds on W5-F1's `chain/{tx,operator}.ts` and the tick's cancellation sweep.
  - rule 7 trusts an AnchorDO commit state of `failed` (`settlement/prepare.ts` `anchoredCommitment`), but a version sent before the deadline can still land before beacon time (`anchor-do.ts`: a write that lands after its key failed still counts), so the mode could be refunded although its commitment was anchored in time. Keep a failed commit open in the AnchorDO until the chain has passed beacon time (`expire` and the pre-send check), so `failed` is final when the SettlementDO reads it. W5-F1 found it (its S5) and left it, because the fix is in the AnchorDO; W6-A may edit `anchor-do.ts` for it.
  - a void can still be abandoned at close when its receipt lags across two reads a block apart: the taken-nonce rule answers `nonce_consumed`, the re-sign is refused after close, and `runOperatorTx` returns `pending` without `nonceTaken`, which counts as definite. Make that answer indefinite while doing the operator-nonce work (W5-F1 left it open).
- **W6-B:**
  - the ticket path calls `stakesEligibility(env, user, request, { attestationMaxAgeMs: 0 })` (`apps/api/src/personhood/eligibility.ts`), then adds the per-round checks;
  - any linked wallet holding the attestations satisfies them; the entering wallet need not (owner decision, Oct 12);
  - 21+: the config key `geo.stakes.age21` (country and region codes, in the `config` table from migration 0009) names the places that need 21+. The age check and the checkbox copy name 21 when the verified country or the request's region is listed.
- **W6-C:** Free refunds by rules 7 and 8 (commitment not anchored, beacon unavailable) are real outcomes and need refund cards and notification copy, like rule 4.
- **W6-D:**
  - every Free refund writes `refund`-kind `payouts` rows (owner decision, Oct 12). Rules 7 and 8 do (`refundFree`); rule 4 doesn't yet. Make `applyVoid` (`apps/api/src/lifecycle/void.ts`) write them idempotently, with a test, so `/rounds/:id/me` reads one shape. W6-D owns that change;
  - Free settlement data: `settlements.tally_json` is the API's `TallySchema`; `winners_json` holds `{winner, refundReason, voidCount, voidStake, total, creatorAward, awardRecipient}`; `tx_hash` is the manifest anchor. Bundles are at `bundles/{roundId}/{mode}/` (`docs/bundle-format.md`). Modes refunded before the reveal (rules 4, 7, 8) have no bundle;
  - `MeResponse.stakes.reasons` uses the widened `INELIGIBLE_REASONS` (W5-B).
