# W1-B handoff: `FlockedEscrow`

## Status
complete — escrow, StakesMath, 138 passing tests (unit, fuzz, invariant, vectors), 100% line coverage.

## Summary
- Standalone Foundry project in `contracts/` (solc 0.8.30, cancun, optimizer 200, no via_ir; Soldeer deps OZ 5.7.0, forge-std 1.17.0).
- `FlockedEscrow` implements every rule in the spec's "Rules the contract enforces", the P1.3 constructor, EIP-712 domain, enums, claim leaf, views and built-in timelocks (72 h; guardian 7 d; immediate revocation, signer disable, pause).
- `StakesMath` is the pure closed form (winner, Lp, F, C, D, w, R, r, dust, refund reasons 1–3) used by `propose`.
- `totalObligations` tracks unpaid round entitlements plus credited fee balances; rescue is limited to USDC above it.
- 10 hand-computed seed vectors (P1.1 format) with arithmetic; `Vectors.t.sol` checks all fields against `StakesMath` and runs 9 of them through a real `createRound` → `enter` → `propose` → `finalize`.
- Invariant handler covers create, enter, propose (any tally, honest or over-generous trees), veto, finalize, claim, claimAll, claimRefund, void, refundTooFew, refundTimeout, withdraw, pause, donations and warps. Mutation-checked: removing any per-kind cap, the double-claim check, a fee credit, `refundClaims++` or the obligation decrement each fails it.

## Branch and head commit
`w1-b-escrow` @ `809bc35` (this handoff is the next commit)

## Files touched
All new: `contracts/{foundry.toml,remappings.txt,soldeer.lock,.gitignore,README.md}`, `contracts/src/FlockedEscrow.sol`, `contracts/src/interfaces/IFlockedEscrow.sol`, `contracts/src/lib/StakesMath.sol`, `contracts/test/Escrow.{CreateRound,Reverts,Enter,Refunds,Propose,Challenge,Claim,Roles}.t.sol`, `contracts/test/Vectors.t.sol`, `contracts/test/fuzz/{Enter,Propose,Claim}Fuzz.t.sol`, `contracts/test/invariant/{EscrowHandler.sol,EscrowInvariant.t.sol}`, `contracts/test/mocks/{MockUSDC,FeeOnTransferToken}.sol`, `contracts/test/utils/{EscrowBase,TestMerkle}.sol`, `contracts/test/fixtures/{stakes-closed-form.seed.json,README.md}`, `docs/sessions/W1-B.md`.

## Tests run
| Command (in `contracts/`) | Result |
| --- | --- |
| `forge fmt --check` | pass |
| `forge build` | pass, no warnings (lint on `src/`) |
| `forge test` | pass, 138 tests (fuzz 1,000 runs; invariant 256 × 100) |
| `FOUNDRY_PROFILE=ci forge test` | pass, 138 tests (fuzz 2,000; invariant 512 × 200 = 102,400 calls each), ~29 s |
| `forge coverage --report summary --no-match-coverage 'test/\|dependencies/'` | `FlockedEscrow.sol` 100% lines (299/299), 100% branches (75/75); `StakesMath.sol` 100% lines (29/29), 100% branches (4/4) |

## Traceability rows covered
- CON-1: `Escrow.CreateRound.t.sol` (`test_createRound_stakeCeilings`, `_feeCeilings`, `_capMultipleCeilings`, `_maxRoundDurationBoundary`, `_beaconDelayBoundaries`, `_beaconExactlyAtBounds`, `_revertsOnZeroMinEntrants`, `_revertsOnZeroCreator`, `_revertsWhenOpensAtNotInFuture`, `_revertsWhenClosesAtNotAfterOpensAt`, `_revertsForNonOperator`, `_revertsOnBeaconRoundZero`); `Escrow.Reverts.t.sol` (`test_constructor_*`, `test_unknownRound_reverts`, `test_wrongStatus_onRefundedRound`, `test_roleChecks`).
- CON-2: `Escrow.Enter.t.sol` (`test_enter_revertsOnWrongSigner`, `_revertsOnTamperedTicket`, `_revertsOnMalformedSignature`, `_revertsWhenWalletIsNotSender`, `_revertsOnTicketForOtherRound`, `_revertsOnExpiredTicket`, `_ticketValidAtExactExpiry`, `_rejectsSamePersonTagFromAnotherWallet`, `_rejectsSecondEntryFromSameWallet`, `_ciphertextLengthBounds`, `_domainUsesBlockChainId`, plus permit, pause, window and token cases).
- CON-3: `Escrow.Refunds.t.sol` (`test_voidRound_byGuardianJustBeforeClose`, `_revertsAtOrAfterClose`, `test_refundTooFew_afterCloseWithTooFew`, `_revertsBeforeClose`, `_revertsWithEnoughEntrants`, `test_claimRefund_*`).
- CON-4: `Escrow.Propose.t.sol` (`test_propose_revertsWhenTallyDoesNotMatchEntryCount`, `_refundReason1..3_*`, `_settleDerivesClosedForm`, `_capBindsAndRebates`, `_matchesStakesMath`, `_minEntrantsBoundary`, timing and root checks).
- CON-5: `Escrow.Challenge.t.sol` (`test_veto_settleProposalBecomesRefundedReason5`, `_refundProposalReturnsToOpenAndCanBeReproposed`, `_revertsAtClaimsOpenAt`, `test_finalize_settleCreditsTreasuryFeePlusDustAndCreatorFee`, `_revertsDuringWindow`, `_refundProposal`).
- CON-6: `Escrow.Claim.t.sol` (`test_claim_perKindLimitsCapTotalAtPostedTally`, `_rebateLimitWithExtraLeaves`, `test_withdraw_creatorThatCannotReceiveNeverBlocksRound`, `test_claim_everyKindPaysDerivedAmountAndDrainsRound`).
- CON-7: `Escrow.Roles.t.sol` (`test_refundTimeout_onlyAfterCloseplus72h`, `test_pause_blocksEnterOnlyAndIsImmediate`, `test_operatorGrant_requiresTimelock`, `test_operatorRevocation_isImmediate`, `test_ticketSigner_disableIsImmediateAndRotationIsTimelocked`, `test_treasury_timelocked72h`, `test_guardian_replacementBehind7DayTimelock`, `test_guardian_isItsOwnAdmin`, `test_rescue_onlyAboveObligations`).
- CON-8: `invariant/EscrowInvariant.t.sol::invariant_neverBothSettledAndRefunded` (also asserts every status transition follows the spec's state machine).
- CON-10: `Escrow.Enter.t.sol::test_enter_ticketSignedForOneEscrowRevertsOnAnother`.
- CON-11: `fuzz/EnterFuzz.t.sol` (5), `fuzz/ProposeFuzz.t.sol` (4, incl. `testFuzz_stakesMath_invariantAndBounds`), `fuzz/ClaimFuzz.t.sol` (`testFuzz_claim_fullSettlementDrainsExactly`, `testFuzz_claim_forgedProofFails`).
- CON-12: `invariant/EscrowInvariant.t.sol::invariant_usdcHeldCoversObligations` and `invariant_totalObligationsMatchesRounds`.
- Seed vectors: `Vectors.t.sol::test_vectors_matchStakesMath`, `test_vectors_throughPropose` (CON-13 itself is W1-D).

## Deviations
- `forge test --profile ci` doesn't exist in Foundry 1.7 (no `--profile` flag). The CI profile runs as `FOUNDRY_PROFILE=ci forge test`.
- P1.4 says the `ci` profile "doubles them". I doubled fuzz runs (2,000), invariant runs (512) and depth (200).
- Interface additions beyond P1.3 (all additive): `hasClaimed`, `totalObligations`, `timelockReadyAt`, `operationId`, `ticketDigest`, `domainSeparator`, events `Credited`, `Withdrawn`, `Timelock{Scheduled,Executed,Cancelled}`, `TicketSignerSet`, `TreasurySet`, `GuardianReplaced`, `Rescued`. `beaconTime` returns `uint256`.
- `Vectors.t.sol` runs 9 of the 10 seed vectors through `propose`; `stake-1-unit-void` is below the 1 USDC launch ceiling, so `createRound` can't take it. It's still checked against `StakesMath`.
- Lint: `block-timestamp` is excluded (every deadline is timestamp-based by design), and `test/**` isn't linted.

## Spec issues
(Smart contract → "Rules the contract enforces" unless noted. I implemented the safest reading in each case.)
1. Wave-file Q1, `claimRefund` after a settlement veto: pays every entrant (VOID included) their stake once. This matches "pays the caller's stake once". No fees are credited. Recommend confirming the reading in the spec text.
2. Wave-file Q2: `propose` rejects a zero `bundleHash` (refunds too) and a zero `payoutRoot` on settle proposals. Recommend adding both to the rule list.
3. Further strict checks the spec doesn't list: `enter` rejects a zero `personTag`, `createRound` rejects `beaconRound == 0` (`beaconTime` would underflow), and `enter` checks the received balance delta equals `stake`. Recommend listing them.
4. A Rebate claim when r = 0 reverts `NothingToClaim`, which matches "rebate leaves are omitted when r = 0".
5. Execute and cancel for every timelock are `DEFAULT_ADMIN_ROLE` only (the spec doesn't say who executes). Scheduled operations don't expire. Recommend stating both.
6. `PAUSER_ROLE` grants are immediate, and the pauser can also `unpause`. That could reverse the signer-compromise pause. Recommend admin-only `unpause`, or listing pauser grants under the timelock.
7. The guardian is "its own admin": guardian members can add or remove guardians immediately, and `executeGuardianReplacement` revokes every member. Recommend saying so.
8. `withdraw()` has no recipient. A blocklisted creator or treasury stays credited (owed, not rescuable) until unblocked. Recommend `withdrawTo(address)` (interface change, needs an owner decision).
9. After a veto to Refunded, the vetoed proposal's fields (`n0`, `n1`, `payoutRoot`, amounts) stay in `getRound` as evidence. A veto back to Open clears them.
10. Events: `RoundRefunded(reason)` fires on every entry into Refunded, including `finalize` of a refund proposal (alongside `RoundFinalized`). `Entered.ticketHash` is the EIP-712 digest. Recommend adding both to the spec for the indexer.

## Open issues
- Spec issues 6 and 8 need an owner decision (Z).
- slither and aderyn haven't run yet (W4-C per plan 4.2).

## Notes for D and Z
- **Foundry** 1.7.1 (`foundry-rs/foundry-toolchain` with `version: v1.7.1`). solc 0.8.30 is auto-installed by forge.
- **CI steps** (working directory `contracts`): `forge soldeer install` → `forge fmt --check` → `forge build` → `FOUNDRY_PROFILE=ci forge test`. Optionally `forge coverage --report summary --no-match-coverage 'test/|dependencies/'`. A clean `forge soldeer install` reproduces `dependencies/` from `soldeer.lock` and leaves the committed `remappings.txt` unchanged (`remappings_generate = false`).
- **CON-13 (W1-D):** change `VECTORS_PATH` in `contracts/test/Vectors.t.sol` to `../packages/settle/vectors/stakes-closed-form.json`; `fs_permissions` already allows it. The test also parses `.kind`/`.formulaVersion`. Payout Merkle vectors need a new test: leaf = `keccak256(bytes.concat(keccak256(abi.encode(roundId, account, uint8(kind)))))`, verified with OZ `MerkleProof` (see `test/utils/TestMerkle.sol`).
- **P1.3 confirmed** (constructor, EIP-712 `("Flocked","1")` + `block.chainid`, typehash, enums, reason codes 1–6, leaf). Names W2+ calls: `createRound`, `voidRound`, `enter`, `enterWithPermit`, `propose`, `veto`, `finalize`, `refundTooFew`, `refundTimeout`, `claim`, `claimRefund`, `withdraw`, `pause`, `unpause`; views `getRound` (returns `IFlockedEscrow.Round`), `beaconTime`, `ticketSigner`, `treasury`, `hasEntered`, `personTagUsed`, `hasClaimed`, `withdrawable`, `roundCount`, `totalObligations`, `ticketDigest`, `domainSeparator`; constants `OPERATOR_ROLE`, `GUARDIAN_ROLE`, `PAUSER_ROLE`, `CHALLENGE_WINDOW`, `REFUND_TIMEOUT`, `MIN/MAX_BEACON_DELAY`, `GENESIS`, `PERIOD`; timelocks `schedule|execute|cancel` + `TicketSigner|Treasury|OperatorGrant|GuardianReplacement|Rescue`, `setTicketSigner(address(0))`.
- **Risky diffs worth reading:** `FlockedEscrow.claim` (per-kind caps and finalize-if-due) and `executeGuardianReplacement` (revoke loop).
