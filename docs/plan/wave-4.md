# Wave 4: Chain lifecycle

**Goal.** Rounds are created, locked and anchored automatically. The chain indexer mirrors every contract event. The contracts are frozen and packaged for audit. A daily round runs open → closed → committed on the local stack with no manual step (settlement comes in wave 5).

**Base.** Tag `wave-3`. **Migrations reserved:** W4-A `0005`, W4-B `0006`, W4-D `0007`.

## Pinned interfaces

- P2.4 DO signatures for `AnchorDO`, `IndexerDO`, `RoundDO.init`, `RoundDO.ingestStakesEntry`.
- **Indexer → app events:** W4-B writes mirrored rows to a D1 table `chain_events` (migration `0006`: chain_id, contract, block_number, block_hash, tx_hash, log_index, event, args_json, removed) and calls registered handlers through `apps/api/src/indexer/handlers.ts`, a registry of `(eventName) → handler(evt, env)`. Handlers for lifecycle transitions are registered by D (W4-D) and later by W6-A.
- **Operator key access:** `OPERATOR_KEY` (Workers secret) is used only by `apps/api/src/chain/operator.ts` (W4-A creates it; it exposes `createRound`, `voidRound`, `propose`, `finalize`). `ANCHOR_KEY` is used only inside AnchorDO.

## W4-A: Scheduler, question lock, AnchorDO

- **Role / size:** build, M.
- **Objective.** Build the scheduler cron: create daily rounds 48 h ahead, lock at `opensAt` − 6 h (freeze `config_json`, create `round_modes`, Stakes `createRound` via `chain/operator.ts`, Free lock leaves via AnchorDO), and fill gaps with the top house question and an alert. Build AnchorDO: key and nonce, batching by `beaconRound`, per-key deadlines min(close + 90 s, beaconTime − 30 s), checking onchain state before building or retrying, replacing stuck transactions, and recording `anchors` rows.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W3-Z.md`. This section. Spec: "Round lifecycle" (all), "Architecture" (rows AnchorDO, Scheduler), "Smart contract" (only "Contract: `FlockedAnchor`" rules), "Sealed picks (timelock encryption)" (only "Round config check (Stakes)", "Free mode specifics"), "Question pipeline" (only "House questions").
- **Owns.** `apps/api/src/scheduler/**`, `apps/api/src/do/anchor-do.ts`, `apps/api/src/chain/{operator,client,tx}.ts`, migration `0005`, `apps/api/test/{scheduler,anchor-do}/**`.
- **Required tests.** PIPE-2 (per-key deadlines; partial batch with a `Skipped` item; stuck-transaction replacement with an anvil-mined test). ALERT-2 and ALERT-6 (schedule gap) detection. Lock is idempotent and immutable after lock. Stakes `createRound` stores `chain_round_id` from the receipt. Free lock leaf `configHash` matches `freeConfigHash`. DST days produce 23 h/25 h rounds.
- **Risks.** Nonce management under retries; RPC failures mid-batch.

## W4-B: Chain indexer

- **Role / size:** build, M.
- **Objective.** Build the indexer: a cron every minute plus IndexerDO alarm polling every few seconds from `closesAt` − 5 min until proposals confirm. It mirrors every `FlockedEscrow` and `FlockedAnchor` event into `chain_events`, handles reorgs through `indexer_state` (re-index from 5 blocks back on a hash mismatch), and dispatches handlers.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W3-Z.md`. This section. Spec: "Architecture" (row Chain indexer), "Data model" (rows `indexer_state`, `anchors`), "Round lifecycle" (Stakes rows of the table), "Identity and personhood" (only the `Entered`-mapping bullets of "Entry tickets (Stakes)"), "Non-functional requirements" (only "Alerts").
- **Owns.** `apps/api/src/indexer/**` (except handler registrations that D adds), `apps/api/src/do/indexer-do.ts`, migration `0006`, `apps/api/test/indexer/**`.
- **Required tests.** PIPE-3 (reorg replay on anvil with `anvil_reorg` or snapshot/revert). ALERT-4 (lag > 150 s). ALERT-8 (an event whose tx the backend didn't send). B owns the `sent_txs` table (in `0006`) and `recordSentTx(env, {chainId, txHash, kind, roundKey})` in `src/indexer/sent.ts`. W4-A doesn't import it: `chain/tx.ts` exposes an `onTxSent` callback option, and D wires the two together. `Entered` with no matching ticket raises the signer-compromise alert path (log and alert only; the response is manual).
- **Risks.** Log-range limits on RPC providers; idempotent handler dispatch.

## W4-C: Contracts audit prep

- **Role / size:** build, M.
- **Objective.** Harden and freeze both contracts for audit. Run slither and aderyn and triage every finding. Extend the invariant handlers (both contracts). Complete NatSpec. Write the audit package: scope, architecture, roles and timelocks, trust model and residual risks (from the spec), known issues, test instructions, and the commit hash to audit.
- **Read first.** `plan.md` §2. `docs/sessions/W3-Z.md`. `contracts/README.md`. Spec: "Smart contract" (all), "Settlement and payout math" (only "Stakes closed form", "Invariant").
- **Owns.** `contracts/**` (except `deployments/` and `script/`), `docs/audit/**`. Add CI steps for slither/aderyn to the handoff's notes for D.
- **Required tests.** `FOUNDRY_PROFILE=ci forge test`; coverage ≥ 95% lines on both contracts; slither/aderyn reports with no unexplained high or medium.
- **Deliverables.** `docs/audit/package.md`, `docs/audit/threat-model.md`, `docs/audit/static-analysis.md`. Tag `audit-candidate-1` is created by Z at merge, not by C.
- **Risks.** Any contract change needed beyond hardening is raised as a spec issue, not made silently.

## W4-D: Lifecycle wiring

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C. Wire the lifecycle: the scheduler initialises the RoundDO at lock and opens it at `opensAt`; RoundDO close sends the commitment to AnchorDO; indexer handlers move Stakes entries into RoundDO counters (`ingestStakesEntry`) and record `Committed`/`Locked` confirmations on `round_modes`; the two-phase void (RoundDO stops entries, `voidRound` must confirm in a block before `closesAt`, otherwise abandoned); and the guardian void path (reason 4 from an unknown sender → Stakes voided, Free continues).
- **Read first.** `plan.md` §2, §3.4. Handoffs W4-A, B, C. Spec: "Round lifecycle" (all).
- **Owns.** Registry files; `apps/api/src/lifecycle/**`; handler registrations in `apps/api/src/indexer/handlers.ts`; `apps/api/test/lifecycle/**`; `e2e/tests/lifecycle-open-close.test.ts`; CI static-analysis job.
- **Required tests.** SET-1b (rule 4). AC-6 (first half: one lock leaf, one commitment before the beacon, on the local stack). Void before close; void that misses close is abandoned. A local-stack test runs a short daily-shaped round (minutes long, via config) through open → close → commit with no manual call.
- **Emits.** W4-Z prompt.

## W4-Z checklist

- PIPE-2, PIPE-3, SET-1b (4), ALERT-2/4/6/8 detection proven.
- Tag `audit-candidate-1` on the merge commit. Tell the owner the audit package is ready (OA-20): `docs/audit/package.md`.
- Migrations for wave 5: W5-A `0008`, W5-B `0009`, W5-D `0010`.

## Carry-over from W2-Z (Oct 8, 2026)

- **W4-A:** add `UNIQUE (closes_at) WHERE kind = 'daily'` (or equivalent) on `rounds` in `0005`, so overlapping cron runs can't create two daily rounds. Config validation runs `checkTargetRound` on any non-default close or `beaconDelay` (Decision log, Oct 8). Cap the Free `stakeMax` in `packages/shared/src/config.ts` at 2^53 − 1 (it's UINT64 today, but points need safe integers). `anchors.block_timestamp` is Unix seconds. AnchorDO gas per item (W2-B): about 75k `lock`, 55k `commit`, 73k `anchorManifest`.
- **W4-B:** an `Entered` event with no matching ticket is stored with `user_id` NULL and the foreign flag, raises `ALERT_FOREIGN_EVENT`, and holds that round's settlement for the guardian (Decision log, Oct 8; the columns are in `0001`).
- **W4-C (audit prep):** escrow nits from the W2-Z review: `GuardianReplaced` has no `previous` field and admin replacement doesn't emit `GuardianTransferred`; `_setRoleAdmin(GUARDIAN_ROLE, GUARDIAN_ROLE)` is dead. `packages/abi/scripts/gen.mjs`'s source hash leaves out `foundry.toml` and `remappings.txt` (CI's `--check` still catches drift). `anchorManifest` needs a lock but not a commit (now in the spec). Confirm the CREATE2 factory exists on Base Sepolia and Base (also W14-A).

## Carry-over from W3-Z (Oct 9, 2026)

- **All:** the local stack (`pnpm stack:up`, `e2e/stack/README.md`) and the local-only seam (`apps/api/src/local/seam.ts`, `/__test/*`) exist. Add seam routes rather than reaching into D1 from stack tests, and reuse `e2e/stack/env.mjs` (`readState`, `readDevVars`).
- **W4-A** also owns `apps/api/src/routes/entries.ts` and `apps/api/src/rounds/grant.ts` this wave, for two unbuilt spec rules ("Anti-abuse"; owner decision Oct 9):
  - Turnstile on the first Free entry of each game day: `POST /rounds/:id/entries` requires and verifies `turnstileToken` when the user has no Free entry yet that game day (New York date of `closesAt`).
  - Daily-grant anti-farming: grant only if the account is at least 24 h old and has a linked Farcaster identity or a wallet with at least one prior onchain transaction (read through `chain/client.ts`). An ineligible user gets no grant and no `daily_grant_skips` row, so linking later that day still works. Record this reading in the handoff's Spec issues.
- **W4-D** owns `apps/api/src/do/round-do.ts` this wave. Hardening from the W3-Z review:
  - a repeated `init` on an initialised round calls `advance()`, so the scheduler's tick restarts a stalled alarm chain;
  - a failed event backs off instead of retrying every 10 s forever, and `ALERT_DO_ERROR` is throttled per round and event;
  - an identical replay after close returns the stored receipt (look the leaf up before the closed check);
  - the `commitment_root` update checks `changes` and alerts when it's 0;
  - optionally, a user short of points on a sealed round gets `round_closed`, not `insufficient_balance`.
- **W4-D** also builds `requestVoid` (the two-phase void), the receiving side of `onModeResult` (wave 5 calls it), and the `ingestStakesEntry` counter update its indexer handler needs (W6-A builds the rest of Stakes ingestion).
- **W4-D:** make `apps/api/test/round-do/close-race.test.ts`'s in-flight precondition deterministic (hold the D1 commit with a test hook instead of polling ticks). It failed once under heavy local load in W3-Z and passed on every other run.
- **W4-D:** run the open → closed → committed test on the W3-D stack (pin the clock through the seam).
- **W4-D:** if the Stack job breaks after Oct 19 (Ubuntu 26 becomes `ubuntu-latest`), pin `ubuntu-24.04` in `.github/workflows/stack.yml`.
