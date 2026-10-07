# Wave 1 summary

## Status

Merged to `main` at `c0ed050` (`--no-ff` of `w1-integration` @ `3a4bc0a`). CI: `w1-integration` run 37696841440 success (`check`, `contracts`, `properties`); `main` run 37697269115 success (`check`, `contracts`, `properties`). Tag `wave-1` is on `main`'s head, the commit that adds this summary and the W2 prompts, so wave-2 worktrees contain them and `main` equals the tag (plan.md 3.4 step 6, amended this wave).

Local checks on both branches: `pnpm install --frozen-lockfile && pnpm check` (20 node:test, 13 shared, 66 settle, 144 forge) and `FOUNDRY_PROFILE=ci forge test` (144) pass, with nothing skipped.

## On main now

- **Workspace root** (W1-A, W1-D): pnpm 10 workspace (`apps/*`, `packages/*`, `e2e`), TypeScript 6.0.3 strict ESM, ESLint 10 flat config (settle gets `strictTypeChecked` and bigint money rules), Prettier, Vitest 4.1.11. `pnpm check` = lint + typecheck + test + `contracts:test`. `pnpm spec` prints one spec section or bold block. CI has three jobs: `check` (with settle vector freshness), `contracts` (Foundry 1.7.1, `FOUNDRY_PROFILE=ci`), and `properties` (`FAST_CHECK_RUNS=10000`).
- **`@flocked/shared`** (W1-A): enums (Mode, RoundKind, RoundStatus, ModeStatus, Category, Provider, UserStatus, NotificationEvent), brand terms and voice lines (`winLine`/`lossLine` take a whole percent).
- **`@flocked/settle`** (W1-C): `settle()` (fees, cap, rebates, dust, VOID exclusion, refund rules 1–3, Free creator award), `settleStakesClosedForm()`, `checkInvariant()`, Stakes payout, Free payout and Free commitment Merkle trees (OpenZeppelin StandardMerkleTree), `userIdHash`. Money is `bigint` only. A deterministic vector generator writes three committed vector files.
- **`contracts/`** (W1-B, W1-D): `FlockedEscrow`, `IFlockedEscrow`, `StakesMath`. 144 forge tests (unit, fuzz, invariant, seed and generated vectors, Merkle proof vectors), 100% line and branch coverage on both sources. solc 0.8.30, OpenZeppelin 5.7.0 and forge-std 1.17.0 through Soldeer. B's and C's math agree on every vector.

## Interfaces changed or added

- `contracts/src/interfaces/IFlockedEscrow.sol`: P1.3 as pinned, plus additive extras (`hasClaimed`, `totalObligations`, `timelockReadyAt`, `operationId`, `ticketDigest`, `domainSeparator`, more events; `beaconTime` returns `uint256`). **Amended by owner decision, built in W2-B:** admin-only `unpause`; single-holder `GUARDIAN_ROLE` with `transferGuardian` and `guardian()`. See wave-1.md P1.3, "Amended by W1-Z".
- `packages/settle/src/index.ts`: P1.2 plus the `StakesClosedForm` shape, `freePayoutTree(...).proof(userIdHash)`, `freeCommitmentTree(...).proof(seq)`, `comparePayouts`, `InvariantError`, leaf constants and types. Inputs are validated strictly (throws).
- `packages/settle/vectors/*.json`: the P1.1 formats, sorted by id, decimal strings, `winner` 255 on refunds.
- `packages/shared/src/{enums,copy}.ts`; `scripts/spec-section.mjs` (`pnpm spec`).

## Decisions

Owner decisions on Oct 7, 2026:
- `unpause` is admin-only; the pauser can only pause.
- No `withdrawTo`. A credited address on Circle's blocklist stays credited until it's unblocked.
- `GUARDIAN_ROLE` has exactly one holder, handed on with `transferGuardian`, and replacement is a single write. This came from the Z review: as built, a stolen guardian key could grant the role to thousands of addresses and push `executeGuardianReplacement`'s revoke loop past the gas limit.
- The repository is public, and `main` has two rulesets: no force pushes or deletion (no bypass), and CI required (`check`, `contracts`, `properties`; repository admins bypass, so Z can push its merge).
- Written into the spec as built: the wave-1 contract input checks, refund-rule order 1 → 2 → 3, refunds after a veto, veto evidence, event meanings, timelock execution with no expiry, one entry per account per round, `minEntrants` and `capMultiple` ≥ 1, no creator fee or award on refund, and room qualification decided by the API.
- The voice-line percentage rule: whole percent, winning share rounded down, losing share rounded up, "<1%" and ">99%" at the extremes.
- `Mode` stays in both packages, with an equality test (engineering).

Spec sections edited: "Smart contract" ("Rules the contract enforces": `createRound`, `enter`, `propose`, `veto`, `claim`, `claimRefund`, `withdraw`, state machine, Roles; the `IFlockedEscrow` code block's `unpause` comment and new `transferGuardian` line), "Settlement and payout math" (notes under the refund table), "Profiles, leaderboards and rooms" (Anti-farming), and five Decision log rows. `Design_Language.md` is unchanged: the Decision log row governs its Voice examples.

## Traceability

Closed (✅): CON-1..8, CON-10..13, SET-1..3, SET-5, SET-6, PROP-1..5, each with named tests in `docs/plan/traceability.md`. Partly proven (🟡): SET-4 (math only; tlock in W2-A, pipeline in W5-A), AC-4, AC-5, NFR-6. No row due in wave 1 is still open.

## Carry-over

- **W2-B:** the two escrow decisions (admin-only `unpause`; single guardian), CON-7 kept green, before ABI generation.
- **W2-D:**
  - CI hardening from the review: `pnpm --filter` and `vitest -t` steps can pass while running nothing.
  - The `Mode` equality test.
  - The share-percentage rule in `copy.ts`.
- **W4-C:** slither and aderyn haven't run yet.
- **Watch:** `Vectors.t.sol` keeps the vector JSON in storage (about 435M gas for 63 vectors). If the file grows a lot, switch it to `MerkleVectors.t.sol`'s in-memory pattern.
- **Watch:** GitHub's `ubuntu-latest` moves to Ubuntu 26 from Oct 19, 2026.
- **Watch:** TypeScript 7 (blocked by typescript-eslint `<6.1`) and Vitest 5 (needs Node 22) wait for those to move.
- **Every prompt:** a fresh worktree needs `(cd contracts && forge soldeer install)` before `pnpm check`. The CI Foundry profile is `FOUNDRY_PROFILE=ci forge test`; plan.md 2.4, 3.4, 4.3 and 4.6 and wave files 1, 4 and 15 are updated.

## Owner actions

- **OA-03:** done (Actions on, repo public, rulesets on `main`).
- **OA-02** (needed by W2-C): the Paper MCP tools are visible to Claude Code in W1-Z's session. W2-C confirms they work as its first step.
- **OA-01** (needed by W3): open OrbStack once and check `docker run hello-world`.
- **Start now** (all marked "start by W1"):
  - **OA-20**, gate 3: book the contract auditor. The package comes from W4-C after W4-Z.
  - **OA-21**, gate 1: legal sign-off. ToS and privacy text are needed by W12.
  - **OA-22**, gate 2: confirm that Coinbase `GET /v2/user/personal-details` returns data only for ID-verified accounts.
- **Because the repo is public:** commit author emails are visible in history, and audit findings fixed in W15 will be public before the mainnet deploy.

## Next wave

Prompts emitted: `docs/prompts/W2-A.md`, `W2-B.md`, `W2-C.md`, `W2-D.md`. A, B and C run in parallel (C needs the Paper MCP); D starts when all three report complete. Changes from the wave file:
- W2-B also applies the two escrow decisions, and may split as `.2`.
- W2-D gets the three carry-overs.
- Setup lines include `forge soldeer install`.
- A and B may change `pnpm-lock.yaml` only through `pnpm add`, and D regenerates it on conflict.

W1-Z used one review subagent (plan.md 2.8). It ran past size S (four handoffs, spec sections and two rounds of owner questions); no work was split out.
