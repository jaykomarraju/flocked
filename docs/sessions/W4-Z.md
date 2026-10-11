# Wave 4 summary

## Status

Merged to `main` at `5d409a4`, a `--no-ff` merge of `w4-integration` @ `5ff04e1`. The tag `audit-candidate-1` is on that merge commit, and `git diff 36d115c audit-candidate-1 -- contracts/src` is empty. The tag `wave-4` is on `main`'s head: the commit that adds this summary and the wave-5 prompts. Wave-5 worktrees therefore contain them, and `main` equals the tag.

CI on `w4-integration`:

- @ `09a65e4`: CI run 38158983876 (check, contracts, properties, static-analysis) and Stack run 38158983888 passed.
- @ `5ff04e1` (spec and plan): CI run 38167039153 and Stack run 38167039136 passed.
- On `main` @ `5d409a4`: CI run 38168051295 (all four jobs) and Stack run 38168051294 passed.

Local checks on `w4-integration` before the merge, and on `main` after it (Node 22.23.1):

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` | node:test 20, abi 13, settle 66, tlock 176, shared 439, api 546, forge 202 |
| `pnpm format:check` | pass |
| `FOUNDRY_PROFILE=ci forge test` | 202 passed (207 s) |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run` | 4 files, 15 passed (141 s): smoke 6, lifecycle 3, anchor-tx 3, indexer-reorg 3 |

- All four handoffs were `complete`.
- Nothing was skipped or weakened.
- The api run prints two workerd "uncaught exception" lines: a stub's `not_implemented` rejection, and a vitest teardown `EnvironmentTeardownError`. Vitest still exits 0, with no "Errors" summary, so this is pre-existing noise.
- W4-Z worked in W4-D's worktree, which already had `w4-integration` checked out.
- W4-Z made no code changes.

## On main now

- **Scheduler (W4-A, `src/scheduler/`):**
  - daily rounds created 48 h ahead (DST gives 23 h and 25 h rounds);
  - lock at opensAt − 6 h: question, frozen config, `round_modes`, Stakes `createRound`, Free lock leaves, `RoundDO.init`;
  - a gap gets the top house question plus `ALERT_SCHEDULE_GAP`.
- **Chain (W4-A, `src/chain/`):**
  - `TxSender`: replaces a stuck transaction at the same nonce, detects a taken nonce, and calls `onTxSent` before broadcast;
  - `operator.ts`: at-most-once `createRound` / `voidRound` / `propose` / `finalize` in `operator_txs`.
- **AnchorDO (W4-A):**
  - lock, commit and manifest batches with per-key deadlines;
  - onchain state checked before every build;
  - `Skipped` applied from the receipt;
  - `anchors` rows.
- **Anti-abuse (W4-A):** Turnstile on the first Free entry of a game day; the daily-grant points-farming rule.
- **Indexer (W4-B):**
  - `chain_events` mirror with reorg repair (rewind, `removed`, `revision`);
  - idempotent per-handler dispatch;
  - ALERT-4, ALERT-8, and foreign `Entered` → `settlement_holds`;
  - IndexerDO fast polling;
  - `sent_txs`.
- **Contracts (W4-C):**
  - the W2-Z escrow nits fixed, and the pragma pinned to 0.8.30;
  - complete NatSpec;
  - slither and aderyn triaged;
  - stronger invariants, and 100 % coverage;
  - the audit package in `docs/audit/`.
- **Lifecycle (W4-D, `src/lifecycle/`):**
  - the two-phase void;
  - handlers for ticketed `Entered`, `Locked` / `Committed` and reason-4 `RoundRefunded`;
  - RoundDO `ingestStakesEntry`, `onModeResult`, `requestVoid`, and the W3-Z hardening;
  - DO-3 made deterministic.
- **Stack (W4-D):**
  - `e2e/stack/cron.mjs` drives the crons through `POST /__test/cron`;
  - `POST /__test/rounds/scheduled`;
  - four stack test files;
  - a daily-shaped round goes lock → open → close → commit with no manual step.

## Interfaces changed or added

- `apps/api/migrations/0005_scheduler.sql`: `operator_txs`, the daily `closes_at` unique index, and the locked-round immutability trigger. `0006_indexer.sql`: `chain_events`, which has the nine pinned columns plus `block_timestamp`, `revision` and dispatch bookkeeping; `chain_event_handled`, `sent_txs` and `settlement_holds`. `0007` was not used and is now W4-F1's.
- `src/indexer/registry.ts`: `registerHandler(event, name, fn)`. `fn(evt, env, ctx?)` may return D1 statements; `'*'` runs for every event. The pinned shape was `(eventName) → handler(evt, env)`; names make per-handler idempotency possible (accepted as built).
- `src/indexer/sent.ts` `recordSentTx` / `isSentTx`. `src/indexer/holds.ts` `settlementHold`. `src/lifecycle/void.ts` `requestRoundVoid`.
- AnchorDO test-only fields: `transportOverride`, `stuckAfterMs`, `manualAlarms`, `onTxSent`. RoundDO test-only fields: `beforeEntryBatch`, `operatorDeps`. No new RPC methods.
- ABI (W4-C): `GuardianReplaced(previous, newGuardian)`; admin replacement also emits `GuardianTransferred`. The CREATE2 addresses moved (none are committed for 84532 or 8453).
- Seam: `POST /__test/cron`, `POST /__test/rounds/scheduled`; `GET /__test/rounds/:id` adds `lockTx`, `commitTx` and the key's `chain_events`.
- CI: a `static-analysis` job (slither, aderyn, NatSpec), now a required check on `main`. Stack: four steps.

## Decisions

On Oct 11, 2026 the owner took the recommended option on all 18 spec issues. Six Decision log rows are dated Oct 11.

- **Scheduling:**
  - the points-farming reading as built, which also applies to the referral bonus, since the spec's rule was shared;
  - Stakes is voided (and Free goes on) if `createRound` misses `opensAt`;
  - `nonDefaultAuditId` in the locked config (W11-A);
  - house backlog `queued` → `used` at lock;
  - a lock leaf that misses closesAt − 30 s raises `ALERT_SCHEDULE_GAP` (ALERT-6).
- **Indexer:**
  - ALERT-8 covers role-only events, including a reason-4 `RoundRefunded`;
  - the tables are in the Data model as built;
  - the settlement hold is released by a guardian-only admin action with an `audit_log` row;
  - fast polling stops at closesAt + 2 h, and Free-only rounds don't fast-poll.
- **Contracts:** a wrong payout tree with a correct tally added to "Deliberately wrong proposal"; a new "USDC issuer" residual risk (accepted); `getRoleAdmin(GUARDIAN_ROLE)` unchanged.
- **Void:**
  - an unconfirmed void is abandoned at close only on proof: the head is stamped ≥ closesAt, and a definite final attempt follows. This replaces the built 20 s rule (W4-F1);
  - Free rule-4 refunds are written at confirmation;
  - no Stakes ticket while a void is requested;
  - a guardian void notifies players;
  - a reorged void only alerts;
  - the admin void writes `audit_log`.
- **Process:**
  - the review findings go to a fix session, W4-F1, that runs alongside W5-A/B/C after the merge, with W5-D merging it (new last bullet of plan.md 2.6);
  - `static-analysis` is now a required check (OA-03).
- **Spec sections edited:**
  - "Round lifecycle" (guardian-void row, Void, Scheduling);
  - "Settlement and payout math" (Refund rules);
  - "Identity and personhood" (Entry tickets);
  - "Smart contract" (Residual risk);
  - "Architecture" (Chain indexer row);
  - "Data model";
  - "Question pipeline" (House questions);
  - "Anti-abuse" (Points farming);
  - "Non-functional requirements" (Alerts);
  - the Decision log.

## Traceability

- **Closed (✅):** PIPE-2, PIPE-3.
- **Partly proven (🟡):**
  - SET-1b (rule 4; rules 7 and 8 are W5-D, 5 and 6 are W6-A);
  - AC-6 (lock leaf and commitment; the receipt half is W11-B);
  - ALERT-2, ALERT-4, ALERT-6 and ALERT-8: detection is proven, and paging is W13-A.
- CON-7, CON-8, CON-9 and CON-12 also name W4-C's stronger invariants and role tests.
- No row due this wave is still open.

## Carry-over

The details are in each later wave file's "Carry-over from W4-Z" section, and in `wave-4.md` "W4-F1".

- **W4-F1** (alongside W5-A/B/C): the findings of three adversarial reviews (W4-A, W4-B, W4-D code).
  - High: V1, a void abandoned without proof that it missed close.
  - Medium:
    - T1: a rebroadcast skips `onTxSent`;
    - T2: fees compound with no cap;
    - T3: a false `nonce_consumed` → a second `createRound`;
    - I1 and I2: reorg dispatch order and in-place event changes;
    - I3: the ALERT-8 constructor-exemption bypass;
    - I4: deep reorgs;
    - I5: `maxRange` never regrows;
    - V2: a void that can't confirm blocks entries silently.
  - Low: about ten more.
- **Wave 5:**
  - W5-A checks `settlementHold` before the Stakes apply hook;
  - W5-D merges W4-F1 and calls `onModeResult`;
  - W5-D decides how a voided Free mode writes its bundle (spec "Archival");
  - stack tests reuse `POST /__test/rounds/scheduled` and the cron driver.
- **W6-A:**
  - the rest of Stakes ingestion, including un-counting a reorged `Entered`;
  - proposal, veto, refund and finalize handlers;
  - a serialised operator nonce.

  **W6-B:** no ticket while `voidRequested`. **W6-D:** `recordPriorTransactions` before the first-visit grant.
- **W8-B:** the referral bonus uses the same farming rule. **W8-D:** room questions (the scheduler refuses room rounds without one).
- **W9-A:** void and refund notifications. **W9-C:** send `turnstileToken`.
- **W11-A:** the admin void route with an `audit_log` row, the hold release and `nonDefaultAuditId`. W12-C builds their UI. The prompt said W12, but the admin API is W11-A's.
- **W13-A:** route the wave-4 alert codes. **W13-D:** per-environment fee-cap values.
- **W14-A:** re-confirm the CREATE2 factory, commit deployments (to end `indexer_unconfigured`), and handle orphan `anchors` rows.

## Owner actions

- **OA-20 (Gate 3, report needed by W15): the audit package is ready.**
  - Send the auditor `docs/audit/package.md`, with `docs/audit/threat-model.md` and `docs/audit/static-analysis.md`, and the tag `audit-candidate-1` (`contracts/src` as of `36d115c`).
  - The auditor is not booked yet (owner, Oct 11). Booking is now the critical path for W15.
- **OA-03:** done. `static-analysis` is required on `main`.
- **OA-D2 (needed by W9):** review the core flow in Paper (37 states × 3 breakpoints).
- **OA-21 (in progress):** ToS and privacy text by W12.
- **OA-D3:** review Social and Settings in Paper after W5-C (needed by W11). **OA-D4:** share cards and notifications after W6-C (needed by W10).
- **OA-04 (start by W10, needed by W13):** Workers Paid and the deploy token.
- Nothing else is due in waves 5–6.

## Next wave

- Prompts:
  - `docs/prompts/W5-A.md` (settlement core), `W5-B.md` (personhood), `W5-C.md` (design: profiles, boards, rooms, settings, verify) and `W4-F1.md` (wave-4 review fixes) run in parallel;
  - `docs/prompts/W5-D.md` (Free settlement apply) starts after all four report complete.
- Changes from the wave file:
  - W4-F1 joins the wave as a fourth parallel branch, which W5-D merges, and owns the chain, scheduler, indexer and lifecycle paths, so W5-A/B/C don't touch them;
  - W5-B also owns the `findAccount` fix in `auth/accounts.ts`;
  - migrations: W4-F1 `0007`, W5-A `0008`, W5-B `0009`, W5-D `0010`.
