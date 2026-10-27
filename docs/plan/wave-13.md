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

## Carry-over from W8-Z (Oct 16, 2026)

- **W13-A:**
  - `question_used` is sent at most once: it goes out after the lock commits, so a crash in between loses it;
  - log prompt-cache usage (`usage.cache_read_input_tokens`; usage isn't logged yet) and check the cache hits in staging;
  - a veto re-mined within one poll raises a noisy `stakes_veto_unexpected` when it is re-added (W7-F1);
  - later items, for W13-A or the first session that touches them: rebase the question score's epoch before about 2035; consider an index on `rounds.question_id` (`GET /questions?status=used` scans for it).
- **W13-B:**
  - a reorged-out Stakes `RoundFinalized` or `RoundRefunded` (W6-F1 R3's undo) doesn't undo applied stats or referral points; re-derive the mode's day;
  - voided modes never call `runModeFinal`, so a voided day is applied when a later day's hook runs (`lifecycle/void.ts`);
  - the `RoundRefunded` handler still calls the RoundDO before its D1 commit (W7-F1 R6's pattern applies);
  - a reorged-out Stakes proposal reaches connected viewers only when they reconnect;
  - measure the hourly room-round insert (it pages through every open room) and the scheduler tick under load.
- **W13-C:** W7-F1 R12's timing: the personhood callback refuses a suspended account only after the Coinbase token exchange; refusing before it needs a change in `personhood/flow.ts`.

## Carry-over from W9-Z (Oct 16, 2026)

- **W13-A:**
  - a failed daily cast is logged (`daily_cast_failed`) and not retried until the round's `open` event re-runs: add an alert code;
  - `notification_log` has no pruning: a cron deletes done rows older than about 30 days;
  - `test/auth/rate-limit.test.ts` › "PATCH /me allows 30 per minute, then 429" failed once in W8-F1 (the token bucket refills on the wall clock): pin its clock.
- **W13-B:**
  - notification fan-out: the outcome producers and the alarm bodies enqueue one message per user, in 100-message batches from one invocation, and `question_live` reaches every reachable non-entrant; at about 50k users page them through chunked jobs;
  - W9-F1's guardian-void sweep is a step of the tick: include it in the tick under load;
  - W8-F1's H1 residual: mirror rounds refused `awaiting_daily` stay first in the room lock batch while their daily round's lock is refused, and past about 18,000 live room rounds a page cycle exceeds the 6 hours before opening.

## Carry-over from W10-Z (Oct 26, 2026)

- **W13-A:** `notification_log.source` has no index, so each tick's void sweep scans the table while a void is in its window (W9-F1): add the index with the pruning migration. `notify_lease_lost` (a batch that ran past its 60 s lease, so a duplicate was sent) is a warn log with no alert. The watcher's page delivery and the paymaster's refusals (W10-F1) have no dashboards yet.
- **W13-B:** benchmark card rendering at 30 and 1,200 players on real infrastructure (W10-A: 150–350 ms a card, a 30-render batch is about 10 s of the 60 s `cpu_ms`; the five-minute target is unmeasured), and the watcher's Stakes recompute at size (W11-B splits it). W10-F1 replaces the void sweep's stateless window with a cursor.
- **W13-C:** review the paymaster proxy as W10-F1 leaves it (smart-wallet checks, the replay key, the rate limit) and the card routes' access (W10-Z found the round card mounted at the site root without `requireRoundAccess`).
- **W13-D:** the watcher's secrets and vars and the paymaster's `PAYMASTER_URL` / `BUNDLER_URL` go in `docs/runbooks/secrets.md` (plan.md 4.5); the watcher deploys from its own wrangler project to the second account (OA-05).
