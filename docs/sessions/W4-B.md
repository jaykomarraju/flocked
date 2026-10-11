# W4-B handoff: Chain indexer

## Status

complete — every escrow and anchor event is mirrored into `chain_events`, reorgs are repaired, handlers are dispatched idempotently, and ALERT-4, ALERT-8 and the foreign-entry path fire.

## Summary

- **`0006_indexer`:**
  - `chain_events` has the nine pinned columns plus `block_timestamp`, `revision` and dispatch bookkeeping. The PK is (chain_id, tx_hash, log_index).
  - New tables: `chain_event_handled`, `sent_txs` and `settlement_holds`.
- **Core (`src/indexer/core.ts`):** per contract, from `deployBlock`:
  - `eth_getLogs` in 2,000-block ranges, halved when a provider rejects a range (rate limits excluded), at most 10,000 blocks per poll;
  - a hash check against `indexer_state`. On a mismatch it rewinds 5 blocks, and further while a stored event's block is no longer canonical;
  - a diff: stored logs missing from the scan become `removed = 1`, and new or returning logs are upserted (`revision` + 1 when removed flips). `indexer_state` is written in the last batch.
  - The end block's hash is read before the logs, so a reorg in between is caught on the next poll.
- **Dispatch (`dispatch.ts`, `registry.ts`, `handlers.ts`):**
  - `chain_events` is the outbox. Each handler sees each revision once, in chain order, and dispatch stops at the first failure.
  - A handler may return D1 statements, which commit in the same batch as its `chain_event_handled` row.
  - `ALERT_DO_ERROR` fires once after 5 failed attempts.
- **Built-in handlers:**
  - ALERT-8 (`policy.ts`): every role-only event whose tx is not in `sent_txs`. Constructor events (a tx to the CREATE2 factory, or a contract creation) are exempt.
  - The foreign `Entered` path (`entered.ts`): stored with `user_id` NULL and `foreign_entry` 1, `ALERT_FOREIGN_EVENT` raised, and a `settlement_holds` row for the round's Stakes mode (`holds.ts`).
- **`sent.ts`:** `recordSentTx(env, {chainId, txHash, kind, roundKey})` and `isSentTx`.
- **IndexerDO:**
  - `poll` joins any poll already running, and never rejects. `status` follows P2.4.
  - Alarms every 3 s from `closesAt` − 5 min while a Stakes mode is `pending` or `revealing`, capped at `closesAt` + 2 h.
  - ALERT-4 fires when lag is over 150 s, whether measured or extrapolated while the RPC fails. It repeats at most every 5 min.
- **Cron:** `src/indexer/cron.ts` exports `indexerKick(env, scheduledTime)` for D to register.

## Branch and head commit

`w4-b-indexer` @ `5f9de29` (code). This handoff is the next commit.

## Files touched

- **New:**
  - `apps/api/migrations/0006_indexer.sql`;
  - `apps/api/src/indexer/{types,config,rpc,decode,core,registry,dispatch,handlers,policy,entered,holds,sent,schedule,cron}.ts`;
  - `apps/api/test/indexer/{helpers.ts,core,reorg,dispatch,alerts,indexer-do}.test.ts`;
  - `e2e/tests/indexer-reorg.test.ts`;
  - `docs/sessions/W4-B.md`.
- **Edited:** `apps/api/src/do/indexer-do.ts` (stub → implementation); `apps/api/test/do.test.ts` and `apps/api/test/migrations.test.ts` (see Deviations).

## Tests run

Node 22.23.1.

| Command | Result |
| --- | --- |
| `pnpm check` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 438, api 473 (427 + 46), forge 199 |
| `pnpm format:check` | pass |
| `pnpm stack:up` + `vitest run tests/indexer-reorg.test.ts` | 3 passed, run twice on the same stack (~1.5 s each) |
| `stack-smoke.test.ts` on the same stack (`0006` applied by `stack:up`) | 6 passed (69 s) |

## Traceability rows covered

- **PIPE-3:**
  - `apps/api/test/indexer/reorg.test.ts` (5 tests: 5-block rewind, re-mined and returning logs, deeper rewind, a provider behind the stored position, log timestamps);
  - `e2e/tests/indexer-reorg.test.ts::PIPE-3: repairs a reorg made with evm_snapshot / evm_revert`.
- **ALERT-4:** `apps/api/test/indexer/indexer-do.test.ts::ALERT-4: indexer lag over 150 s` (catch-up lag with the 5-min repeat; RPC failing). Paging stays with W13-A.
- **ALERT-8:**
  - `apps/api/test/indexer/alerts.test.ts::ALERT-8: events the backend did not send` (5 tests);
  - `e2e/tests/indexer-reorg.test.ts::ALERT-8: an anchor event from a transaction the backend did not record`.
- **Foreign `Entered`:** `alerts.test.ts::foreign entries` (3 tests: ticketed, foreign stored + alerted + held + replay + reorg, unknown chain round).
- **Idempotent dispatch:** `dispatch.test.ts::idempotent dispatch` (7 tests), and the e2e PIPE-3 replay (no handler runs twice).

## Deviations

- `chain_events` has columns beyond the pinned nine (`block_timestamp`, `revision`, `dispatched_revision`, `dispatch_attempts`, `dispatch_error`, `created_at`, `updated_at`). `0006` also adds `chain_event_handled` and `settlement_holds`.
- **Registry shape:** `registerHandler(event, name, fn)`. Names make per-handler idempotency possible. A handler is called as `fn(evt, env, ctx)`, where the third argument `{ rpc }` is optional to use, and may return `D1PreparedStatement[]`. The `'*'` key (`ANY_EVENT`) runs a handler for every event.
- **Edits outside my paths:**
  - `test/do.test.ts`: the IndexerDO block expected "not implemented";
  - `test/migrations.test.ts`: the exact-table check, which now lists `0006`'s tables and PKs.
- **e2e:** the test runs the indexer core in Node over the stack's anvil, with `node:sqlite` in place of D1, not the IndexerDO inside `wrangler dev`. That would need a seam route and the cron registration, both outside my scope.
- Nothing was skipped or weakened. Before the commit I made one test deterministic: "joins a poll that is already running" now calls `poll()` twice inside the object, because two stub calls didn't overlap under full-suite load.

## Spec issues

1. **"Data model":** no rows for `chain_events`, `sent_txs`, `chain_event_handled` or `settlement_holds`. Recommend adding them as built.
2. **"Non-functional requirements" › Alerts:** "any event the backend didn't send" literally includes player events (`Entered`, `Claimed`, ...) and permissionless ones (`finalize`, `refundTooFew`, `refundTimeout`). I alert only on role-only events (`policy.ts`), plus `RoundRefunded` with reason 4 (a void). Recommend the wording "any role-only `FlockedEscrow`/`FlockedAnchor` event the backend didn't send".
3. **"Identity and personhood" › Entry tickets:** the settlement holds "for the guardian", but nothing records the guardian's decision. `settlement_holds.released_at`/`released_by` exist. Recommend an admin action that releases the hold, with an audit-log row (W13 admin, or W6-A).
4. **"Architecture" › Chain indexer fast polling:** "until proposals confirm" has no bound for a stuck round. I capped it at `closesAt` + 2 h, after which the minute cron continues. Free-only rounds don't fast-poll, since they have no proposal. Recommend recording both choices.

## Open issues

- **ALERT-8 race:** `recordSentTx` must run before broadcast (hash = keccak256 of the signed tx; the e2e test does this). Otherwise a fast-mined tx can be indexed first and raise a false alert. W4-A's `onTxSent` should fire before `sendRawTransaction`. Owner: D.
- **Lifecycle handlers:** `OutcomeProposed`, `ProposalVetoed`, `RoundRefunded`, `RoundFinalized` → `round_modes`, and `finalize` at `claimsOpenAt`. Owner: W4-D / W6-A. Ticketed `Entered` → `RoundDO.ingestStakesEntry` (use `resolveEntered`): W4-D (counters), W6-A.
- **Settlement (wave 5):** must call `settlementHold(db, roundId, 'stakes')` before posting.
- **Staging and production:** there are no committed deployments yet, so IndexerDO logs `indexer_unconfigured` on every poll until W14 deploys.
- **ABI events:** a new event (W4-C) must be added to `OPEN_EVENTS` or `ROLE_EVENTS` in `policy.ts`, or `alerts.test.ts` fails, which is deliberate. An unlisted event defaults to role-only.
- Handlers with side effects outside D1 (DO calls, alerts) are at least once if the isolate dies between the effect and its handled row.

## Notes for D and Z

- **Cron:** in `src/cron.ts`, `import { indexerKick } from './indexer/cron.js'` and set `CRON_HANDLERS.indexer_kick = indexerKick`. `test/worker.test.ts` already expects `indexer_kick` on the minute cron.
- **sent_txs:** wire W4-A's `chain/tx.ts` `onTxSent` to `recordSentTx(env, {chainId, txHash, kind, roundKey})`. `kind` is `SentTxKind` (`createRound`, `voidRound`, `propose`, `finalize`, `refundTooFew`, `refundTimeout`, `lock`, `commit`, `manifest`). `roundKey` may be null; it can be called once per key for a batch tx.
- **Lifecycle handlers:** call `registerHandler(event, name, fn)` from a module imported by `src/index.ts`, or by `src/do/indexer-do.ts`, before the first poll; the DO shares the Worker's isolate. Keep names stable, since renaming one re-runs it on pending rows.
- **Env:** `BASE_RPC_URL`, `BASE_RPC_URL_FALLBACK`, `CHAIN_ID` and (locally) `LOCAL_DEPLOYMENT`, all already in `env.ts`, and the stack writes them. No new bindings, vars or `wrangler.jsonc` changes. `src/index.ts` needs nothing beyond the cron.
- **Stack job:** add `pnpm --filter @flocked/e2e exec vitest run tests/indexer-reorg.test.ts` after the smoke test. It uses `evm_snapshot` and `evm_revert` on the shared anvil, so don't run it alongside tests that have transactions in flight.
- **Suggested seam routes:** `POST /__test/indexer/poll` and `GET /__test/indexer/status`, so a later stack test can drive the IndexerDO inside `wrangler dev`.
- **Likely merge conflicts:** `test/do.test.ts` (W4-A will un-stub AnchorDO in the same file) and `test/migrations.test.ts`. Keep both sides.
- **Diffs worth reading:** `core.ts` (`applyRange`, the upsert's revision rule, `forkPoint`) and `dispatch.ts`.
