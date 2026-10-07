# Session W1-D: Workspace + CI wiring, vector cross-check

**Role:** integrate. **Size:** S. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.2 (Handoff template), 3.4 (Z checklist) and 4.3 (Canonical commands). Read nothing else in `plan.md`.
- `docs/plan/wave-1.md`: "Pinned interfaces" P1.1 and P1.4, sections "W1-D" and "W1-Z checklist".
- Handoffs: `docs/sessions/W1-A.md`, `docs/sessions/W1-B.md`, `docs/sessions/W1-C.md` (on their branches: `git show origin/w1-a-scaffold:docs/sessions/W1-A.md` etc.).
- `contracts/README.md`, `packages/settle/vectors/README.md` after merging.
- No spec sections are needed. If a vector disagreement forces it, read only "Settlement and payout math" ("**Stakes closed form**").

## Objective
Merge the three wave-1 branches into `w1-integration`. Fold `packages/settle` into A's workspace, add Foundry to `pnpm check` and CI, switch the contract vector test to `@flocked/settle`'s generated vectors, and add the Merkle-vector test, proving CON-13. Then emit the W1-Z prompt.

## Starting point
1. **Check first.** Read the three handoffs. If any status isn't `complete`, stop. Print the continuation prompts the owner must run first (from `docs/prompts/W1-{X}.2.md`, which the partial session saved), plus a fresh copy of this prompt to run after them. Write no handoff.
2. Workspace:
   ```bash
   git fetch origin --tags
   git worktree add ../flocked-w1-d -b w1-integration main
   cd ../flocked-w1-d
   git merge --no-ff origin/w1-a-scaffold
   git merge --no-ff origin/w1-b-escrow
   git merge --no-ff origin/w1-c-settle
   ```

## Scope and file ownership
- May create or edit: root registry files (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `eslint.config.js`, `.github/workflows/ci.yml`), `packages/settle/{package.json,tsconfig.json,eslint.config.*,vitest.config.*}`, removal of `packages/settle/pnpm-lock.yaml`, `contracts/test/Vectors.t.sol`, `contracts/test/MerkleVectors.t.sol`, `CLAUDE.md` (commands section only), `docs/sessions/W1-D.md`, `docs/prompts/W1-Z.md`.
- Must not touch: `contracts/src/**`, `packages/settle/src/**`, `packages/shared/src/**` (except fixing an integration break, which you record in Deviations), the spec, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P1.1 vector formats; P1.4 conventions; plan.md 4.3 canonical commands.

## Tasks
1. Check the handoffs and merge (above).
2. Fold settle in: delete its nested lockfile; make its tsconfig extend `../../tsconfig.base.json` and its lint use the root ESLint config (remove the local one); `pnpm install` at the root; make `pnpm check` pass for all packages.
3. Root scripts: `contracts:build` (`forge build --root contracts`), `contracts:test` (`forge test --root contracts`), and `check` = lint + typecheck + test + `contracts:test`. Update `CLAUDE.md`'s command table.
4. CI: add a `contracts` job (`foundry-rs/foundry-toolchain` pinned to 1.7.1; `forge soldeer install` in `contracts`; `forge fmt --check`; `forge test --profile ci`), a vector-freshness step (`pnpm --filter @flocked/settle vectors && git diff --exit-code packages/settle/vectors`), and a property job with `FAST_CHECK_RUNS=10000`.
5. `contracts/test/Vectors.t.sol`: read `../packages/settle/vectors/stakes-closed-form.json` (and keep the seed file as an extra input), checking every vector against `StakesMath` and a sample through `propose`.
6. `contracts/test/MerkleVectors.t.sol`: verify every recorded proof against its root with OpenZeppelin `MerkleProof`, and for one vector settle a real round with that root and `claim` with a recorded proof.
7. If B's seed vectors and C's generated vectors disagree, find which side departs from the spec, fix the smaller side (record it in Deviations), and note it for Z.
8. Locally, change one digit in a generated vector to confirm `forge test` fails, then revert (don't commit).
9. `pnpm install --frozen-lockfile && pnpm check` green; push and confirm CI is green on `w1-integration`.

## Tests and checks
- `pnpm check` (includes `forge test`); `forge test --root contracts --profile ci`; CI green on `w1-integration`.
- CON-13 passes. No test is skipped, deleted or weakened without a line in the handoff's Deviations.

## Definition of done
- `w1-integration` contains all three branches, builds and tests green locally and in CI; CON-13 proven; handoff written; W1-Z prompt saved and printed.

## Constraints
- No new features. Stage files by name. Commits end with the attribution line from your system reminder.
- Don't merge into `main` (Z does).

## End of session
1. Commit and `git push -u origin w1-integration`.
2. Write `docs/sessions/W1-D.md` from plan.md 3.2. Commit and push.
3. Draft the W1-Z prompt from plan.md 3.1 (role consolidate, size S) using plan.md 3.4 and the "W1-Z checklist" in `docs/plan/wave-1.md`. It must point Z at the four handoffs, the branch `w1-integration`, and `docs/plan/wave-2.md` for the next prompts. Save it to `docs/prompts/W1-Z.md`, commit, push, and print it in one fenced block. Tell the owner to start W1-Z in a fresh session.
