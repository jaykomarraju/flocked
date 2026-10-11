# W4-A handoff: Scheduler, question lock, AnchorDO

## Status

complete. Every task and required test is done, and `pnpm check`, `format:check` and both stack tests pass. Size: well over M (about 420k tokens in all, much of it spent reading the code it builds on). Not split.

## Summary

- **Scheduler** (`src/scheduler/`):
  - `createRoundsAhead` creates the daily rounds 48 h ahead, one per close time (DST days give 23 h and 25 h rounds).
  - `schedulerTick` (every minute) catches a missing round and locks rounds at opensAt − 6 h. Lock picks the question (a gap gets the top house question plus ALERT_SCHEDULE_GAP), freezes `config_json` after `checkTargetRound`, and creates `round_modes`, all in one batch.
  - It then runs Stakes `createRound` (storing `chain_round_id` from the receipt), queues the Free lock leaves with the AnchorDO, and calls `RoundDO.init`.
- **`src/chain/`**:
  - `client.ts`: the viem client with RPC fallback, the deployment addresses, and `hasPriorTransaction`.
  - `tx.ts`: `TxSender`, which signs, calls `onTxSent`, broadcasts and checks transactions. It replaces a stuck one at the same nonce with fees at least 25 % higher, and spots a nonce someone else used.
  - `operator.ts`: at-most-once `createRound`, `voidRound`, `propose` and `finalize`, tracked in `operator_txs`. A call that would revert is refused before anything is signed.
- **AnchorDO**:
  - Queues lock, commit and manifest items and does the chain work on its alarm, with one transaction in flight at a time.
  - Batch order: commits first (earliest deadline, grouped by `beaconRound`, the daily one alone), then locks, then one manifest.
  - Before every build it reads each key's onchain state. It applies `Locked`, `Committed` and `Skipped` from the receipt, writes `anchors` rows (a replacement gets its own row, `block_timestamp` in seconds) and sets `round_modes.lock_tx` / `commit_tx`.
- **Anti-abuse**:
  - The first Free entry of a New York game day needs a Turnstile token.
  - The daily grant needs an account at least 24 h old with Farcaster linked, or a wallet with onchain history.
- **Config**: the Free `stakeMax` is capped at 2^53 − 1.

## Branch and head commit

`w4-a-scheduler` @ `081e50b` (code). This handoff is the next commit.

## Files touched

- New:
  - `apps/api/migrations/0005_scheduler.sql`;
  - `apps/api/src/chain/{client,tx,operator}.ts`;
  - `apps/api/src/scheduler/{create,lock,tick,index}.ts`;
  - tests: `apps/api/test/anchor-do/{fake-chain,helpers,anchor-do.test}.ts`, `apps/api/test/scheduler/{helpers,create,lock,tick,operator}.test.ts` (`helpers` has no `.test`), `apps/api/test/anti-abuse/{grant,turnstile}.test.ts`;
  - `e2e/tests/anchor-tx.test.ts`.
- Edited (owned): `apps/api/src/do/anchor-do.ts` (the stub is replaced), `apps/api/src/routes/entries.ts`, `apps/api/src/rounds/grant.ts`, `packages/shared/src/config.ts` and `packages/shared/test/config.test.ts`.
- Edited outside the list, minimally, because my changes broke them (see Deviations): `apps/api/test/{do,migrations}.test.ts`, `apps/api/test/round-do/{entries,route,alarms}.test.ts`, `e2e/tests/stack-smoke.test.ts`.

## Tests run

| Command                                                                                         | Result                                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm check` (Node 22.23.1)                                                                     | pass: node:test 20, abi 13, settle 66, tlock 176, shared 439, api 473 (was 427), forge 199     |
| `pnpm format:check`                                                                             | pass                                                                                           |
| `pnpm stack:up` + `vitest run tests/anchor-tx.test.ts`                                          | 3 passed                                                                                       |
| `vitest run tests/stack-smoke.test.ts` (same stack)                                             | 6 passed                                                                                       |
| `test/round-do/close-race.test.ts`                                                              | failed once in the first full run and once in 7 runs alone; the known DO-3 timing flake (W4-D) |

## Traceability rows covered

- **PIPE-2**:
  - `test/anchor-do/anchor-do.test.ts` :: "each key's deadline is min(closesAt + 90 s, beaconTime − 30 s)", "a partial batch: the contract skips one item with Skipped and the rest still apply", "replaces a stuck transaction at the same nonce with higher fees, folding in new items", "a nonce taken by another transaction …", "a broadcast lost mid-batch is rebroadcast …", "an RPC failure while building …", "checks onchain state first …";
  - `e2e/tests/anchor-tx.test.ts` :: "a stuck transaction is replaced at the same nonce with higher fees; only the replacement is mined", "a mined lock batch and commit batch: written keys emit events, invalid ones Skipped".
- **ALERT-2** (detection): `anchor-do.test.ts` :: "a commit handed over after its deadline fails at once and alerts ALERT_COMMIT_LATE", "a queued commit whose deadline passes before it is sent …", "a commit sent but unconfirmed at its deadline alerts once …", "a commit for a key that was never locked …".
- **ALERT-6** (the schedule-gap half):
  - `test/scheduler/lock.test.ts` :: "fills a gap with the top house question and raises ALERT_SCHEDULE_GAP (ALERT-6)", "with no house question left it refuses, alerting at most once an hour";
  - `test/scheduler/tick.test.ts` :: "a daily round missing when it is due is a schedule gap: alert, then create it (ALERT-6)".
- **Other required tests**:
  - lock is idempotent and immutable: `lock.test.ts` :: "is idempotent and the locked round is immutable";
  - `chain_round_id` from the receipt: `tick.test.ts` :: "Stakes: createRound at lock stores chain_round_id from the receipt, once", plus e2e "createRound's receipt carries the escrow round ID";
  - the lock leaf's `configHash` equals `freeConfigHash`: `tick.test.ts` :: "locks a Free round at opensAt − 6 h …" and `lock.test.ts` :: "commits closesAt, beaconRound, the question hash and configHash = freeConfigHash(config)";
  - DST: `test/scheduler/create.test.ts` :: "DST days: …";
  - Turnstile: `test/anti-abuse/turnstile.test.ts`;
  - grant rule: `test/anti-abuse/grant.test.ts`.

## Deviations

- **Tests outside my list.** I changed only fixtures and expectations my change invalidated; nothing was weakened or skipped:
  - `round-do/entries.test.ts`: the daily-grant users get a Farcaster identity, and each daily round closes 1 s earlier because of the new unique index;
  - `round-do/route.test.ts` and `stack-smoke.test.ts`: send a Turnstile token (the route test passes a stub siteverify);
  - `round-do/alarms.test.ts`: the real AnchorDO now answers `queued`, not `not_implemented`;
  - `do.test.ts`: the AnchorDO block checks the pinned RPC shapes instead of the stub;
  - `migrations.test.ts`: lists `operator_txs`.
- **New storage.** The `operator_txs` table, which the spec's data model doesn't have yet. Wallet history is stored on the wallet identity as `identities.data_json.priorTxAt`.
- **My own choices:**
  - the lock deadline is closesAt − 30 s, and a lock failure raises ALERT_SCHEDULE_GAP (there is no lock-specific alert code);
  - Stakes that can't be created before `opensAt` gets its mode voided, and Free goes on;
  - at its deadline the AnchorDO stops new sends; a commit already sent is still tracked and replaced until beacon time.
- **Test-only AnchorDO fields:** `transportOverride`, `stuckAfterMs`, `manualAlarms` and `onTxSent`. They are instance fields, so they are not RPC methods.

## Spec issues

1. **"Anti-abuse" › Points farming (the reading asked for).**
   - The rule needs a verified Farcaster identity, or a verified wallet with a nonce > 0 or deployed code (a smart wallet) on the deployment chain.
   - It is read over RPC before the grant and stored once it's true. A failed RPC call counts as not eligible for now.
   - An ineligible user gets neither a grant nor a `daily_grant_skips` row.
   - Recommend writing exactly that.
2. **"Round lifecycle" › Scheduling: a non-default close needs an audit-log ID in the published locked config.** `LockedConfigSchema` has no field for it. Recommend adding `nonDefaultAuditId` when admin tooling lands (W12). The scheduler only creates default closes.
3. **"Question pipeline" › House questions: the spec doesn't say which status the backlog uses.** I use `queued` for the backlog (`author_user_id` NULL, highest score first) and mark the question `used` at lock. Recommend stating this.
4. **No alert covers a Free lock leaf that never lands.** Rule 7 follows. Recommend an alert row (I raise ALERT_SCHEDULE_GAP).
5. **"Data model": add `operator_txs`.** Recommend a row for it, or folding it into W4-B's sent-transaction record if theirs stores the signed transaction.
6. **"Round lifecycle": `createRound` must confirm before `opensAt` (the contract refuses later).** The spec doesn't say what happens otherwise. Recommend "Stakes is voided for that round and Free continues".

## Open issues

- **Operator nonce (W4-D / W6-A).** Operator calls with different purposes share the nonce: createRound from the cron, `voidRound` from W4-D, `finalize` from the indexer. `operator.ts` recovers (re-signs on a taken nonce), but a serialising DO would be cleaner.
- **Fee cap (W13 / W14).** `TxSender` has no maximum fee; add an env cap before mainnet.
- **Not built (later wave):** the "daily official cast" from the Scheduler row of "Architecture". Room rounds without a question are refused at lock; W8 defines room questions and config.
- **Orphan `anchors` rows.** A crash between the `anchors` insert and the DO's pending write leaves a row that was never broadcast (`block_timestamp` NULL).
- **Seam rounds have no lock leaf.** On the stack their commit fails `not_locked` (with ALERT_COMMIT_LATE in the log). W4-D's open → closed → committed test must lock through `lockRound` plus `submitLock`, for example with a new seam route.

## Notes for D and Z

- **Cron (`src/cron.ts`).** Set `CRON_HANDLERS.scheduler_tick = SCHEDULER_JOBS.scheduler_tick` and `create_rounds_ahead = SCHEDULER_JOBS.create_rounds_ahead`, both from `src/scheduler/index.ts`. The crons are already in `wrangler.jsonc`, and `src/index.ts` needs no change.
- **`onTxSent` → `recordSentTx` (W4-B):**
  - in AnchorDO's constructor, `this.onTxSent = (e) => recordSentTx(env, e)`;
  - for the operator, pass `{ operator: { onTxSent } }` into `schedulerTick` from `SCHEDULER_JOBS`, and into any other `operator.ts` call.
- **Secrets.** `ANCHOR_KEY`, `OPERATOR_KEY` and `BASE_RPC_URL` (and `_FALLBACK`) are already typed in `env.ts`, and `e2e/stack/up.mjs` already writes them to `e2e/stack/.dev.vars`. Staging and production need `wrangler secret put` from the owner. No new vars.
- **Stack job.** Add `pnpm --filter @flocked/e2e exec vitest run tests/anchor-tx.test.ts` as its own step after the smoke test. It turns anvil's automine off for a moment, so it must not run in parallel with other stack tests.
- **Turnstile on Free entries.** The web client (W9) must send `turnstileToken` on the first Free entry of each day. W6-D's first-visit grant must call `recordPriorTransactions` before `applyDailyGrant`.
- **Merge.**
  - W4-B also adds `chain_events` to `migrations.test.ts`: a trivial conflict.
  - W4-D owns `round-do.ts`. My test edits are in `round-do/{entries,route,alarms}.test.ts`.
  - The new `rounds_locked_immutable` trigger rejects any change to a locked round's question, times, beacon round or config. Status changes are still allowed.
- **Worth reading:** `AnchorDO.process` / `applyReceipt` / `checkOnchain`, `operator.ts` `runOperatorTx`, and the SQL in `grant.ts`.
