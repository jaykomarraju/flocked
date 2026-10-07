# Wave 15: Launch prep

**Goal.** Audit findings fixed and re-verified. Security and soak findings fixed. The production deploy rehearsed end to end on a Base fork. The fixed system redeployed to staging and fully regression-tested.

**Base.** Tag `wave-14`. **Hold point:** OA-20 audit report received (for W15-A). The soak can keep running across this wave.

## W15-A: Audit fixes

- **Role / size:** build, M.
- **Objective.** Fix every audit finding in `contracts/` (or record the owner's formal acceptance), with a regression test per finding. Update the audit package with a fix log for the auditor's fix review. If a fix changes the closed form or a leaf format, regenerate the vectors and update `@flocked/settle`/`@flocked/verify` in lockstep. Raise any behaviour change as a spec issue first.
- **Read first.** `plan.md` §2. `docs/sessions/W14-Z.md`. The audit report (path given by the owner, saved under `docs/audit/report-<date>.pdf`). `docs/audit/package.md`.
- **Owns.** `contracts/**`, `docs/audit/**`, and `packages/settle/**` only if the vectors must change.
- **Required tests.** `forge test --profile ci`; CON-1..13 still green; new regression tests.

## W15-B: Security and soak fixes

- **Role / size:** build, M (split by area if the findings list is long).
- **Objective.** Fix the W13-C security findings and anything the soak surfaced so far, each with a test. Get the owner's acceptance for anything not fixed.
- **Read first.** `plan.md` §2. `docs/sessions/W14-Z.md`. `docs/audit/security-review.md`. `docs/runbooks/soak-report.md`.
- **Owns.** The paths each finding touches (list them in the prompt Z writes; must not overlap W15-A or W15-C).

## W15-C: Production dry run on a Base fork

- **Role / size:** build, M.
- **Objective.** Rehearse the production deploy on an anvil fork of Base with production parameters: CREATE2 addresses; multisig admin and guardian (fork-impersonated); real Base USDC; drand quicknet constants; roles and timelocks verified onchain; flag defaults (`geo.stakes.allow` empty; Stakes per gates); Workers `--dry-run` with production config. Write `docs/runbooks/production-launch.md`, a step-by-step checklist with the owner's signing steps and a go/no-go table for the four gates.
- **Read first.** `plan.md` §2, §6, §7. `docs/sessions/W14-Z.md`. `docs/runbooks/deploy.md`.
- **Owns.** `scripts/deploy/prod-rehearsal/**`, `docs/runbooks/production-launch.md`.

## W15-D: Staging redeploy + full regression

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C. If the contracts changed, redeploy them to Base Sepolia (new deployment JSON) and Workers to staging. Run the full regression: `pnpm check`, `pnpm e2e`, `pnpm e2e:ui`, the staging smoke, and the verify CLI over every staging round so far. Confirm every traceability row is ✅ or has a named reason (PR-1).
- **Read first.** `plan.md` §2, §3.4, §7. Handoffs W15-A, B, C.
- **Owns.** Registry files; `contracts/deployments/84532.json`.
- **Emits.** W15-Z prompt.

## W15-Z checklist

- PR-1, PR-2, PR-3 (pending the auditor's fix-review letter), PR-9 status recorded.
- Gate status table for the owner: legal (OA-21), Coinbase (OA-22), audit (OA-20), load test (OA-23), soak (OA-25). Wave 16 starts only when gates 1, 3 and 4 have passed and the soak is complete. Gate 2 decides whether Stakes is enabled.
