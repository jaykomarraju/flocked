# W4-D handoff: Lifecycle wiring

## Status

complete. A, B and C are merged onto `w4-integration`, and a daily-shaped round runs lock → open → close → commit on the local stack with no manual step. Size: well over M (about 450k tokens in all, much of it reading the A, B and W3 code it wires together). Not split.

## Summary

- **Merge.** `w4-a-scheduler`, `w4-b-indexer` and `w4-c-audit-prep` merged with `--no-ff` with no textual conflicts. Every "Notes for D" is applied:
  - the scheduler, indexer-kick and hourly create jobs in `src/cron.ts`;
  - `onTxSent` → `recordSentTx` for the AnchorDO (its constructor) and the operator (`SCHEDULER_JOBS`, the RoundDO's void), through `src/lifecycle/sent.ts`;
  - C's `static-analysis` CI job;
  - A's and B's stack tests as their own steps in `stack.yml`.
- **Lifecycle (`src/lifecycle/`):**
  - `void.ts`: the two-phase void. `RoundDO.requestVoid` stops entries at once, then the RoundDO's alarm pushes `voidRound` (at most once per round) every 3 s. Mined means confirmed before close, since FlockedEscrow refuses it from closesAt on. `applyVoid` then seals the round, refunds every Free stake (`void_refund`) and voids every live mode with reason 4. A void still unconfirmed at close is abandoned once the chain head is stamped at or after closesAt, or 20 s after closesAt, and the round closes normally. A Free-only round confirms at once.
  - `handlers.ts`, registered on the default registry in `indexer/handlers.ts`:
    - ticketed `Entered` → `ingestStakesEntry`;
    - `Locked` / `Committed` → `round_modes.lock_tx` / `commit_tx`. A root mismatch alerts, and a reorged write is cleared so it is sent again;
    - `RoundRefunded` reason 4 → Stakes `voided`. From a transaction the backend didn't send, it is a guardian void: the RoundDO is told through `onModeResult`, and Free continues.
- **RoundDO:**
  - `ingestStakesEntry`: counters, idempotent by (txHash, logIndex);
  - `onModeResult` (receiving side): mirrors the mode status and broadcasts `revealed` / `refunded`;
  - `requestVoid`;
  - the W3-Z hardening.
- **Stack:** `e2e/stack/cron.mjs` runs the Worker's crons through a new seam route, since `wrangler dev` fires none. New seam routes:
  - `POST /__test/cron`;
  - `POST /__test/rounds/scheduled`: an unlocked round for the real scheduler;
  - `GET /__test/rounds/:id` now also returns `lockTx`, `commitTx` and the key's `chain_events`.

## Branch and head commit

`w4-integration` @ `4d4f69b` (code). This handoff and the W4-Z prompt are the next commits.

## Files touched

- **New:**
  - `apps/api/src/lifecycle/{sent,void,handlers}.ts`;
  - `apps/api/test/lifecycle/{helpers.ts,void,handlers,free-anchor,wiring}.test.ts` (`helpers` has no `.test`);
  - `apps/api/test/round-do/hardening.test.ts`;
  - `e2e/stack/cron.mjs`, `e2e/tests/lifecycle-open-close.test.ts`.
- **Edited (owned):**
  - `apps/api/src/do/round-do.ts`, `src/cron.ts`, `src/indexer/handlers.ts`, `src/local/seam.ts`;
  - `.github/workflows/{ci,stack}.yml`;
  - `e2e/stack/{up,status}.mjs`, `e2e/stack/README.md`;
  - `apps/api/test/round-do/close-race.test.ts`.
- **Integration edits in A, B and W3 files** (see Deviations):
  - `apps/api/src/do/anchor-do.ts` and `src/scheduler/index.ts` (the `onTxSent` wiring);
  - `apps/api/test/anchor-do/fake-chain.ts`;
  - `apps/api/test/{do,worker,local-seam}.test.ts`;
  - `e2e/vitest.config.ts`, and `e2e/tests/anchor-tx.test.ts` (header comment only).

## Tests run

Node 22.23.1.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 439, api 546 (519 after the merge), forge 202 |
| `pnpm format:check` | pass |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | 202 passed (255 s) |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run` | 4 files, 15 passed (~2.5 min): smoke 6, lifecycle 3, anchor-tx 3, indexer-reorg 3. Each also passed on its own |
| `test/round-do/close-race.test.ts` × 5 | 5 of 5 passed with the hold |
| CI and Stack on `w4-integration` @ `4d4f69b` | CI run 38158176970 passed (check, contracts, properties, static-analysis); Stack run 38158176935 passed (smoke, lifecycle, anchor-tx, indexer-reorg steps) |

## Traceability rows covered

- **SET-1b (rule 4):** `test/lifecycle/void.test.ts` :: "voids every mode with reason 4 once voidRound is mined before closesAt, refunding Free" and "a Free-only round confirms the void at once"; `test/lifecycle/handlers.test.ts` :: "a reason-4 RoundRefunded the backend did not send voids Stakes only".
- **AC-6 (first half):** `test/lifecycle/free-anchor.test.ts` :: "runs two daily rounds lock → open → close → commit with no manual step" (fake chain, including an empty day 2 with a lock leaf and no commitment); `e2e/tests/lifecycle-open-close.test.ts` (anvil, 3 tests).
- **Void before close; void that misses close is abandoned:** `void.test.ts` :: "voidRound unmined until the chain passes closesAt: the round closes normally", "gives up 20 s after closesAt even if the chain head never passes it", "a requestVoid answers false once the void was abandoned", "is refused once closesAt has passed".
- **Guardian void stops Stakes only:** `handlers.test.ts` (4 tests, including our own `voidRound` and a reorged void).
- **RoundDO hardening:** `test/round-do/hardening.test.ts` (6 tests), and DO-3 now deterministic in `close-race.test.ts`.
- **ALERT-8 on the stack:** the indexer now runs inside `wrangler dev` (cron driver). Only Node-signed test transactions alerted. `sent_txs` held every AnchorDO transaction, checked against the persisted D1.

## Deviations

- **Cron on the stack:** run through `POST /__test/cron` (seam, local and keyed only) instead of `wrangler dev --test-scheduled`. That flag's `/__scheduled` route would need `run_worker_first` in `wrangler.jsonc` for every environment. The driver calls the same `runCron` as `scheduled`.
- **Alert field `event` → `step`** in RoundDO alerts (W3 code too): `formatLog` drops a field named `event`.
- **Edits outside my list, none weakening a test:**
  - `do.test.ts`: the pinned-stub test now expects `not_found` from an uninitialised round (the methods exist now);
  - `worker.test.ts`: the cron test checks that no configured cron is `cron_unknown`, instead of no warning at all. The real indexer now warns `indexer_unconfigured` in that env;
  - `local-seam.test.ts`: the new fields, plus 2 tests for the new routes;
  - `fake-chain.ts`: FlockedEscrow `voidRound` (reverts at or after closesAt, `RoundRefunded` reason 4);
  - `e2e/vitest.config.ts`: `fileParallelism: false`, since the stack files share anvil and keys;
  - the `anchor-tx.test.ts` header comment ("wrangler dev runs no crons" is no longer true).
- **Test-only RoundDO fields:** `beforeEntryBatch` (the DO-3 hold) and `operatorDeps` (fake RPC for `voidRound`). They are instance fields, not RPC methods.
- No `0007` migration (nothing needed). Ubuntu pin not applied: it is before Oct 19, and the Stack job runs on `ubuntu-latest` (C's new job is on `ubuntu-24.04`).

## Spec issues

1. **"Round lifecycle" › Void: when an unconfirmed void counts as abandoned.** Built: entries stay stopped from the request to close. At close the void is abandoned once the chain head is stamped at or after closesAt, or 20 s past it (anvil mines no empty blocks; Base stamps at about wall time). Recommend writing that.
2. **"Settlement and payout math" › rule 4 for Free:** the refunds are written when the void is confirmed (`void_refund`, once per user and round), not by the settle consumer. Recommend stating it.
3. **"Round lifecycle" › the guardian-void row says "notify":** there is no outcome notification kind yet (W9-A). Ticket issuance (W6) must refuse while Stakes `round_modes.status` isn't `pending`. Recommend naming both owners.
4. **A reorged-out void** (`RoundRefunded` removed) only alerts (`ALERT_DO_ERROR`, step `void_reorged`). Recommend a line under Residual risk.
5. **"Data model":** the admin void's state lives in the RoundDO. The admin route (W12) must write an `audit_log` row when it calls `requestRoundVoid`. Recommend noting it there.

## Open issues

- **W6-A:**
  - a reorged `Entered` is not un-counted (`StakesEntryEvent` has no `removed`; the handler logs `stakes_entry_removed`);
  - the rest of Stakes ingestion;
  - `OutcomeProposed`, `ProposalVetoed`, other `RoundRefunded` reasons, `RoundFinalized` and `finalize`.
- **Wave 5:** calls `RoundDO.onModeResult`, which updates only the DO and the broadcast; D1 stays the settlement's to write.
- **W9-A:** void and refund notifications. **W12:** the admin void route.
- **Operator nonce (A's open issue):** `voidRound` from a RoundDO alarm shares the key with the scheduler's `createRound`. `operator.ts` recovers from a taken nonce.
- **Abandoned voids:** an abandoned `voidRound` stays `pending` in `operator_txs`; if it is ever mined it reverts.
- **Stack tests:** `anchor-tx` and `indexer-reorg` sign with the same anchor key as the AnchorDO. Run them when no stack round is about to lock or close (the Stack job's step order guarantees it).

## Notes for Z

- **Worth reading:**
  - `round-do.ts`: `runVoid`, `resolveVoidAtClose`, `applyVoid`, `adoptVoidedModes`, `eventFailed`;
  - `lifecycle/void.ts`;
  - `lifecycle/handlers.ts` (`freeRoundOfKey`, which maps a round key through the lock's `closesAt`).
- **Re-init:** the scheduler now re-inits every live round each tick, and init runs `advance()`. A later init without a mode the DO knows (D1 voided it) is adopted, not a conflict.
- **Stack:** `pnpm stack:status` gains a `cron` row. The stack now logs `ALERT_SCHEDULE_GAP` for the real daily round (no house questions), and `ALERT_FOREIGN_EVENT` for the Node-signed test transactions.
- **Audit:** `git diff 36d115c HEAD -- contracts/src` is empty (no contract changes).
