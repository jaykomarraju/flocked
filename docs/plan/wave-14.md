# Wave 14: Staging

**Goal.** The whole system runs on staging (Cloudflare `env.staging`, Base Sepolia, drand quicknet) with real third-party services. The full-scale load test runs there. The staging soak begins. Accessibility, performance, runbooks and rollback are verified.

**Base.** Tag `wave-13`. **Hold point:** OA-04 through OA-19 done for staging (Sepolia keys, multisigs, RPCs, bundler/paymaster, Coinbase OAuth app, Farcaster, VAPID, Turnstile, Access, DNS/email, watcher account, paging, dead-man's switch).

## W14-A: Staging deploy + Sepolia contracts

- **Role / size:** build, M.
- **Objective.** Deploy the contracts to Base Sepolia with the owner (the owner signs multisig role transactions; the session prepares them). Deploy every Worker to staging through the pipeline. Configure flags (`mode.free.enabled` on; `mode.stakes.enabled` on in staging with a test `geo.stakes.allow`). Run `pnpm e2e:staging`, a smoke subset adapted for real services (sign-in, Free entry, Stakes entry with Sepolia USDC, reveal, card, claim). Verify the watcher on its own account and the dead-man's switch heartbeat.
- **Read first.** `plan.md` §2, §4.4. `docs/sessions/W13-Z.md`. `docs/runbooks/{deploy,secrets}.md`.
- **Owns.** `contracts/deployments/84532.json`, `e2e/staging/**`, `docs/runbooks/staging.md`.
- **Required tests.** The staging smoke suite green; the first staging daily round settles automatically.
- **Constraints.** Never handle private keys in chat or files; the owner enters secrets with `wrangler secret put` or GitHub environment secrets.

## W14-B: Accessibility and performance

- **Role / size:** build, M.
- **Objective.** A WCAG 2.1 AA audit of every screen: axe across all routes and states, keyboard paths, screen-reader labels on the reveal, contrast, reduced motion (NFR-9). Fix issues in web code. Performance: bundle size budget, LCP and INP on mobile emulation; NFR-2 latency measured on staging (Free entry p95 < 400 ms committed; `/rounds/today` p95 < 100 ms from cache).
- **Read first.** `plan.md` §2. `docs/sessions/W13-Z.md`. Spec: "Non-functional requirements" (Latency, Accessibility rows). Load the `web-perf` skill.
- **Owns.** `apps/web/**` fixes (record each), `docs/runbooks/a11y-perf-report.md`, `e2e/ui/a11y.spec.ts`.
- **Required tests.** NFR-2, NFR-9 measured and passing.

## W14-C: Runbooks and rollback

- **Role / size:** build, M.
- **Objective.** Write runbooks: incident response; key compromise (operator, ticket signer, receipt signer, anchor, guardian), each with exact steps (revoke, pause, rotate through timelocks, redeploy and migrate); guardian veto procedure and charter checklist; settlement retry; drand outage; Base halt at close; indexer lag; D1 restore (time travel); Workers version rollback; flag kill switches; the self-exclusion support process. Rehearse rollback and D1 restore on staging and log the drill (PR-8).
- **Read first.** `plan.md` §2, §7. `docs/sessions/W13-Z.md`. `docs/runbooks/*`. Spec: "Smart contract" (only "Residual risk", "Challenge window, watcher and guardian").
- **Owns.** `docs/runbooks/**` (except files owned by A/B/D this wave), `scripts/ops/**`.
- **Required tests.** The drill log, with commands and results.

## W14-D: Staging load test + soak start

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C. Run the full load test on staging: 100k entries per mode, both modes, cold start, 50k WebSocket clients. Report reveal p95 (NFR-1, NFR-3, NFR-4) in `docs/runbooks/load-test-report.md`. If it misses the target, stop and send the fan-out design back to the owner (spec rule); don't tune the target. Start the staging soak (≥ 7 consecutive daily rounds, both modes, watcher all-match, no manual step) and give the owner the soak checklist (OA-25).
- **Read first.** `plan.md` §2, §3.4. Handoffs W14-A, B, C. `docs/runbooks/load-test.md`.
- **Owns.** Registry files; `docs/runbooks/{load-test-report,soak-report}.md`.
- **Required tests.** NFR-1, NFR-3, NFR-4, NFR-5 (measured during soak), AC-1 (staging, completes after soak).
- **Emits.** W14-Z prompt.

## W14-Z checklist

- NFR-1..5, NFR-9 and PR-4/5/7/8/10 status recorded. The owner gets the load-test report for gate 4 sign-off (OA-23).
- Audit report (OA-20) received? Wave 15's W15-A needs it. If it hasn't arrived, wave 15 runs B, C and D, and W15-A runs as a fix wave (`W15-F1`) when the report lands.

## Carry-over from W2-Z (Oct 8, 2026)

- **W14-A:** `apps/api/wrangler.jsonc` staging has `workers_dev: false` and no routes, so staging is unreachable until routes are added; staging and production resource IDs are owner-supplied placeholders. Confirm the CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` exists on Base Sepolia and Base before the first deploy.

## Carry-over from W3-Z (Oct 9, 2026)

- **W14-D (soak):** watch for KV-consistency failures on email codes and SIWE nonces ("invalid" right after a send) if W7-B hasn't moved them into the AuthDO.
