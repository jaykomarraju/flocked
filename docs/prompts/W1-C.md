# Session W1-C: `@flocked/settle`

**Role:** build. **Size:** M. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4.2 (Toolchain). Read nothing else in `plan.md`.
- `docs/plan/wave-1.md`: the intro, "Pinned interfaces" P1.1, P1.2 and P1.4, and section "W1-C".
- `docs/plan/traceability.md`: rows SET-1..6 and PROP-1..5 only.
- There is no earlier wave summary (wave 1).
- Spec sections (no `pnpm spec` yet; use `awk '/^## <heading>$/{p=1;print;next} /^## /{p=0} p' Product_Spec.md`):
  - "Settlement and payout math" (all)
  - "Sealed picks (timelock encryption)": "**Invalid entries**" only
  - "Profiles, leaderboards and rooms": the "**Anti-farming**" bullets under "Rooms" only

## Objective
Implement `@flocked/settle`, the pure, shared settlement engine (general formula, Stakes closed form, invariant check, refund rules 1–3, OpenZeppelin StandardMerkleTree builders), plus the deterministic vector generator and the recorded vectors that the contracts, the verify CLI and the watcher will all use. Prove it with exhaustive unit tests and fast-check properties.

## Starting point
- Base: tag `wave-0`. Branch: `w1-c-settle`. Worktree: `../flocked-w1-c`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w1-c -b w1-c-settle wave-0
  cd ../flocked-w1-c
  ```
- The workspace root doesn't exist yet (W1-A builds it in parallel). Make `packages/settle` self-contained per P1.4 and install inside it: `cd packages/settle && pnpm install`.

## Scope and file ownership
- May create or edit: `packages/settle/**`, `docs/sessions/W1-C.md`.
- Must not touch: any root file, `contracts/`, other packages, the spec, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P1.2: the public API (names, types, bigint-only money, sorting, refund payout behaviour, dependency limits `@openzeppelin/merkle-tree` + `viem`, runs in browser/Workers/Node).
- P1.1: the three vector files, their exact JSON shape (all numerics as decimal strings), coverage requirements, and `pnpm vectors` determinism.
- P1.4: package.json name/scripts, tsconfig settings, nested lockfile allowed (W1-D removes it).

## Tasks
1. Create the worktree; scaffold `packages/settle` (package.json, tsconfig, local ESLint flat config, Vitest config).
2. `src/`: types and `VOID_REASONS`; `settle()` (general formula with fees, cap, rebates, dust; VOIDs excluded and refunded; refund rules 1–3 incl. `countQualifyingOnly`; Free `creatorAward` outside the invariant); `settleStakesClosedForm()`; `checkInvariant()`; Merkle builders `stakesPayoutTree`, `freePayoutTree`, `freeCommitmentTree`; `userIdHash`. Never use `number` for money; add a test that fails if `src/` contains arithmetic on `number` for stake fields (e.g. a type-level test plus a grep test).
3. Tests (file names from traceability): refunds (rules 1–3, ties, room qualification), cap binding and not, rebates, Free minority holding more stake, each VOID reason, single-base-unit stakes, maximum Stakes values (100 USDC × large headcounts) in bigint.
4. Property tests (fast-check, ≥ 1,000 runs; `FAST_CHECK_RUNS` env overrides for a 10,000-run CI job): PROP-1..5. For PROP-5, generate fixed-stake rounds and assert the general formula equals the closed form per entry.
5. Merkle cross-check: roots equal `StandardMerkleTree.of(values, types).root` from `@openzeppelin/merkle-tree` directly; proofs verify.
6. `scripts/gen-vectors.ts` with a fixed seed → `vectors/stakes-closed-form.json` (≥ 40 vectors, coverage per P1.1), `vectors/stakes-payout-merkle.json` (1-leaf, 2-leaf, odd count, ≥ 1,000 leaves with sampled proofs), `vectors/free-general.json`; `vectors/README.md` documents the formats. `pnpm vectors` twice gives byte-identical files (test it).
7. `README.md` with the formula and one worked example.
8. `pnpm typecheck && pnpm lint && pnpm test` green.

## Tests and checks
- In `packages/settle`: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `FAST_CHECK_RUNS=10000 pnpm test -t property`, and `pnpm vectors && git diff --exit-code vectors/`.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations.

## Definition of done
- SET-1..6 and PROP-1..5 each have a named, passing test listed in the handoff.
- The three vector files are committed and reproducible.

## Constraints
- Follow the spec's formulas exactly (floor everywhere, bigint). Where a rule is ambiguous, implement the safest reading and record it under Spec issues.
- No secrets. Stage files by name. Commits end with the attribution line from your system reminder.
- Running low on context: stop at a green commit, write the handoff as `partial`, and emit `W1-C.2` (save to `docs/prompts/W1-C.2.md`).

## End of session
1. Commit and `git push -u origin w1-c-settle`.
2. Write `docs/sessions/W1-C.md` from plan.md 3.2. In "Notes for D and Z", list the package's dependency versions, how to run the vector generator, anything W1-D must change when folding the package into the workspace, and any deviation from P1.2. Commit and push.
3. End with your status line and: "When W1-A, B and C all report complete, start W1-D from `docs/prompts/W1-D.md`."
