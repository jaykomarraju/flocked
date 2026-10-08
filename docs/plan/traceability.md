# Traceability

Every item in the spec's "Testing and acceptance criteria" (Required tests and Acceptance criteria), every row of the "Non-functional requirements" table and every Alert maps to the session that implements it and the test or check that proves it.

- **Session** is the session that implements the behaviour and writes the proving test. Where a row needs more than one session, all are listed, and the row closes when the last one passes.
- **Proof** names the test file or check. Sessions replace the planned path with the real `file::test name` in their handoff, and Z copies it here.
- **Status:** ⬜ open · 🟡 partly proven · ✅ proven on `main`. Only Z edits this file.

## Required tests: settlement (`@flocked/settle`)

| ID | Requirement | Session | Proof (planned) | Status |
| --- | --- | --- | --- | --- |
| SET-1 | Refund rules 1–3 and headcount ties, in the math | W1-C | `packages/settle/test/refunds.test.ts` :: "SET-1 refund rules 1–3", "SET-1 room qualification (countQualifyingOnly)" | ✅ |
| SET-1b | Refund rules 4–8 produce the right mode outcome: 4 (void) W4-D; 5, 6 W6-A; 7, 8 W5-D | W4-D, W5-D, W6-A | Workers tests in `apps/api/test/settlement/*.test.ts`, `apps/api/test/lifecycle/void.test.ts` | ⬜ |
| SET-2 | Cap binding and not binding; rebates to losers | W1-C | `packages/settle/test/cap.test.ts` :: "SET-2 cap and rebates" | ✅ |
| SET-3 | Headcount minority holding more stake than the majority (Free) | W1-C | `packages/settle/test/free.test.ts` :: "SET-3 Free: headcount minority holding more stake" | ✅ |
| SET-4 | VOID entries of each kind (non-canonical header, wrong target round, wrong chain, `not_anchored`, out-of-range Free stake, bad plaintext, bad option, decrypt failure) excluded and refunded | W1-C (math), W2-A (classification), W5-A (pipeline) | Math: `packages/settle/test/void.test.ts` :: "SET-4 VOID entries are excluded from tallies and refunded" (W1-C). Classification (W2-A): `packages/tlock/test/classify.test.ts` :: "TL-3: malformed ciphertexts and bad plaintexts are VOID with their exact reason". Open (W5-A): `not_anchored`, the Free stake range and the pipeline, `apps/api/test/settlement/void.test.ts` | 🟡 |
| SET-5 | Single-base-unit stakes | W1-C | `packages/settle/test/edge.test.ts` :: "SET-5 single-base-unit stakes" | ✅ |
| SET-6 | Largest Stakes values in `bigint` | W1-C | `packages/settle/test/edge.test.ts` :: "SET-6 largest Stakes values in bigint" | ✅ |
| PROP-1 | Property: invariant always holds; no payout negative | W1-C | `packages/settle/test/properties.test.ts` :: "property > PROP-1: the invariant always holds and no payout is negative" | ✅ |
| PROP-2 | Property: winner payout in [s, (1+cap)·s]; loser in [0, s] | W1-C | `packages/settle/test/properties.test.ts` :: "property > PROP-2: winner payout in [s, (1+cap)·s]; loser payout in [0, s]" | ✅ |
| PROP-3 | Property: dust < losing headcount | W1-C | `packages/settle/test/properties.test.ts` :: "property > PROP-3: dust is below the losing headcount" | ✅ |
| PROP-4 | Property: results independent of entry order | W1-C | `packages/settle/test/properties.test.ts` :: "property > PROP-4: results are independent of entry order" | ✅ |
| PROP-5 | Property: Stakes closed form equals the general formula | W1-C | `packages/settle/test/properties.test.ts` :: "property > PROP-5: the Stakes closed form equals the general formula per entry" | ✅ |

## Required tests: contracts (Foundry)

| ID | Requirement | Session | Proof (planned) | Status |
| --- | --- | --- | --- | --- |
| CON-1 | All reverts, including every `createRound` validation and launch ceiling | W1-B | `contracts/test/Escrow.CreateRound.t.sol` :: `test_createRound_*` (12, incl. `_stakeCeilings`, `_feeCeilings`, `_capMultipleCeilings`, `_beaconDelayBoundaries`); `contracts/test/Escrow.Reverts.t.sol` :: `test_constructor_*`, `test_unknownRound_reverts`, `test_wrongStatus_onRefundedRound`, `test_roleChecks` | ✅ |
| CON-2 | Ticket signature, wallet binding, expiry, per-person dedupe | W1-B | `contracts/test/Escrow.Enter.t.sol` :: `test_enter_revertsOnWrongSigner`, `_revertsOnTamperedTicket`, `_revertsWhenWalletIsNotSender`, `_revertsOnTicketForOtherRound`, `_revertsOnExpiredTicket`, `_ticketValidAtExactExpiry`, `_rejectsSamePersonTagFromAnotherWallet`, `_rejectsSecondEntryFromSameWallet`, `_domainUsesBlockChainId` | ✅ |
| CON-3 | `voidRound` only before close; `refundTooFew` only when `entryCount < minEntrants` | W1-B | `contracts/test/Escrow.Refunds.t.sol` :: `test_voidRound_byGuardianJustBeforeClose`, `test_voidRound_revertsAtOrAfterClose`, `test_refundTooFew_afterCloseWithTooFew`, `_revertsBeforeClose`, `_revertsWithEnoughEntrants`, `test_claimRefund_*` | ✅ |
| CON-4 | `propose` tally checks and derived amounts | W1-B | `contracts/test/Escrow.Propose.t.sol` :: `test_propose_revertsWhenTallyDoesNotMatchEntryCount`, `_refundReason1..3_*`, `_settleDerivesClosedForm`, `_capBindsAndRebates`, `_matchesStakesMath`, `_minEntrantsBoundary` | ✅ |
| CON-5 | Challenge window, veto in both directions, `finalize` | W1-B | `contracts/test/Escrow.Challenge.t.sol` :: `test_veto_settleProposalBecomesRefundedReason5`, `test_veto_refundProposalReturnsToOpenAndCanBeReproposed`, `test_veto_revertsAtClaimsOpenAt`, `test_finalize_settleCreditsTreasuryFeePlusDustAndCreatorFee`, `test_finalize_revertsDuringWindow`, `test_finalize_refundProposal` | ✅ |
| CON-6 | Per-kind claim limits; `withdraw` with a creator that cannot receive USDC | W1-B | `contracts/test/Escrow.Claim.t.sol` :: `test_claim_perKindLimitsCapTotalAtPostedTally`, `test_claim_rebateLimitWithExtraLeaves`, `test_claim_everyKindPaysDerivedAmountAndDrainsRound`, `test_withdraw_creatorThatCannotReceiveNeverBlocksRound` | ✅ |
| CON-7 | `refundTimeout`, pause behaviour, role timelocks (72 h; guardian 7 d; immediate revocations) | W1-B | `contracts/test/Escrow.Roles.t.sol` :: `test_refundTimeout_onlyAfterCloseplus72h`, `test_pause_blocksEnterOnlyAndIsImmediate`, `test_operatorGrant_requiresTimelock`, `test_operatorRevocation_isImmediate`, `test_ticketSigner_disableIsImmediateAndRotationIsTimelocked`, `test_treasury_timelocked72h`, `test_guardian_replacementBehind7DayTimelock`, `test_rescue_onlyAboveObligations`. Wave 2 (W2-B, owner decisions): `test_unpause_adminOnlyAndImmediate`, `test_guardian_grantRevokeRenounceRevert`, `test_transferGuardian_movesRoleImmediately`, `test_transferGuardian_onlyGuardianAndNonZero`, `test_guardian_replacementCostIsConstant`, `test/invariant/EscrowInvariant.t.sol` :: `invariant_exactlyOneGuardian` | ✅ |
| CON-8 | No path both settles and refunds a round | W1-B | `contracts/test/invariant/EscrowInvariant.t.sol` :: `invariant_neverBothSettledAndRefunded` | ✅ |
| CON-9 | `FlockedAnchor` write-once rules, deadline relative to the beacon, skip-and-emit for invalid batch items | W2-B | `contracts/test/Anchor.t.sol` :: `test_lock_writesOnceAndEmits`, `test_lock_beaconBoundEdges`, `test_lock_onlyBeforeClose`, `test_lock_mixedBatchAppliesValidItemsInOrder`, `test_lock_lengthMismatchRevertsWholeCall`, `test_commit_windowEdges`, `test_commit_requiresLock`, `test_commit_writesOnce`, `test_commit_mixedBatch`, `test_anchorManifest_onlyAtOrAfterBeaconAndOnce`, `test_fullLifecycle_eachKindOncePerKey`; `AnchorFuzz.t.sol` :: `testFuzz_batches_matchModel`, `testFuzz_commit_window`; `AnchorInvariant.t.sol` :: `invariant_eachKeyWrittenAtMostOncePerKind`, `invariant_writesInsideWindows` | ✅ |
| CON-10 | An entry ticket signed for one escrow reverts on another | W1-B | `contracts/test/Escrow.Enter.t.sol` :: `test_enter_ticketSignedForOneEscrowRevertsOnAnother` | ✅ |
| CON-11 | Fuzz `enter`, `propose`, `claim` | W1-B | `contracts/test/fuzz/EnterFuzz.t.sol` (5), `contracts/test/fuzz/ProposeFuzz.t.sol` (4, incl. `testFuzz_stakesMath_invariantAndBounds`), `contracts/test/fuzz/ClaimFuzz.t.sol` :: `testFuzz_claim_fullSettlementDrainsExactly`, `testFuzz_claim_forgedProofFails` | ✅ |
| CON-12 | Invariant: USDC held ≥ sum of every round's outstanding obligations | W1-B | `contracts/test/invariant/EscrowInvariant.t.sol` :: `invariant_usdcHeldCoversObligations`, `invariant_totalObligationsMatchesRounds` | ✅ |
| CON-13 | Contract closed form and payout Merkle leaves match `@flocked/settle` recorded vectors | W1-D | `contracts/test/Vectors.t.sol` :: `test_settleVectors_header`, `test_settleVectors_matchStakesMath`, `test_settleVectors_throughPropose`; `contracts/test/MerkleVectors.t.sol` :: `test_merkleVectors_header`, `test_merkleVectors_everyProofVerifies`, `test_merkleVectors_claimOnSettledRound` | ✅ |

## Required tests: tlock

| ID | Requirement | Session | Proof (planned) | Status |
| --- | --- | --- | --- | --- |
| TL-1 | Encrypt in the browser bundle, decrypt in the Worker with a recorded drand signature | W2-A (library, Workers runtime), W9-C (real browser bundle via Playwright) | Workers half (W2-A): `packages/tlock/test/roundtrip.workers.test.ts` :: "decrypts and classifies ciphertexts made in Node with the recorded signatures", "round-trips a pick encrypted inside workerd"; Node: `test/roundtrip.test.ts`. Open (W9-C): `e2e/ui/tlock-bundle.spec.ts` | 🟡 |
| TL-2 | Corrupted signature rejected before decryption | W2-A | `packages/tlock/test/signature.test.ts` :: "flipping signature bit %i fails verification", "classify throws on a corrupted signature instead of returning VOIDs" | ✅ |
| TL-3 | Malformed, extra-stanza, wrong-round, wrong-chain ciphertexts → VOID; plaintext with wrong length, version or round reference → VOID | W2-A | `packages/tlock/test/classify.test.ts` :: "TL-3: malformed ciphertexts and bad plaintexts are VOID with their exact reason" (21 header, 4 target, 16 decrypt, 8 plaintext, 4 option cases). W3-B adds the non-canonical G2 `U` case (Decision log, Oct 8) | ✅ |
| TL-4 | Client-side target-round checks match the contract | W2-A (vectors), W2-D (forge cross-check) | `packages/tlock/test/vectors.test.ts` :: "TL-4 (TypeScript half): target-round vectors"; `contracts/test/TargetRound.t.sol` :: `test_targetRound_vectorsMatchCreateRound` (36 cases) | ✅ |

## Required tests: RoundDO

| ID | Requirement | Session | Proof (planned) | Status |
| --- | --- | --- | --- | --- |
| DO-1 | Entry after close rejected; duplicate entry rejected | W3-B | `apps/api/test/round-do/entries.test.ts` | ⬜ |
| DO-2 | Missing or insufficient balance rejected atomically; non-member room entry rejected | W3-B | same | ⬜ |
| DO-3 | Receipts verify against the root; no acknowledged entry missing from the root at a close-boundary race | W3-B | `apps/api/test/round-do/close-race.test.ts` | ⬜ |
| DO-4 | Out-of-range stake, suspended and self-excluded entries rejected | W3-B | `apps/api/test/round-do/entries.test.ts` | ⬜ |
| DO-5 | Alarm chain; reconnect snapshot | W3-B (alarms), W7-A (snapshot) | `apps/api/test/round-do/alarms.test.ts`, `apps/api/test/ws/snapshot.test.ts` | ⬜ |

## Required tests: identity and auth

| ID | Requirement | Session | Proof (planned) | Status |
| --- | --- | --- | --- | --- |
| ID-1 | Linking; pending merges and confirmation; merge refusals (unsettled entries, different person IDs, restrictions) | W7-B | `apps/api/test/identity/*.test.ts` | ⬜ |
| ID-2 | One person ID per user | W5-B | `apps/api/test/personhood/person-id.test.ts` | ⬜ |
| ID-3 | Login-CSRF on the OAuth callback | W5-B | `apps/api/test/personhood/callback.test.ts` | ⬜ |
| ID-4 | Email-code brute force and replay; mini-app Bearer flow | W3-A | `apps/api/test/auth/*.test.ts` | ⬜ |
| ID-5 | `/prepare` eligibility: geo, age, ToS, self-exclusion, cap with live tickets, kill switch, one live ticket per person | W6-B | `apps/api/test/stakes/prepare.test.ts` | ⬜ |

## Required tests: pipeline

| ID | Requirement | Session | Proof (planned) | Status |
| --- | --- | --- | --- | --- |
| PIPE-1 | Reveal gating across API, WebSocket, cards and bundles, plus a log scan for plaintext picks | W6-D (API, bundles), W7-A (WS), W10-A (cards), W13-C (log scan over the e2e suite) | `apps/api/test/gating/*.test.ts`, `e2e/tests/log-scan.spec.ts` | ⬜ |
| PIPE-2 | AnchorDO per-key deadlines and partial batch failure | W4-A | `apps/api/test/anchor-do/*.test.ts` | ⬜ |
| PIPE-3 | Indexer reorg replay | W4-B | `apps/api/test/indexer/reorg.test.ts` | ⬜ |
| PIPE-4 | Deterministic manifests: two runs give byte-identical output | W5-A | `apps/api/test/settlement/manifest.test.ts` | ⬜ |
| PIPE-5 | Watcher match and mismatch verdicts; dead-man's switch | W10-B (Stakes), W11-B (Free, dead-man) | `apps/watcher/test/*.test.ts` | ⬜ |
| PIPE-6 | Verify CLI against end-to-end bundles | W9-B (fixtures), W9-D (e2e bundles) | `packages/verify/test/cli.test.ts`, `e2e/tests/verify-cli.spec.ts` | ⬜ |

## Required tests: end to end (Playwright, local stack)

| ID | Requirement | Session | Proof (planned) | Status |
| --- | --- | --- | --- | --- |
| E2E-1 | Sign in, verify personhood, enter Free, enter Stakes | W7-D (API level), W9-D (Free UI), W10-D (Stakes UI) | `e2e/tests/lifecycle.spec.ts`, `e2e/ui/free-round.spec.ts`, `e2e/ui/stakes-round.spec.ts` | ⬜ |
| E2E-2 | Close, beacon, reveal | W7-D, W9-D | same | ⬜ |
| E2E-3 | Share card exists | W11-D | `e2e/ui/share.spec.ts` | ⬜ |
| E2E-4 | Claim after the challenge window | W7-D, W10-D | `e2e/tests/stakes-claims.spec.ts`, `e2e/ui/stakes-round.spec.ts` | ⬜ |
| E2E-5 | A settlement veto turns into refunds in the UI | W10-D | `e2e/ui/stakes-veto.spec.ts` | ⬜ |
| E2E-6 | A vetoed refund proposal is followed by a settlement | W7-D | `e2e/tests/stakes-veto.spec.ts` | ⬜ |
| E2E-7 | A submitted question flows through to creator credit | W12-D | `e2e/ui/question-flow.spec.ts` | ⬜ |
| E2E-8 | Each entrant gets exactly one outcome notification per game day; `question_live` reaches only non-entrants | W9-D | `e2e/tests/notifications.spec.ts` | ⬜ |
| E2E-9 | Timed exclusion can't be shortened; permanent exclusion lifts only 7 days after a request made 6 months in | W12-D (UI); W7-B (API tests) | `e2e/ui/exclusion.spec.ts` | ⬜ |
| E2E-10 | Two Stakes entries with identical ciphertexts both count | W7-D | `e2e/tests/stakes-copy.spec.ts` | ⬜ |
| E2E-11 | Paymaster accepts approve-plus-enter in one user operation, rejects other calls, enforces the daily cap | W10-D | `e2e/tests/paymaster.spec.ts` | ⬜ |
| E2E-12 | `DELETE /me` anonymizes the account and its cards, is refused during an exclusion, leaves wallet-only claims working | W12-D | `e2e/ui/delete-account.spec.ts` | ⬜ |
| E2E-13 | 5 rejected questions in 7 days block submission for 7 days without affecting play | W12-D | `e2e/ui/question-block.spec.ts` | ⬜ |
| E2E-14 | A Free round refunds when the local drand network is held down past 24 hours (simulated clock) | W7-D | `e2e/tests/drand-outage.spec.ts` | ⬜ |

## Acceptance criteria

| ID | Criterion | Session | Proof (planned) | Status |
| --- | --- | --- | --- | --- |
| AC-1 | A daily round opens, accepts Free and Stakes entries, closes, settles and reveals automatically, with no manual step | W7-D (local), W14-D (staging soak) | `e2e/tests/lifecycle.spec.ts` (no manual calls), soak report | ⬜ |
| AC-2 | No per-option information retrievable through any API, log or storage before the beacon; no endpoint shows a mode's split before its reveal | W6-D, W7-A, W10-A, W13-C | PIPE-1 tests + storage scan in `e2e/tests/log-scan.spec.ts` | ⬜ |
| AC-3 | Anyone reproduces every settlement and Merkle root with `npx @flocked/verify`; any player verifies their own entry in the browser | W9-B, W11-C | `e2e/tests/verify-cli.spec.ts`, `e2e/ui/verify-page.spec.ts` | ⬜ |
| AC-4 | Every onchain Stakes entry carries a valid ticket; one person can't enter a round twice from different wallets; every VOID can be recomputed from public data | W1-B, W6-B, W10-B | CON-2, `apps/api/test/stakes/prepare.test.ts`, watcher VOID recompute test | 🟡 |
| AC-5 | Stakes payouts: exact claims after the window, losers only their rebate; veto → full refund; refundable if operator never proposes; never both settled and refunded; claims ≤ derived totals | W1-B, W7-D, W10-D | CON-5..8, E2E-4, E2E-5, `e2e/tests/stakes-timeout.spec.ts` | 🟡 |
| AC-6 | Every locked, non-voided Free round has exactly one lock leaf and one commitment onchain; commitment before the beacon in normal operation; every Free receipt verifies against it | W4-D, W11-B | `apps/api/test/lifecycle/free-anchor.test.ts`, watcher Free checks | ⬜ |
| AC-7 | Every settled player has a share card; the share URL unfurls on Farcaster and OG consumers | W10-A, W11-D | `apps/api/test/cards/*.test.ts`, `e2e/ui/share.spec.ts` (meta tag assertions) | ⬜ |
| AC-8 | Stakes UI absent for users not verified, outside the geo allow list, under age, or self-excluded | W10-C | `e2e/ui/stakes-eligibility.spec.ts` | ⬜ |
| AC-9 | A submitted question flows through moderation, voting, approval and scheduling; its author receives the creator fee or award after settlement | W12-D | E2E-7 | ⬜ |

## Non-functional requirements

| ID | Area | Session | Proof (planned) | Status |
| --- | --- | --- | --- | --- |
| NFR-1 | Scale: 100k entries/round/mode; 50k concurrent WebSocket clients on the reveal | W13-B (harness), W14-D (staging run) | `docs/runbooks/load-test-report.md` | ⬜ |
| NFR-2 | Latency: Free entry p95 < 400 ms committed; `/rounds/today` p95 < 100 ms from cache | W14-B | Load-harness latency report on staging | ⬜ |
| NFR-3 | Reveal: p95 < 2 min after beacon at full scale; small rounds within seconds | W14-D | Load-test report | ⬜ |
| NFR-4 | Settlement: Free commitments before beacon; Stakes proposal within 10 min of beacon; final 2 h later | W4-A, W6-A, W14-D | Integration tests + load-test report | ⬜ |
| NFR-5 | Availability: 99.9% read paths in the 30 min around reveal | W13-A (monitor), W14-D (measure during soak) | Uptime checks + soak report | ⬜ |
| NFR-6 | Correctness: invariant every settlement; settlement idempotent (identical output, no double writes) | W1-C, W5-A, W5-D, W6-A | PROP-1, `apps/api/test/settlement/idempotency.test.ts` | 🟡 |
| NFR-7 | Security: separate keys, ticket signer isolated in its own Worker, guardian multisig, admin behind Access, audit before mainnet funds | W6-B, W13-C, W13-D, W16-A, OA-17, OA-20 | Security review checklist; deploy config review | ⬜ |
| NFR-8 | Privacy: no plaintext picks logged or stored before beacon; per-round person tags; raw Coinbase data never stored; IPs only within rate-limit windows | W3-A, W5-B, W13-C | Unit tests + log/storage scan | ⬜ |
| NFR-9 | Accessibility: WCAG 2.1 AA; reveal honours `prefers-reduced-motion` | W9-C (motion), W14-B (audit) | axe in Playwright; manual audit report | ⬜ |
| NFR-10 | Observability: structured logs and alerts | W13-A | Alert injection test log | ⬜ |

## Alerts

Each alert's detection is built by the session that owns the behaviour, which emits a structured `alert` log event with a pinned code (see `packages/shared/src/alerts.ts`, W2-D). W13-A routes every code to paging/notification and proves each by injection.

| ID | Alert | Detection built in | Routed and injection-tested | Status |
| --- | --- | --- | --- | --- |
| ALERT-1 | Settlement failure or reconciliation mismatch | W5-A, W6-A | W13-A | ⬜ |
| ALERT-2 | Free commitment not confirmed by min(close + 90 s, beaconTime − 30 s) | W4-A | W13-A | ⬜ |
| ALERT-3 | Safe head not past the close block by beacon time + 60 s | W6-A | W13-A | ⬜ |
| ALERT-4 | Indexer lag over 150 s | W4-B | W13-A | ⬜ |
| ALERT-5 | Anomalous VOID rate | W5-A | W13-A | ⬜ |
| ALERT-6 | DO errors or a schedule gap | W4-A (gap), W13-A (DO errors) | W13-A | ⬜ |
| ALERT-7 | Watcher mismatch or missing verdict | W10-B, W11-B | W13-A | ⬜ |
| ALERT-8 | Any `FlockedEscrow`/`FlockedAnchor` event the backend didn't send | W4-B | W13-A | ⬜ |
