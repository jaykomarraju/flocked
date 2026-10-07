# Wave 16: Production

**Goal.** Flocked is live in production: contracts on Base with multisig roles, every Worker deployed, Free mode live, Stakes enabled only if gate 2 passed and only for counsel-approved jurisdictions. The final Z confirms production readiness.

**Base.** Tag `wave-15`. **Hold points (all required):** gate 1 legal (OA-21), gate 3 audit with fix review (OA-20), gate 4 load test (OA-23), staging soak (OA-25), production keys, multisigs and funding (OA-15, OA-16, OA-17), and production approvals (OA-26). Gate 2 (OA-22) decides whether Stakes is on.

This wave has a single build session. Nothing else can run in parallel with a production deploy.

## W16-A: Production deploy

- **Role / size:** build, M.
- **Objective.** Follow `docs/runbooks/production-launch.md` step by step:
  - deploy the contracts to Base (the owner signs the multisig role transactions);
  - commit `contracts/deployments/8453.json`;
  - deploy Workers through the `production` environment (owner approves);
  - deploy the watcher on its own account;
  - set flags and config: Free on; `geo.stakes.allow` from counsel's list; `mode.stakes.enabled` on only if gate 2 passed;
  - verify the dead-man's switch and paging;
  - schedule the first production round, and watch it through lock, open, close, beacon, reveal and (for Stakes) proposal, finalize and claim;
  - run `npx @flocked/verify` on it.
- **Read first.** `plan.md` §2, §6, §7. `docs/sessions/W15-Z.md`. `docs/runbooks/{production-launch,deploy,secrets}.md`.
- **Owns.** `contracts/deployments/8453.json`, `docs/runbooks/launch-log.md`, production config files.
- **Constraints.** No secret values in chat or files. Stop and ask before every irreversible step the runbook marks.
- **Ends with** the W16-Z prompt.

## W16-Z: Final consolidation and readiness

- Tick every row of `plan.md` §7 Production readiness with evidence links. For any unticked agent work, add wave 17 instead of ending.
- Update Status: every session ✅. Owner actions still open are listed with what each unblocks (e.g. Stakes waiting on gate 2; final mascot art).
- Write `docs/sessions/W16-Z.md` as the launch summary, and tag `v1.0.0`.
