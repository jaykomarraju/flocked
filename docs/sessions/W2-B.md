# W2-B handoff: `FlockedAnchor`, deploy scripts, `@flocked/abi`

## Status

complete: both escrow decisions, `FlockedAnchor` (CON-9), the CREATE2 deploy script with an anvil dry run, and `@flocked/abi` generated from the amended escrow.

## Summary

- `FlockedEscrow`: `unpause` is `DEFAULT_ADMIN_ROLE` only. `GUARDIAN_ROLE` always has exactly one holder: `transferGuardian` (guardian, immediate) and `guardian()`. `grantRole`/`revokeRole`/`renounceRole` revert with `SingleGuardian`, and `executeGuardianReplacement` is a constant-cost swap (the revoke loop is gone).
- `FlockedAnchor` (P2.2): a write-once lock, commitment and manifest per round key. Batches skip invalid items with reasons 1–4, and mismatched lengths revert. The commitment window is `closesAt ≤ ts < beaconTime`, and the manifest is only allowed at or after the beacon. 72 h timelocks for `ANCHOR_ROLE` grants and the receipt signer. EIP-712 receipts with `receiptDigest`/`verifyReceipt`.
- `contracts/script/Deploy.s.sol`: deploys through the CREATE2 factory (salt `keccak256("flocked.deploy.v1")`), adds `MockUSDC` on anvil, and writes `deployments/<chainId>.json`. `script/dry-run.sh` broadcasts to a fresh anvil and checks the JSON against the chain.
- `@flocked/abi`: `scripts/gen.mjs` (Node built-ins only) generates the `as const` ABIs and the committed deployments. `addressesFor(chainId, local?)`. A viem-signed receipt fixture recovers on-chain.

## Branch and head commit

`w2-b-anchor` @ `90985f6` (code). This handoff is the next commit. The base is tag `wave-1`.

## Files touched

- Edited: `contracts/src/FlockedEscrow.sol`, `contracts/src/interfaces/IFlockedEscrow.sol`, `contracts/test/Escrow.{Roles,Reverts}.t.sol`, `contracts/test/invariant/Escrow{Handler.sol,Invariant.t.sol}`, `contracts/README.md`, `contracts/foundry.toml` (fs_permissions: read `../packages/abi/test/fixtures`, read-write `./deployments`), `contracts/.gitignore` (`deployments/31337*.json`), `pnpm-lock.yaml` (`pnpm add`: the `packages/abi` importer with viem 2.57.3, the version settle already uses).
- New: `contracts/src/FlockedAnchor.sol`, `contracts/src/interfaces/IFlockedAnchor.sol`, `contracts/test/{Anchor,AnchorBase,AnchorRoles,AnchorReceipt,AnchorFuzz,AnchorInvariant,AnchorDeploy}.t.sol`, `contracts/script/{Deploy.s.sol,dry-run.sh}`, `contracts/deployments/README.md`, `packages/abi/**`.

## Tests run

| Command | Result |
| --- | --- |
| `pnpm check` | pass: 20 node:test, 13 shared, 11 abi, 66 settle, 194 forge |
| `forge fmt --check && forge build && forge test` / `FOUNDRY_PROFILE=ci forge test` | pass, 194 / 194, none skipped |
| `forge coverage --report summary --no-match-coverage 'test/\|dependencies/'` | lines: FlockedEscrow 100% (313/313), FlockedAnchor 100% (119/119), StakesMath 100%; branches 100% on all three. Deploy.s.sol: lines 100%, branches 5/6 (`Create2Failed` is never hit) |
| `bash contracts/script/dry-run.sh` (anvil on 8547) | pass: code at escrow, anchor and MockUSDC; wiring matches; `deployBlock` 0 ≤ head |
| `pnpm --filter @flocked/abi typecheck` / `lint` / `gen:check` | pass / pass / "@flocked/abi is current" |
| `pnpm --filter @flocked/abi test` with `contracts/out` moved away | pass, 11 (so CI's `check` job doesn't need Foundry) |
| `pnpm format:check`, `pnpm install --frozen-lockfile` | pass |

## Traceability rows covered

- **CON-7** (kept green, extended), `contracts/test/Escrow.Roles.t.sol`: `test_unpause_adminOnlyAndImmediate`, `test_pause_blocksEnterOnlyAndIsImmediate`, `test_guardian_grantRevokeRenounceRevert`, `test_transferGuardian_movesRoleImmediately`, `test_transferGuardian_onlyGuardianAndNonZero`, `test_guardian_replacementBehind7DayTimelock`, `test_guardian_replacementCostIsConstant`, and the wave-1 timelock tests. Also `test/invariant/EscrowInvariant.t.sol::invariant_exactlyOneGuardian`.
- **CON-9**:
  - `contracts/test/Anchor.t.sol`: `test_lock_writesOnceAndEmits`, `test_lock_beaconBoundEdges`, `test_lock_onlyBeforeClose`, `test_lock_mixedBatchAppliesValidItemsInOrder`, `test_lock_lengthMismatchRevertsWholeCall`, `test_commit_windowEdges`, `test_commit_requiresLock`, `test_commit_writesOnce`, `test_commit_mixedBatch`, `test_commit_lengthMismatchRevertsWholeCall`, `test_anchorManifest_onlyAtOrAfterBeaconAndOnce`, `test_fullLifecycle_eachKindOncePerKey`.
  - `AnchorFuzz.t.sol`: `testFuzz_batches_matchModel`, `testFuzz_lock_matchesModel`, `testFuzz_commit_window`, `testFuzz_anchorManifest_window`.
  - `AnchorInvariant.t.sol`: `invariant_eachKeyWrittenAtMostOncePerKind`, `invariant_writesInsideWindows`.
- Acceptance (receipt): `AnchorReceipt.t.sol::test_viemSignedReceipt_recoversOnChain` and `packages/abi/test/receipt.test.ts`.

## Deviations

- **Escrow tests replaced, not weakened.** The owner decision removed `test_guardian_isItsOwnAdmin` (the guardian granting and renouncing its own role); `test_guardian_grantRevokeRenounceRevert` tests the opposite. `test_guardian_replacementBehind7DayTimelock` now adds the rogue guardian through `transferGuardian` (the old `grantRole` is impossible). `test_pauserGrantAndRevoke` checks the revoked pauser's `pause` instead of `unpause`. The stranger's `unpause` in `Escrow.Reverts.t.sol` now expects `DEFAULT_ADMIN_ROLE`. The invariant handler takes `admin` instead of `guardian`, and warps 7 days on only one replacement in eight, so open rounds still settle.
- **Escrow additions:** error `SingleGuardian()`, event `GuardianTransferred(previous, current)`. The constructor parameter is renamed `guardian_` (because of the `guardian()` view), which changes the ABI parameter name. `getRoleAdmin(GUARDIAN_ROLE)` is still `GUARDIAN_ROLE`; this is harmless, since all three role functions revert for it.
- **`lock` also requires `now < closesAt`** (reason 3). The spec gives `lock` no time window; a lock after close protects nothing.
- **`anchorManifest` reverts, rather than emitting `Skipped`**, because it is not a batch. A zero manifest hash also reverts, so a backend bug can't burn the key's only write.
- **Additive anchor API beyond P2.2:** `setReceiptSigner(address(0))` disables receipts immediately (mirroring the escrow's ticket signer); `getAnchor`, `receiptDigest`, `verifyReceipt`, `domainSeparator`, `operationId`, `timelockReadyAt`; and `SKIP_*` constants.
- **`@flocked/abi`:** `src/addresses.ts` is hand-written. The generated committed data is in `src/deployments.ts`. `addressesFor(31337, local)` takes the parsed local file from the caller, because Workers and browsers can't read files.
- **Freshness:** the vitest test compares a sha256 of the contract sources recorded in each generated file, so it needs no Foundry. The exact check against `contracts/out` is `gen.mjs --check`, a CI step for D (below).
- **Deploy:** the JSON test is `AnchorDeploy.t.sol`, named to fit the ownership glob. An optional `DEPLOYMENTS_FILE` env var overrides the output path. `deployBlock` is `block.number` at simulation, a lower bound on the real deploy blocks; a no-op re-run keeps the file's earlier value.
- **Receipt fixture location:** `packages/abi/test/fixtures/receipt.json`, because `contracts/test/fixtures` isn't owned by W2-B.

## Spec issues

- "Sealed picks", "Free mode specifics": the receipt domain has no version. I used "1" (P2.2). Recommendation: write "version 1" in the spec.
- "Contract: `FlockedAnchor`" doesn't give `lock` a time window, doesn't say whether an invalid `anchorManifest` reverts or skips, and doesn't say whether the receipt signer can be disabled immediately. Recommendation: adopt the built behaviour above.
- The `uint8 mode` in `roundKey` has no pinned numeric values (Free = 0?). Recommendation: pin it in `@flocked/shared` (W2-D, P2.4) and use it in the AnchorDO and the receipt builder.

## Open issues

- **W13 (deploy):** confirm that the CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` exists on Base Sepolia and Base before the first deploy (it exists on anvil and in forge).
- **W2-D / wave 3:** `@flocked/shared`'s receipt builder should match `receiptTypes` in `packages/abi/scripts/receipt-fixture.mjs`. The fixture and test can then switch to it.
- **AnchorDO sizing:** measured gas per item is about 75k for `lock`, about 55k for `commit`, and about 73k for `anchorManifest` (forge gas report).
- No other `FlockedEscrow` behaviour change is needed.
- This session ran well past size M (about 300k tokens), but finished without splitting into `W2-B.2`.

## Notes for D and Z

- **Root `package.json`:** `"contracts:build": "forge build --root contracts && node packages/abi/scripts/gen.mjs"`.
- **CI, `contracts` job (working dir `contracts`), after `forge build`:** add `- run: node ../packages/abi/scripts/gen.mjs --check` (ABI freshness; Node built-ins only, no `pnpm install`. Add `actions/setup-node` with `.nvmrc` if the runner's Node is older than 20). Optionally, after the tests, add `- run: bash script/dry-run.sh` (anvil ships with the Foundry toolchain).
- **No change needed to** `pnpm-workspace.yaml` (`packages/*` already covers it), `eslint.config.js` or `.prettierignore`. The generated TS is already in Prettier style.
- **Traceability:** set CON-9 ✅ with the tests above, and add the new CON-7 test names.
- **P1.3 escrow, confirmed with amendments:** all of P1.3 "As built", plus `transferGuardian(address)`, `guardian() → address`, event `GuardianTransferred(address indexed previous, address indexed current)`, error `SingleGuardian()`, and `revokeRole`/`renounceRole` overrides. `unpause` is `DEFAULT_ADMIN_ROLE` only. There is no `withdrawTo`.
- **P2.2 anchor, confirmed with additions:**
  - Spec functions: `lock`, `commit`, `anchorManifest`, `receiptSigner`.
  - Views: `getAnchor(bytes32) → RoundAnchor`, `roundKey(bytes16,uint8)`, `beaconTime(uint64)`, `receiptDigest(Receipt)`, `verifyReceipt(Receipt,bytes)`, `domainSeparator()`, `operationId`, `timelockReadyAt`.
  - Admin: `setReceiptSigner(0)`, `{schedule,execute,cancel}ReceiptSigner`, `{schedule,execute,cancel}AnchorGrant`. `grantRole(ANCHOR_ROLE)` reverts `TimelockRequired`.
  - Constants: `ANCHOR_ROLE`, `RECEIPT_TYPEHASH`, `MIN_BEACON_DELAY` (60), `MAX_BEACON_DELAY` (600), `ADMIN_TIMELOCK`, `ACTION_*`, `SKIP_*`; immutables `GENESIS` and `PERIOD`.
  - Events: the spec's five, plus `Timelock{Scheduled,Executed,Cancelled}`.
- **Risky diffs worth reading:** `FlockedEscrow._setGuardian` and the role overrides; `FlockedAnchor._lock`/`_commit` (skip order); `packages/abi/scripts/gen.mjs` (hash inputs).
