# Session W4-C: Contracts audit prep

**Role:** build. **Size:** M. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-4.md`: the intro, "W4-C", and the W4-C item of "Carry-over from W2-Z".
- `docs/sessions/W3-Z.md` (wave-3 summary). Then `contracts/README.md`.
- Code: `contracts/src/**`, `contracts/test/**`, `contracts/foundry.toml`, `packages/abi/scripts/gen.mjs`. Read `contracts/script/**` only; it isn't yours to change.
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "Smart contract"
  pnpm spec "Settlement and payout math" --sub "Stakes closed form"
  pnpm spec "Settlement and payout math" --sub "Invariant"
  ```
  Changed in wave 3 (Decision log, Oct 9, 2026): "Settlement and payout math" (refund rule 7 doesn't apply to an empty Free mode, which refunds under rule 1). Nothing in "Smart contract" changed. The Oct 8 rows still apply: `FlockedAnchor` as built, foreign entries, and the escrow decisions.

## Objective
Harden both contracts and freeze them for audit:
- Run slither and aderyn, and triage every finding.
- Extend the invariant handlers for both contracts and complete the NatSpec.
- Fix the escrow nits from the W2-Z review.
- Write the audit package: scope, architecture, roles and timelocks, the trust model and residual risks (taken from the spec), known issues, test instructions, and the commit hash to audit.

The owner hasn't booked an auditor yet (OA-20). W4-Z gives them the package.

## Starting point
- Base: tag `wave-3`. Branch: `w4-c-audit-prep`. Worktree: `../flocked-w4-c`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w4-c -b w4-c-audit-prep wave-3
  cd ../flocked-w4-c && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
- Install slither (`pipx install slither-analyzer` or `uv tool install slither-analyzer`) and aderyn (Cyfrin's installer or `cargo install aderyn`) locally. Record their versions in the handoff.

## Scope and file ownership
- May create or edit:
  - `contracts/**`, except `contracts/deployments/` and `contracts/script/`;
  - `docs/audit/**`;
  - the generated `packages/abi/src/**`, rebuilt with `pnpm contracts:build` after any contract or NatSpec change, so CI's ABI freshness check passes;
  - `packages/abi/scripts/gen.mjs`, only to add `foundry.toml` and `remappings.txt` to its source hash;
  - `docs/sessions/W4-C.md`.
- Must not touch:
  - `contracts/script/**` and `contracts/deployments/**` (if a change breaks the deploy dry run, record it for D);
  - `.github/workflows/*` (D adds the static-analysis job from your notes);
  - `apps/**`, `packages/{shared,settle,tlock}/**`;
  - `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- The contracts' external ABI and events, as `packages/abi` exports them. Wave 4's A, B and D build against them in parallel. Hardening may add an event field only where the W2-Z nits ask (`GuardianReplaced.previous`, `GuardianTransferred` on admin replacement); list every ABI change under "Notes for D and Z".
- Anything beyond hardening (a behaviour change, a new function, a changed revert condition) is a spec issue to raise, not a silent change.

## Tasks
1. Create the worktree (above) and install the tools.
2. The W2-Z escrow nits:
   - `GuardianReplaced` gains `previous`;
   - admin replacement emits `GuardianTransferred`;
   - remove the dead `_setRoleAdmin(GUARDIAN_ROLE, GUARDIAN_ROLE)`.
   Also: the `gen.mjs` source hash covers `foundry.toml` and `remappings.txt`; `anchorManifest` needs a lock but not a commit (already in the spec, so check the tests say so); and confirm the CREATE2 factory exists on Base Sepolia and Base, with chain IDs and a source for each.
3. slither and aderyn: write `docs/audit/static-analysis.md`. Give every finding a verdict (fixed, false positive with the reason, or accepted with the reason). Leave no high or medium unexplained.
4. Invariants: extend the handlers for both contracts (escrow conservation per round and claim exclusivity; anchor write-once per key and timelock ordering). Complete the NatSpec on every external function and event.
5. Audit package: `docs/audit/package.md` (scope, architecture, roles and timelocks, test instructions, the commit hash to audit) and `docs/audit/threat-model.md` (trust model, residual risks from the spec, known issues).
6. Put the CI static-analysis steps (pinned tool versions, failing on a new high or medium) under "Notes for D".

## Tests and checks
- `pnpm check`, `pnpm format:check`, `(cd contracts && forge fmt --check && FOUNDRY_PROFILE=ci forge test)` and `pnpm contracts:build` with a clean `git status` afterwards. Also `node packages/abi/scripts/gen.mjs --check`.
- Coverage of at least 95% of lines on both contracts (`forge coverage --report summary`; W2-B had 100%). slither and aderyn leave no unexplained high or medium.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- The three `docs/audit/*.md` files exist, and the package names the exact commit to audit (your final contracts commit).
- Static analysis is triaged, coverage is at least 95%, the invariants are extended, and the handoff is written.
- The tag `audit-candidate-1` is created by W4-Z at merge, not by you.

## Constraints
- Never commit secrets; tests use forge's generated keys.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions. Don't book or contact an auditor (OA-20 is the owner's).
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W4-C.2`).

## End of session
1. Commit, then `git push -u origin w4-c-audit-prep`.
2. Write `docs/sessions/W4-C.md` from plan.md 3.2. Put ABI changes, the CI static-analysis steps and anything the deploy scripts need under "Notes for D and Z". Commit and push.
3. End with your status and: "When W4-A, B and C all report complete, start W4-D from `docs/prompts/W4-D.md`."
