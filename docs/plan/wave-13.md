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

## Carry-over from W3-Z (Oct 9, 2026)

- **W13-A:** a cron sweep that deletes expired `sessions` rows (W3-A never purges them).
- **W13-C:** review W3-B's sticky tlock self-test: a failure keeps `classify` throwing until the isolate is replaced. Also review the email and session findings that W7-B fixed.

## Carry-over from W4-Z (Oct 11, 2026)

- **W13-A:** route the wave-4 codes:
  - `ALERT_COMMIT_LATE` (ALERT-2);
  - `ALERT_INDEXER_LAG` (ALERT-4);
  - `ALERT_SCHEDULE_GAP`, which now also covers a Free lock leaf that misses closesAt − 30 s (ALERT-6);
  - `ALERT_FOREIGN_EVENT` (ALERT-8: role-only events and reason-4 `RoundRefunded`);
  - `ALERT_DO_ERROR` (dispatch failures, step `void_reorged`, and W4-F1's void alerts).
- **W13-D:** per-environment values for W4-F1's `TxSender` max-fee cap go in the deploy config and `docs/runbooks/secrets.md`.

## Carry-over from W5-Z (Oct 12, 2026)

- **W13-A:**
  - route `ALERT_SETTLEMENT_FAILED` (ALERT-1, including step `points_reconcile` from the nightly reconciliation), `ALERT_VOID_RATE` (ALERT-5) and `ALERT_BEACON_LATE` (ALERT-9, new on Oct 12);
  - indexer throughput: `DISPATCH_LIMIT` is 25 per pass, about 1,500 entries an hour at cron cadence. Re-arming the IndexerDO alarm after `more: true` would give each pass a fresh budget;
  - the per-poll write budget in `apps/api/src/indexer/core.ts` misses a chunk with no logs but many stale rows to remove (unrealistic on Base; bound it anyway);
  - W4-F1's N3 retried-`applyReceipt` path (`anchor-do.ts`, the `confirmed && tx_hash === hash` branch) has no test.
- **W13-B:** load-test the reduce plus `applyFree` at 100k entries; both run in one DO alarm.
- **W13-D:**
  - a retention job deletes the private working files `settlement/{roundId}/{mode}/` once a mode is final, and the D1 ciphertexts of Free modes refunded before the reveal 30 days after the refund (Decision log, Oct 12);
  - `docs/runbooks/secrets.md`: `PERSON_ID_KEY` is at least 32 bytes of hex (`openssl rand -hex 32`) and can never be rotated; `ATTESTATION_RPC_URL` is a Base mainnet RPC in every environment (a secret if it embeds a key);
  - `TX_MAX_FEE_GWEI` per environment (W5-D set `"5"` everywhere in `wrangler.jsonc`).

## Carry-over from W6-Z (Oct 12, 2026)

- **W13-A:** ALERT-3 (safe head not past the close block at beacon + 60 s) and the Stakes reconciliation alerts (ALERT-1) are detected (W6-A); route and page them. A guardian veto of a refund proposal raises `ALERT_DO_ERROR` step `refund_proposal_vetoed`.
- **W13-B (load):**
  - the `RoundFinalized` payouts insert is one `INSERT … SELECT` per round (100k entries in one statement);
  - `/claims` and `/me` rebuild a Stakes payout tree and a Free commitment tree per isolate (an LRU of 8): a cold-start cost per round at 100k entries. Consider caching proofs in R2.
- **W13-C:**
  - claimed foreign entries (no `payouts` row) stay listed by `GET /claims?wallet=` after their claim: accepted as a low risk (owner decision, Oct 12), re-check it;
  - retention: Stakes `entered-*.json` working files in R2 and Stakes ciphertexts in D1 are kept (archival is Free only). Decide their retention with the privacy rules.
- **W13-D (secrets runbook and deploy config):**
  - `PERSON_TAG_KEY` (API secret): rotate only between rounds, since a mid-round rotation gives a person a second tag in that round;
  - `TICKET_SIGNER_KEY` lives in `apps/signer` only (`wrangler secret put TICKET_SIGNER_KEY --env <env>`); the API's service binding `SIGNER` names `flocked-signer-staging` / `flocked-signer`;
  - `BASE_RPC_URL_FALLBACK` is the Stakes reconciliation re-read: set it in staging and production, from a second provider (OA-08).

## Carry-over from W7-Z (Oct 12, 2026)

- **W13-A:** route the new alerts: W7-F1 R16's `OutcomeProposed.payoutRoot` mismatch, and W8-A's house backlog below 14 and game day with no daily round (decision E4).
- **W13-B:**
  - a refund state restored after the SettlementDO is `done` has no driver (W7-Z review);
  - a reorg that drops a mined operator transaction (`propose`, `finalize`, …): its purpose keeps answering from its `mined` row and is never sent again (W6-F1 open issue). W6-F1 R1 and W7-F1 R14 only free the nonce; today the removal's alert is the only signal.
- **W13-C:** WebSocket upgrade abuse limits (W7-A): there is no per-IP limit on upgrades and no cap on sockets per shard yet. Cloudflare allows about 32k sockets per object; 50k viewers over 16 shards is about 3.1k each. Claimed foreign entries are already listed above (W6-Z).
