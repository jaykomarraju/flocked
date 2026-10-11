# Static analysis

Triage of every slither and aderyn finding on the audited sources (`contracts/src/**`) at the audit commit named in
[package.md](package.md). Each finding is **fixed**, a **false positive** (with the reason), or **accepted** (with
the reason). Nothing is high. The only mediums were slither's three false positives (S-1, S-2), and each carries an
inline suppression that points back here.

## Tools and commands

| Tool | Version | Install |
| --- | --- | --- |
| slither | 0.11.6 (`slither-analyzer`, Python 3.14) | `uv tool install slither-analyzer==0.11.6` |
| aderyn | 0.6.8 | `npm install -g @cyfrin/aderyn@0.6.8` (Cyfrin's npm build; the crates.io `aderyn` is stuck at 0.1.9 and doesn't build) |
| solc | 0.8.30 (via Foundry 1.7.1) | `contracts/foundry.toml` |

Both read their scope from config files in `contracts/`:

- `slither.config.json`: `filter_paths` = `dependencies|test|script`, `exclude_dependencies`.
- `aderyn.toml`: `src = "src/"`, every detector on.

```bash
cd contracts
slither . --fail-medium                 # exit 0: no unsuppressed medium or high
aderyn . -o report.json                 # then: jq -e '.issue_count.high == 0' report.json
```

The final run on the audit commit found:

- slither: 102 detectors over 37 contracts, 24 results, none medium or high once S-1 and S-2 are suppressed;
- aderyn: 88 detectors over 5 files (1,025 nSLOC), 0 high and 9 low.

## Fixed

| ID | Tool, detector | Where | Fix |
| --- | --- | --- | --- |
| F-1 | aderyn `non-reentrant-not-first` | `FlockedEscrow.executeRescue` | `nonReentrant` now comes before `onlyRole(DEFAULT_ADMIN_ROLE)` (`onlyRole` makes no external call, so behaviour is unchanged) |
| F-2 | aderyn `unspecific-solidity-pragma` | `FlockedEscrow`, `FlockedAnchor`, `StakesMath` | Pinned to `pragma solidity 0.8.30;` (the compiler `foundry.toml` already pinned). The interfaces stay floating, see A-9 |
| F-3 | aderyn `unchecked-return` (introduced and removed this session) | `FlockedEscrow._setGuardian` | It briefly returned the previous holder, which `transferGuardian` ignored. It now returns nothing; `executeGuardianReplacement` reads `guardian()` first |

Fixes from the W2-Z review that weren't tool findings are in [package.md](package.md#changes-since-wave-3).

## False positives

| ID | Tool, detector, impact | Where | Why it is a false positive |
| --- | --- | --- | --- |
| S-1 | slither `reentrancy-no-eth` (Medium) and `reentrancy-benign` (Low) | `FlockedEscrow.enterWithPermit` | The flagged external call is `permit` on the immutable USDC, inside `try`/`catch`. It runs under the function's `nonReentrant` guard, and `_enter` reads every value it checks after the call. Slither's suggested cross-function paths don't hold: `createRound` needs `OPERATOR_ROLE`, and `getRound`/`_existing` are reads. Every other path that writes round state is either `nonReentrant` or role-gated. CEI holds for the token pull itself: state is written before `safeTransferFrom`, and the exact-delta check comes after. Suppressed with `slither-disable-next-line reentrancy-no-eth,reentrancy-benign` |
| S-2 | slither `unused-return` (Medium) ×2 | `FlockedEscrow._verifyTicket`, `FlockedAnchor.verifyReceipt` | `ECDSA.tryRecoverCalldata` returns `(recovered, err, errArg)`. `errArg` only describes the error, and `err != NoError` already rejects it. `recoverCalldata`, which reverts, would change the escrow's revert data (`InvalidTicketSignature`) and break `verifyReceipt`, which returns false instead of reverting. Suppressed with `slither-disable-next-line unused-return` |
| S-3 | slither `missing-zero-check` (Low) ×3 | `executeTicketSigner(newSigner)`, `executeTreasury(newTreasury)`, constructor `ticketSigner_` | `execute*` can only apply a value `schedule*` accepted, and `schedule*` rejects zero (a zero `execute` reverts `NotScheduled`). A zero `ticketSigner_` is deliberate: it deploys with entries disabled (spec, "Smart contract") |
| D-1 | aderyn `state-no-address-check` ×4 | the same three, plus `FlockedAnchor._setReceiptSigner` | As S-3. Zero is the documented "receipts disabled" value, set only by `setReceiptSigner(address(0))` |
| D-2 | aderyn `require-revert-in-loop` ×2 | `FlockedAnchor.lock` and `commit` loops | The only revert reachable inside the loop is `beaconTime(0)` in `_commit`, which can't happen: `_commit` returns early unless the key is locked, and `_lock` never stores beacon round 0. Invalid items are skipped with `Skipped`, as the spec requires, rather than reverting |
| D-3 | aderyn `large-numeric-literal` | `StakesMath.BPS = 10_000` | It already uses a digit separator |
| D-4 | aderyn `push-zero-opcode` ×2 | `IFlockedEscrow`, `IFlockedAnchor` (floating pragma) | The deploy targets are Base and Base Sepolia, both on Cancun or later, which support `PUSH0`. `evm_version = "cancun"` is pinned |

## Accepted

| ID | Tool, detector | Where | Why it is accepted |
| --- | --- | --- | --- |
| A-1 | slither `timestamp` (Low) ×15 | `createRound`, `_enter`, `_verifyTicket`, `propose`, `veto`, `finalize`, `_finalizeIfDue`, `refundTooFew`, `refundTimeout`, `voidRound`, both `_consume`s, `_lock`, `_commit`, `anchorManifest` | Every deadline in the spec is a timestamp: open and close, beacon time, the challenge window, the refund timeout and the timelocks. A sequencer can skew `block.timestamp` by seconds, and the margins are minutes to days (beacon delay ≥ 60 s; R-8 in [threat-model.md](threat-model.md) covers a Base halt at close). `forge lint` excludes `block-timestamp` for the same reason |
| A-2 | slither `naming-convention` (Informational) ×4 | `GENESIS`, `PERIOD` immutables on both contracts | The spec names these constants, and the getters `GENESIS()`/`PERIOD()` are pinned ABI |
| A-3 | slither `shadowing-local` (Low) | `IFlockedAnchor.anchorManifest(bytes32 roundKey, …)` | The interface keeps the spec's text verbatim. The implementation names the parameter `key` (no shadowing), so the ABI's input name is `key` |
| A-4 | slither `unindexed-event-address` (Informational) | `IFlockedAnchor.ReceiptSignerSet(address signer, uint64 validFrom)` | Spec event, verbatim and pinned. Indexing would move `signer` from data to a topic, which the indexer would see as an ABI change. The history is short (a handful of events), so scanning by topic0 is enough |
| A-5 | aderyn `centralization-risk` ×34 | every role-gated function | By design: the spec's role model. The checks and balances are timelocks on grants and signers, a single guardian with a veto, and admin-only unpause. See [threat-model.md](threat-model.md#trust-model) |
| A-6 | aderyn `costly-loop` ×2 | `FlockedAnchor.lock`, `commit` | Batching is the design (one AnchorDO transaction per tick). Batch size is the caller's, and W2-B measured about 75k gas per `lock` item and 55k per `commit` item. An oversized batch only fails its own transaction |
| A-7 | aderyn `unchecked-return` ×10 | `_grantRole`/`_revokeRole` in both constructors, `executeOperatorGrant`, `executeAnchorGrant` and `_setGuardian` | OpenZeppelin's bool reports whether the role changed. Granting a role an account already holds is a harmless no-op. In `_setGuardian` both calls always return true: the revoked address holds the role, and after the revoke nobody does |
| A-8 | aderyn `internal-function-used-once` | `StakesMath.refundReason` | Kept separate so it mirrors `settleStakesClosedForm`'s structure in `@flocked/settle` and states the spec's rule order in one place |
| A-9 | aderyn `unspecific-solidity-pragma` ×2 | `IFlockedEscrow`, `IFlockedAnchor` | Interfaces stay `^0.8.28`, so integrators and the test suite can import them. They hold no logic, and the contracts that implement them are pinned (F-2) |

## Suppressions in the source

Each suppression is on the line before the flagged statement and names this file:

- `FlockedEscrow.enterWithPermit`: `slither-disable-next-line reentrancy-no-eth,reentrancy-benign` (S-1);
- `FlockedEscrow._verifyTicket`: `slither-disable-next-line unused-return` (S-2);
- `FlockedAnchor.verifyReceipt`: `slither-disable-next-line unused-return` (S-2).

There are no aderyn suppressions. Aderyn has no medium tier, and none of its lows needed one.

## CI

The steps to add (W4-D owns `.github/workflows/*`) are in `docs/sessions/W4-C.md` under "Notes for D and Z". The job
installs the pinned versions, runs slither with `--fail-medium` and aderyn with a check that `.issue_count.high` is
0. It uploads both reports as artifacts. A new medium or high fails the job until it is fixed, or triaged here with an
inline suppression.
