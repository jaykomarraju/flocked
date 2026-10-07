# Wave 13: Hardening

**Goal.** Every alert is routed and proven. A load-test harness exists. An internal security review is done. Deploys to staging and production are automated, with reviewers and a secrets inventory.

**Base.** Tag `wave-12`. **Owner actions needed now:** OA-04 (Workers Paid, deploy token) and OA-14 (GitHub environments) for W13-D's dry runs. If they're missing, W13-D builds and validates the pipeline with `wrangler deploy --dry-run` and stops short of a real deploy.

## W13-A: Observability and alerts

- **Role / size:** build, M.
- **Objective.** Route every `raiseAlert` code to the paging webhook and a notification channel, with severities. Add DO error capture (ALERT-6 DO half), Workers Logs/Logpush configuration, a structured log schema with the pre-beacon redaction proven, uptime checks for read paths around the reveal (NFR-5 monitor), and admin live-round health metrics. Write an injection test for each ALERT row.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W12-Z.md`. Spec: "Non-functional requirements" (Observability row and "Alerts"). `packages/shared/src/alerts.ts`.
- **Owns.** `apps/api/src/observability/**`, `apps/api/src/lib/alert.ts` (body), `apps/watcher/src/alerting.ts` (only the routing glue; note it), `docs/runbooks/alerts.md`, `apps/api/test/observability/**`.
- **Required tests.** ALERT-1..8 (injection, each reaching the webhook mock). NFR-10.

## W13-B: Load-test harness

- **Role / size:** build, M.
- **Objective.** Build a harness that seeds 100,000 Free entries and 100,000 Stakes entries per round (Stakes via a fork with pre-funded wallets and a bulk ticket path on a test-only escrow deployment, or log-level synthesis with the reconciliation mocked; document the realism trade-off). It opens 50,000 WebSocket clients from distributed runners (k6 or a Worker-based swarm), times beacon → `revealed` per mode from a cold start, and measures Free entry p95 and `/rounds/today` p95. Run it at reduced scale locally; the full run happens on staging in W14-D.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W12-Z.md`. Spec: "Non-functional requirements" (table and "Scaling notes"), "Architecture" (Decrypt workers row).
- **Owns.** `loadtest/**` (new top-level dir; D adds it to the workspace), `docs/runbooks/load-test.md`.
- **Required tests.** Harness self-tests; a reduced-scale run (e.g. 5,000 entries) passing locally with a report.

## W13-C: Security review

- **Role / size:** build, M.
- **Objective.** Run an internal security review of the whole codebase against the spec's threat model:
  - authz on every route;
  - CSRF (SameSite plus origin checks);
  - OAuth state;
  - session handling;
  - rate limits;
  - input validation;
  - SSRF in RPC/relay fetches;
  - CSP and security headers for the web app and `/s/:shareId`;
  - secret handling and key separation (NFR-7);
  - reveal gating;
  - a storage and log scan over a full e2e run for plaintext picks (PIPE-1 log-scan half, AC-2 storage half, NFR-8);
  - dependency audit;
  - supply-chain pinning.

  Fix small issues in place (owned paths only). Record everything else as findings with severity.
- **Read first.** `plan.md` §2. `docs/sessions/W12-Z.md`. `docs/audit/threat-model.md`. Spec: "Non-functional requirements" (Security, Privacy rows), "Anti-abuse". Load the `security-review` skill.
- **Owns.** `docs/audit/security-review.md`, `e2e/tests/log-scan.spec.ts`, `apps/web/src/security/**` (headers/CSP), `apps/api/src/lib/security-headers.ts`. Other fixes are listed as findings for W15-B unless trivial and inside the paths above.
- **Required tests.** PIPE-1 (log scan), AC-2 (storage scan), NFR-8.

## W13-D: Deploy pipelines + secrets runbook

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C; add `loadtest` to the workspace. Build:
  - wrangler `env.staging` and `env.production` for `apps/api`, `apps/signer` and `apps/web` assets, plus `apps/watcher` (separate account);
  - D1 migration application in deploy;
  - Queues, R2, KV and Vectorize resource creation scripts (idempotent);
  - `.github/workflows/deploy.yml`: staging on `main`, production on manual dispatch with the `production` environment reviewer, with a post-deploy smoke test;
  - Sepolia and mainnet contract deploy scripts (multisig as admin, guardian multisig, roles granted per spec, deployment JSON committed for 84532/8453 after the real deploy);
  - `docs/runbooks/secrets.md` (every secret, env, holder, rotation; `PERSON_ID_KEY` non-rotatable);
  - `docs/runbooks/deploy.md`.
- **Read first.** `plan.md` §2, §3.4, §4.4–4.6. Handoffs W13-A, B, C. Spec: "Architecture" (table), "Non-functional requirements" (Security row).
- **Owns.** Registry files; `.github/workflows/deploy.yml`; `scripts/deploy/**`; `contracts/script/DeployProd.s.sol`; `docs/runbooks/{secrets,deploy}.md`.
- **Required tests.** `wrangler deploy --dry-run` for every Worker and env in CI; a contract deploy script rehearsal on an anvil fork of Base Sepolia and of Base with the multisig as admin (role checks asserted).
- **Emits.** W13-Z prompt.

## W13-Z checklist

- ALERT-1..8, NFR-10, PIPE-1 (all), AC-2, NFR-8 proven.
- Security findings triaged; W15-B gets the list.
- Wave 14 needs OA-04 through OA-19 for staging. List exactly which are missing; if any block W14-A, wave 14 waits on that hold point.
