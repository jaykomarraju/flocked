# Session W2-B: `FlockedAnchor`, deploy scripts, `@flocked/abi`

**Role:** build. **Size:** M (split into `W2-B.2` if needed: the escrow changes and `FlockedAnchor` first, deploy scripts and `@flocked/abi` second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-2.md`: the intro, "Pinned interfaces" P2.2, and section "W2-B".
- `docs/plan/wave-1.md`: "Pinned interfaces" P1.3, including "As built" and "Amended by W1-Z".
- `docs/sessions/W1-Z.md` (wave-1 summary), then `contracts/README.md`.
- Spec sections, read only the parts named:
  ```bash
  pnpm spec "Smart contract" --sub 'Contract: `FlockedAnchor`'
  pnpm spec "Smart contract" --sub "Residual risk"                 # the "Stolen anchor key" bullet only
  pnpm spec "Smart contract" --sub "Rules the contract enforces"   # the "Roles" bullet only (changed in wave 1)
  pnpm spec "Smart contract" | grep -n 'unpause\|transferGuardian'  # IFlockedEscrow lines changed in wave 1
  pnpm spec "Sealed picks (timelock encryption)" --sub "Free mode specifics"
  ```
  Also the two Decision log rows from wave 1 about `unpause` and `GUARDIAN_ROLE` (`pnpm spec "Out of scope, launch gates and decision log" | grep -n 'unpause\|GUARDIAN_ROLE'`).

## Objective
First apply the two wave-1 owner decisions to `FlockedEscrow`: `unpause` becomes admin-only, and `GUARDIAN_ROLE` always has exactly one holder, handed on with `transferGuardian`. The second change also removes the unbounded revoke loop in `executeGuardianReplacement`, which a stolen guardian key could otherwise push past the gas limit. Then build `FlockedAnchor` with full tests, CREATE2 deploy scripts for both contracts, and the generated ABI package `@flocked/abi`, so the ABIs include the amended escrow.

## Starting point
- Base: tag `wave-1`. Branch: `w2-b-anchor`. Worktree: `../flocked-w2-b`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w2-b -b w2-b-anchor wave-1
  cd ../flocked-w2-b && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit: `contracts/src/FlockedAnchor.sol`, `contracts/src/interfaces/IFlockedAnchor.sol`, `contracts/test/Anchor*.t.sol`, `contracts/script/**`, `contracts/deployments/**`, `contracts/foundry.toml`, `contracts/.gitignore`, `packages/abi/**`, `docs/sessions/W2-B.md`. `pnpm-lock.yaml` only as `pnpm add`/`pnpm install` changes it for `packages/abi` (D regenerates it if A's and B's changes conflict).
- For the two escrow decisions only: `contracts/src/FlockedEscrow.sol`, `contracts/src/interfaces/IFlockedEscrow.sol`, `contracts/test/Escrow.*.t.sol`, `contracts/test/invariant/**`, `contracts/test/utils/**`, `contracts/README.md`.
- Must not touch: any other `FlockedEscrow` behaviour (record it as an open issue for Z), `contracts/test/Vectors.t.sol`, `contracts/test/MerkleVectors.t.sol`, `contracts/test/TargetRound.t.sol` (W2-D), other packages, root `package.json`, `pnpm-workspace.yaml`, `eslint.config.js`, `.github/workflows/*` (ask D), `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P1.3 as amended by W1-Z: `unpause` is `DEFAULT_ADMIN_ROLE` only (pause stays `PAUSER_ROLE`). `GUARDIAN_ROLE` has exactly one holder at all times: `transferGuardian(address newGuardian)` (guardian only, nonzero, immediate, with an event) hands it on; `grantRole`, `revokeRole` and `renounceRole` revert for it; a `guardian()` view returns the holder; `executeGuardianReplacement` keeps its 7-day timelock and events but replaces the one holder in a single write. Nothing else in P1.3 changes, and there is no `withdrawTo`.
- P2.2: the Anchor constructor; receipt-signer and `ANCHOR_ROLE` timelocks mirroring P1.3; `roundKey`; `Skipped` reasons 1–4; mismatched array lengths revert; the receipt EIP-712 domain `("Flocked", "1")` and typehash; deploy-script env vars and `contracts/deployments/<chainId>.json`; the `@flocked/abi` files and generator.

## Tasks
1. Create the worktree (above).
2. Escrow decisions, as one green commit before anything else: change `unpause`; make `GUARDIAN_ROLE` single-holder as pinned; update NatSpec, `contracts/README.md` and the tests (CON-7); add an invariant that `GUARDIAN_ROLE` always has exactly one holder; re-run coverage.
3. `FlockedAnchor` per P2.2 and the spec: write-once lock, commit and manifest per round key; time windows relative to the beacon (`closesAt ≤ ts < beaconTime` edges); skip-and-emit for invalid batch items. Tests: unit, fuzz, and an invariant that each round key is written at most once per kind (CON-9).
4. `contracts/script/Deploy.s.sol`: CREATE2 with a fixed salt, configured from env (P2.2), deploying `MockUSDC` on anvil, and writing `contracts/deployments/<chainId>.json` (`31337.json` gitignored). Dry run it against a locally started anvil, with a test asserting the JSON.
5. `packages/abi`: `scripts/gen.mjs` reads `contracts/out` and writes `src/FlockedEscrow.ts`, `src/FlockedAnchor.ts`, `src/MockUSDC.ts` (`as const`) and `src/addresses.ts` (`addressesFor(chainId)`). Add scripts `typecheck`, `lint` and `test`, plus a test that the generated files are current.
6. Receipt check: a receipt signed with viem's `signTypedData` using the P2.2 typehash recovers on-chain in a Foundry test, through a `verifyReceipt` view on Anchor if that's useful to clients, otherwise with `ECDSA` in the test.

## Tests and checks
- `(cd contracts && forge fmt --check && forge build && forge test && FOUNDRY_PROFILE=ci forge test)` passes.
- `forge coverage --report summary --no-match-coverage 'test/|dependencies/'` shows ≥ 95% lines on both contracts (report the numbers).
- `pnpm --filter @flocked/abi typecheck` and the root `pnpm check` pass.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Both escrow decisions are in, with CON-7 green. CON-9 has named, passing tests. The deploy dry run passes. `@flocked/abi` is generated from the amended escrow. The handoff is written.

## Constraints
- The spec gives the receipt domain without a version; use "1" and record it as a spec issue (P2.2).
- Risks to test hard: batch skip semantics and time-window edges.
- Never commit secrets; tests generate their own keys. Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, follow plan.md 2.6 (`W2-B.2`).

## End of session
1. Commit, then `git push -u origin w2-b-anchor`.
2. Write `docs/sessions/W2-B.md` from plan.md 3.2. Under "Notes for D and Z", give the root `contracts:build` script (forge build plus ABI codegen), the CI ABI-freshness step, any `pnpm-workspace.yaml` change, and the final escrow and anchor function lists (confirm or amend P1.3 and P2.2). Commit and push.
3. End with your status and: "When W2-A, B and C all report complete, start W2-D from `docs/prompts/W2-D.md`."
