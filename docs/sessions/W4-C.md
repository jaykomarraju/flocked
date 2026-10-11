# W4-C handoff: Contracts audit prep

## Status

complete: both contracts are hardened, analysed, documented and packaged for audit at `36d115c`.

## Summary

- **Fixes.** The W2-Z escrow nits are fixed:
  - `GuardianReplaced(previous, newGuardian)`;
  - admin replacement also emits `GuardianTransferred`;
  - the dead `_setRoleAdmin` is gone.

  `nonReentrant` comes first on `executeRescue`, and the pragma is pinned to 0.8.30 on the contracts and the library.
- **NatSpec.** Every external function, public getter and event has NatSpec. `contracts/tools/check-natspec.mjs`
  proves it from solc's output.
- **Static analysis.** slither 0.11.6 and aderyn 0.6.8 are triaged in `docs/audit/static-analysis.md`. No high. The
  only mediums were three slither false positives, now suppressed inline with a reason. Aderyn has 0 high and 9 lows,
  all explained.
- **Invariants.** Escrow: per-round conservation, claim exclusivity, a settle scenario and stranger leaves. Anchor:
  timelock ordering, event-against-storage checks, key rotation and commit-window targeting. Measured on the default
  profile: escrow runs that reach a settlement went from 1 in 257 to about 94%, and anchor commits from 55 to about
  350 per campaign.
- **Audit package.** `docs/audit/package.md` covers scope with hashes, architecture, roles and timelocks, tests, the
  CREATE2 factory check and the commit. `docs/audit/threat-model.md` covers the trust model, R-1 to R-8 from the spec,
  known issues K-1 to K-11 and the invariants.
- **ABI hash.** `gen.mjs` now hashes `foundry.toml` and `remappings.txt` too.

## Branch and head commit

`w4-c-audit-prep` @ `36d115c` (the contracts commit to audit), followed by one commit that adds only `docs/audit/*` and
this handoff.

## Files touched

- **Edited:**
  - `contracts/src/FlockedEscrow.sol`, `contracts/src/FlockedAnchor.sol` and `contracts/src/lib/StakesMath.sol`;
  - `contracts/src/interfaces/IFlockedEscrow.sol` and `IFlockedAnchor.sol` (event NatSpec, `GuardianReplaced`);
  - `contracts/test/Escrow.Roles.t.sol`, `Escrow.Reverts.t.sol`, `AnchorInvariant.t.sol`, and
    `invariant/EscrowHandler.sol` and `EscrowInvariant.t.sol`;
  - `packages/abi/scripts/gen.mjs`, and `packages/abi/src/*.ts` (regenerated).
- **New:**
  - `contracts/slither.config.json`, `contracts/aderyn.toml` and `contracts/tools/check-natspec.mjs`;
  - `docs/audit/package.md`, `threat-model.md` and `static-analysis.md`;
  - this file.

## Tests run

| Command | Result |
| --- | --- |
| `pnpm check` | pass: abi 13, settle 66, tlock 176, shared 438, api 427, forge 202 |
| `pnpm format:check`, `forge fmt --check` | pass |
| `FOUNDRY_PROFILE=ci forge test` | 202 passed in 233 s; 10 invariants × 512 runs × 200 calls, 0 reverts |
| `pnpm contracts:build` then `git status` | clean; `node packages/abi/scripts/gen.mjs --check` passes |
| `forge coverage` (src only) | 100% of lines, statements, branches and functions (`FlockedEscrow` 314/314 lines, `FlockedAnchor` 119/119, `StakesMath` 29/29) |
| `node contracts/tools/check-natspec.mjs` | pass |
| `slither . --fail-medium` | exit 0 (24 low or informational results, all triaged) |
| `aderyn .` | 0 high, 9 low (triaged) |
| Mutation spot checks (reverted afterwards) | 5 of 5 caught (a refund that skips `hasClaimed`, a dust credit dropped, no entrant check, a `Locked` event with swapped fields, an anchor timelock 1 s short) |

## Traceability rows covered

The audit work is no traceability row of its own. It strengthens existing rows:

- CON-12, the per-round part: `EscrowInvariant.t.sol::invariant_conservationPerRound`;
- CON-8 and exclusivity: `::invariant_claimExclusivity`;
- CON-9: `AnchorInvariant.t.sol::invariant_timelockOrdering`, plus the extended `invariant_eachKeyWrittenAtMostOncePerKind`
  (events against storage) and `invariant_writesInsideWindows`;
- CON-7: `Escrow.Roles.t.sol::test_guardian_replacementBehind7DayTimelock` (both events name the removed holder) and
  `test_transferGuardian_movesRoleImmediately` (exactly one `GuardianTransferred`, no `GuardianReplaced`).

## Deviations

- **`Escrow.Reverts.t.sol::test_constructor_setsRolesAndParams`** now expects `getRoleAdmin(GUARDIAN_ROLE) ==
  DEFAULT_ADMIN_ROLE`, not `GUARDIAN_ROLE`. This follows from removing the dead `_setRoleAdmin`, which the nit asked
  for. It isn't weakened: the admin's lack of power over the role is still tested in `Escrow.Roles.t.sol` (every
  grant, revoke and renounce reverts `SingleGuardian`) and by the invariant's `tryGuardianRoleChange`.
- **`test_transferGuardian_movesRoleImmediately`** now checks the logs directly (exactly one `GuardianTransferred`,
  no `GuardianReplaced`) instead of `expectEmit`. That's stricter.
- **The escrow handler's `MAX_ROUNDS` went from 6 to 8**, to make room for the scenario's rounds.
- **aderyn came from Cyfrin's npm package** (`@cyfrin/aderyn@0.6.8`). `cargo install aderyn` only has the stale
  0.1.9, which doesn't compile.
- **No other test was skipped, deleted or weakened.**

## Spec issues

1. **"Smart contract" → "Residual risk".** A wrong payout tree with a correct tally (threat model K-3) isn't named.
   The per-kind caps bound the totals but not who is paid, so the first N_M claimers of a kind are paid. The guardian
   veto covers it as a deliberately wrong proposal. *Recommend:* add one line under "Deliberately wrong proposal"
   saying the tree, not only the tally, is what the watcher recomputes and the guardian vetoes.
2. **"Smart contract" → `withdraw` and "Residual risk".** The spec covers a blocklisted *credited* address, but not a
   blocklisted *entrant* (whose claim reverts and stays an obligation forever), nor Circle freezing the escrow or
   pausing USDC (K-1, K-2). *Recommend:* add a "USDC issuer" residual risk: funds frozen, not lost, and accepted.
3. **"Smart contract" → Roles.** The spec doesn't say what `getRoleAdmin(GUARDIAN_ROLE)` returns. It is now
   `DEFAULT_ADMIN_ROLE`, which grants nothing (K-6). *Recommend:* no spec change, or one clause noting that the role's
   admin is irrelevant because direct grants revert.

## Open issues

- **W4-D:** add the static-analysis CI job (below).
- **W4-Z:**
  - tag `audit-candidate-1` on the merge, and check that `git diff 36d115c audit-candidate-1 -- contracts/src` is
    empty;
  - give the owner `docs/audit/package.md` (OA-20, auditor not booked).
- **Coverage gap found before this session:** before the settle scenario, the escrow invariants almost never reached
  Settled, so the over-generous-tree and claim-cap logic was proven mostly by unit and fuzz tests. That is fixed now,
  but CI-profile invariant time grew (see Notes).
- **W14-A:** re-confirm the CREATE2 factory on both chains before deploying (done Oct 11 for this package).

## Notes for D and Z

**ABI changes** (`packages/abi`, already regenerated):

- `FlockedEscrow` event `GuardianReplaced(address indexed previous, address indexed newGuardian)`, was
  `GuardianReplaced(address indexed newGuardian)`. topic0 changes. W4-B's indexer must decode the new signature.
- `executeGuardianReplacement` now emits `GuardianTransferred(previous, newGuardian)` before `GuardianReplaced`.
  Every guardian move emits `GuardianTransferred`.
- No function, error or other event changed. The NatSpec and pragma changes alter the bytecode, so the CREATE2
  addresses move. None are committed for 84532 or 8453 yet, and the anvil stack recomputes its own.

**Deploy scripts:** no change needed. `Deploy.s.sol` compiles against the pinned 0.8.30 sources, and
`AnchorDeploy.t.sol` passes. If W4-D's stack has the anvil escrow and anchor addresses cached, they change.

**CI static-analysis job (W4-D, `.github/workflows/ci.yml`):** a new `static-analysis` job, alongside `contracts`:

```yaml
  static-analysis:
    runs-on: ubuntu-24.04
    defaults: { run: { working-directory: contracts } }
    steps:
      - uses: actions/checkout@v4
      - uses: foundry-rs/foundry-toolchain@v1
        with: { version: v1.7.1 }
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc }
      - run: forge soldeer install
      - run: pip install slither-analyzer==0.11.6   # compiles through forge, so no solc-select
      - run: npm install -g @cyfrin/aderyn@0.6.8
      - name: slither (fails on any unsuppressed medium or high)
        run: slither . --fail-medium --sarif slither.sarif
      - name: aderyn (fails on any high)
        run: aderyn . -o aderyn.json && jq -e '.issue_count.high == 0' aderyn.json
      - name: NatSpec complete
        run: forge build && node tools/check-natspec.mjs
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: static-analysis
          path: |
            contracts/slither.sarif
            contracts/aderyn.json
```

- Both configs (`slither.config.json`, `aderyn.toml`) live in `contracts/`. Slither finds Foundry by itself.
- A new medium or high fails the job until it is fixed, or triaged in `docs/audit/static-analysis.md` with an inline
  `slither-disable-next-line`.
- Optionally make the job required in the ruleset (OA-03 owner action).

**CI time:** `FOUNDRY_PROFILE=ci forge test` now runs 7 escrow and 3 anchor invariants at 512 × 200. The whole forge suite takes 233 s wall-clock locally (873 s CPU), most of it in the escrow invariants. If CI time matters more than depth, lower `[profile.ci.invariant] depth`, not `runs`.

**`gen.mjs`:** `foundry.toml` and `remappings.txt` are added only if they exist, because the synthetic-root test in
`packages/abi/test/gen.test.ts` (not W4-C's) doesn't write them. Z could add
`expect(files).toContain('contracts/foundry.toml')` to that test.
