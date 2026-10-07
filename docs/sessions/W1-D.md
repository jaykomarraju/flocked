# W1-D handoff: Workspace + CI wiring, vector cross-check

## Status

complete — A, B and C merged on `w1-integration`; settle is in the workspace; Foundry is in `pnpm check` and CI; CON-13 proven; CI green.

## Summary

- `w1-integration` = `main` + `--no-ff` merges of `w1-a-scaffold`, `w1-b-escrow`, `w1-c-settle` (no conflicts).
- `@flocked/settle` folded in: nested lockfile and local ESLint config removed, `tsconfig.json` extends `../../tsconfig.base.json`, devDeps trimmed to `fast-check` and `tsx` (the rest come from the root, same versions).
- Root `eslint.config.js` gains two settle blocks: `strictTypeChecked` (what C wrote against) for `packages/settle/**/*.ts`, and C's bigint money rules for `packages/settle/src/**/*.ts` (probe: `Math.floor(parseFloat(x))` in `src/` reports 2 errors).
- Root scripts `contracts:build`, `contracts:test`; `check` = lint + typecheck + test + `contracts:test`.
- CI: `check` job gains a vector-freshness step; new `contracts` job (Foundry v1.7.1, `forge soldeer install`, `fmt --check`, `build`, `FOUNDRY_PROFILE=ci forge test`); new `properties` job (`FAST_CHECK_RUNS=10000`).
- `Vectors.t.sol` checks the 63 generated closed-form vectors against `StakesMath` (every field) and runs the 24 that fit launch ceilings through `createRound` → `enter` → `propose` → `finalize`; B's 10 seed vectors stay as a second input with the same checks.
- New `MerkleVectors.t.sol`: every recorded proof (all 5 trees, 67 proofs incl. the 1,203-leaf tree) verifies with OZ `MerkleProof` and fails for a shifted round id or kind; the 25-leaf `small-settled` tree is settled on a real round with id 10 and every leaf is claimed, draining the round to exactly the treasury and creator credits.
- **B and C agree.** No vector disagreed; no side needed a fix.

## Branch and head commit

`w1-integration` @ `117d8f8` (before this handoff commit)

## Files touched

- Edited (root): `package.json`, `pnpm-workspace.yaml` (`onlyBuiltDependencies: [esbuild]`), `pnpm-lock.yaml`, `eslint.config.js`, `.prettierignore`, `.github/workflows/ci.yml`, `CLAUDE.md` (commands section + toolchain line)
- `packages/settle`: deleted `pnpm-lock.yaml`, `eslint.config.js`; edited `package.json`, `tsconfig.json`; Prettier-only reformat of `README.md`, `src/{invariant,merkle,settle}.ts`, `scripts/vectors.ts`, `test/*.ts`
- Contracts: edited `contracts/test/Vectors.t.sol`; new `contracts/test/MerkleVectors.t.sol`
- New: `docs/sessions/W1-D.md`, `docs/prompts/W1-Z.md`

## Tests run

| Command                                                                         | Result                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile && pnpm check`                                  | pass (20 node:test, 13 shared, 66 settle, 144 forge)                                                          |
| `pnpm format:check`                                                             | pass                                                                                                         |
| `forge fmt --check` (in `contracts`)                                            | pass                                                                                                         |
| `FOUNDRY_PROFILE=ci forge test` (in `contracts`)                                | pass, 144 tests, ~32 s                                                                                       |
| `FAST_CHECK_RUNS=10000 pnpm --filter @flocked/settle test -t property`          | pass (5 properties)                                                                                          |
| `pnpm --filter @flocked/settle vectors && git diff --exit-code packages/settle/vectors` | clean                                                                                                 |
| Mutation: `winPayout` digit 1→2 in `cap-binding-1-vs-20`                        | `forge test` fails both settle-vector tests (`11000000 != 21000000`); reverted, not committed               |
| Mutation: one hex digit of the `large-1203-leaf` root                           | `test_merkleVectors_everyProofVerifies` fails; reverted, not committed                                        |
| CI on `w1-integration` (run 37693720029)                                        | success: `check`, `contracts`, `properties`                                                                  |

## Traceability rows covered

- CON-13: `contracts/test/Vectors.t.sol` :: `test_settleVectors_header`, `test_settleVectors_matchStakesMath`, `test_settleVectors_throughPropose`; `contracts/test/MerkleVectors.t.sol` :: `test_merkleVectors_header`, `test_merkleVectors_everyProofVerifies`, `test_merkleVectors_claimOnSettledRound`.

## Deviations

- **`forge test --profile ci` doesn't exist** in Foundry 1.7.1 (`unexpected argument '--profile'`, confirmed). CI and docs use `FOUNDRY_PROFILE=ci forge test`. The plan's 4.3/4.6 wording should follow (Z).
- **Seed-vector tests renamed**, not removed: B's `test_vectors_{header,matchStakesMath,throughPropose}` are now `test_seedVectors_*` with the same assertions; the generated file gets the `test_settleVectors_*` trio. Net forge count 138 → 144.
- **Generated vectors through `propose`:** all 24 that fit the launch ceilings and ≤ 200 entrants (a superset of "a sample"); the test requires ≥ 10.
- **Merkle claim test enters the vector's own accounts** (`claim` reverts `NotEntrant` otherwise) and burns round ids 1–9 so the on-chain id equals `chainRoundId` 10.
- **Settle formatting:** settle wasn't Prettier-formatted, so CI's `format:check` would fail. Ran `prettier --write` over settle's `src`, `test`, `scripts`, `README.md`: whitespace/line-wrapping only, under the "integration break" allowance for `src/**`. Generated `packages/settle/vectors/*.json` are added to `.prettierignore` (they must stay byte-identical to the generator; `.prettierignore` wasn't in my file list).
- **settle devDependencies** trimmed to `fast-check`, `tsx`; `eslint`, `typescript`, `vitest`, `@types/node` etc. resolve from the root at identical versions (same pattern as `@flocked/shared`).
- `onlyBuiltDependencies: [esbuild]` added to `pnpm-workspace.yaml` (C's open issue: the ignored-build-script warning).
- `forge build` in CI is an extra step before `forge test` (B's recommended order).

## Spec issues

None new. The B/C cross-check found no disagreement, so nothing to raise beyond B's and C's own lists.

## Open issues

- Running `pnpm check` in a fresh worktree needs `(cd contracts && forge soldeer install)` first (documented in `CLAUDE.md`). Later waves' `pnpm install` steps should mention it.
- `Vectors.t.sol` keeps the JSON in storage (B's pattern) and burns ~435M gas on the 63-vector file; fine under Foundry's default gas limit. If the file grows a lot, switch it to the in-memory pattern used in `MerkleVectors.t.sol`.
- The `Mode` duplication between `@flocked/shared` and `@flocked/settle` (A's spec issue) is untouched; Z to decide.

## Notes for D and Z

- Z: CON-13 is the only W1-D row. CON-1..12 (B), SET-1..6 and PROP-1..5 (C) are named in their handoffs and all pass on `w1-integration`.
- Z: update plan.md 4.3/4.6 for `FOUNDRY_PROFILE=ci`, and P1.4's "CI profile `ci`" wording if wanted.
- Risky diffs worth reading: `eslint.config.js` (settle blocks), `.github/workflows/ci.yml`, `contracts/test/MerkleVectors.t.sol`.
- Owner-decision items carried from B (spec issues 6 and 8) and C's spec issues are unchanged; see their handoffs.
