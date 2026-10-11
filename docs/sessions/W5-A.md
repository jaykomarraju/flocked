# W5-A handoff: Settlement core

## Status

complete — the pipeline runs from the settle message to the apply hook; the required tests pass; no stack test (see Deviations).

## Summary

- The `settle` consumer starts `SettlementDO(roundId, mode)`. Rule-8 keys go to the `refundFree` stub, and an unknown round or key is retried into the DLQ.
- **Prepare.** The DO checks the Free commitment (rule 7 → `refundFree` stub), fetches the beacon from the relays and verifies it for exactly `beaconRound`. It retries every 3 s, then raises `ALERT_BEACON_LATE` once and retries every 60 s. Stakes also waits for the safe-head flag (stub: false). Then the DO moves `pending → revealing` and writes the beacon and the decrypt batches (500 by seq) to R2.
- **Decrypt.** One message per batch on `decrypt-daily` / `decrypt-rooms`. The consumer runs `classify`, writes the batch's results to R2 and reports to `chunkDone`, which counts each chunk once. A stalled chunk is re-sent every 5 min and pages after 3 re-sends.
- **Reduce.** Each batch is reconciled against its reported tally. Then `settle`, `checkInvariant`, the payout tree and the write-once bundle (chunks of 5,000, manifest last, RFC 8785).
- **VOID rate.** Over 2 % and at least 10 VOIDs → a `void_rate` hold row plus `ALERT_VOID_RATE`.
- **Apply.** `applyFree` / `applyStakes` run only while `settlementHold(round, mode)` is null. They are `not_implemented` stubs, so the job ends `failed: not_implemented: applyFree` until W5-D.
- `docs/bundle-format.md` pins the bundle format. Migration `0008` adds the `void_rate` hold reason.

## Branch and head commit

`w5-a-settlement` @ `6c02545` (this handoff is the next commit)

## Files touched

- New: `apps/api/src/settlement/{types,keys,beacon,prepare,decrypt,bundle,reduce,void-rate,safe-head}.ts`, `apps/api/src/settlement/apply/{free,stakes}.ts` (stubs), `apps/api/src/queues/{settle,decrypt}.ts`, `apps/api/migrations/0008_settlement.sql`, `apps/api/test/settlement/{helpers,pipeline,manifest,void,idempotency,alerts,holds}.test.ts` (helpers is `.ts`), `docs/bundle-format.md`.
- Edited: `apps/api/src/do/settlement-do.ts` (stub → implementation); `apps/api/src/queues/index.ts` (the three HANDLERS entries, their imports, and the header comment); `apps/api/test/do.test.ts` (the SettlementDO block); `apps/api/test/migrations.test.ts` (one 0008 test).

## Tests run

| Command                                                  | Result                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm check` (Node 22.23.1)                              | pass: abi 13, settle 66, tlock 176, shared 439, api 573 (was 546), forge 202                 |
| `pnpm format:check`                                      | pass                                                                                         |
| `vitest run test/settlement` (exit code and "Errors")    | 26 passed, exit 0, no Errors summary; none of the workerd "uncaught exception" lines come from settlement code |

## Traceability rows covered

- **PIPE-4:** `apps/api/test/settlement/manifest.test.ts`:
  - "PIPE-4: two runs give byte-identical bundles, including after a retry from another relay";
  - "PIPE-4: every bundle object is RFC 8785 canonical JSON".
- **SET-4 (pipeline):** `apps/api/test/settlement/void.test.ts` :: "SET-4: each VOID kind from real ciphertexts is excluded from the tally and refunded". All 7 reasons come from real quicknet ciphertexts and D1 rows.
- **NFR-6 (settlement part):**
  - `idempotency.test.ts` :: "NFR-6: re-delivered chunk messages are counted once" and "NFR-6: a re-delivered settle message starts one job";
  - write-once: "a re-run leaves every bundle object untouched…" and "an existing object with other bytes is never replaced…".
- **ALERT-1 (detection):**
  - `alerts.test.ts` :: "ALERT-1: an anchored root that is not the tree over D1…";
  - "ALERT-1: a chunk whose output disagrees with its reported tally…";
  - "ALERT-1: a step failing 5 times in a row pages once…";
  - the write-once conflict test above.
- **ALERT-5 (detection):** `holds.test.ts` :: "ALERT-5: more than 2 % VOIDs and at least 10 hold the settlement and alert, until released", plus the two threshold tests.
- **Also covered:**
  - `ALERT_BEACON_LATE` and the 3 s / 60 s cadence (`alerts.test.ts`);
  - the Stakes hold refusing `applyStakes` until it is released, and the safe-head wait (`holds.test.ts`);
  - DoD (`pipeline.test.ts`): "a settle message produces a deterministic bundle in R2 and calls applyFree with a TallyResult".

## Deviations

- **Apply hooks.** They take `(env, result)`; the pin says `applyFree(result)`, but the hook needs D1. I also added `refundFree(env, roundId, 7 | 8)` to `apply/free.ts` as a stub, so W5-D has a place for rules 7 and 8.
- **Holds have no phase.** `SettlementPhase` has no `held`, and `do/types.ts` is pinned and not mine. A held job is phase `applying` with `error: "held:<reason>"`.
- **`test/do.test.ts`.** Its SettlementDO block asserted the stub, so I replaced it with checks of the pinned methods' behaviour (not weakened). `worker.test.ts` is unchanged and green, but its title "stub handlers retry valid messages" is now stale: settle retries because the round is unknown.
- **Test-only DO fields** (as AnchorDO has): `relayFetch`, `manualAlarms`, `chunkSizes` (frozen into the job at start), and `hooks` (`applyFree`, `applyStakes`, `refundFree`, `safeHeadReady`).
- **No stack test.** The stack passes no relay URL to the Worker (`e2e/stack/up.mjs` isn't mine; see Notes). Settlement on the stack therefore fails its beacon step until D adds `DRAND_RELAYS`.
- **The settlement writes D1 in two places:** `round_modes` pending → revealing (spec "Round lifecycle", conditional), and `settlement_holds` (void_rate). It writes no payouts, settlements or entries.

## Spec issues

1. **"Sealed picks" › Invalid entries.** The order of `not_anchored` and `stake_out_of_range` relative to checks 1–5 is unspecified. Built: `not_anchored`, then `stake_out_of_range`, then 1–5. Entries caught by the first two are not decrypted. Recommend writing that order into the spec.
2. **"Settlement output" says chunks of about 5,000; "Architecture" says decrypt chunks of about 500.** Built both: decrypt batches of 500 (private working files) and bundle chunks of 5,000. Recommend a sentence saying they are different things.
3. **"Free chunks also hold … receipts."** Receipt signatures aren't stored anywhere, so a bundle entry carries the receipt's fields (the commitment leaf), not its signature. Recommend "receipt fields" in the spec, or a Data model column if signatures must be published.
4. **Data model `settlement_holds`.** The spec has reason (foreign_entry) and "a hold on a round's Stakes settlement". Built: reason `void_rate` for either mode, with `tx_hash` NULL for it, released the same way (guardian admin action, W11-A). Recommend updating the row and the "Invalid entries" safety net to match.
5. **Refunded payout trees.** A refunded Stakes mode has no payout tree (`payoutRoot` null). A refunded Free mode has a tree over its refund amounts. The Free creator award is not a leaf: it lives in `record.creatorAward`. The spec is silent; recommend as built.
6. **Relays.** The spec names none. Built: `DRAND_RELAYS` (comma-separated), defaulting for quicknet to api.drand.sh, api2, api3 and drand.cloudflare.com.
7. **Traceability.** `ALERT_BEACON_LATE` has no ALERT-n row. Its detection is proven in `alerts.test.ts`.

## Open issues

- **W5-D:**
  - implement `applyFree` (idempotent: it is called again after a restart or a hold release) and `refundFree` (7 and 8, conditional on `pending`);
  - build the voided / refunded Free bundle (Archival);
  - tell the RoundDO about `revealing` if the WebSocket needs it.
- **Rule 7.** The SettlementDO sees it only once the AnchorDO says `skipped` or `failed`. A commit stuck in `sent` keeps the job waiting until rule 8 refunds the mode at +24 h, at which point the job stops (`mode is refunded`).
- **W6-A:**
  - `safeHeadReady` (`settlement/safe-head.ts`) and `closeBlock` in the manifest;
  - Stakes ciphertexts in `entries.ciphertext` (prepare throws without them);
  - `applyStakes`.
- **W8:** room `qualifies` flags and `countQualifyingOnly`. Rooms count every valid entry today.
- **Load test.** The reduce runs in a DO alarm. At 100k entries it reads 200 batches and builds two trees; nobody has measured that.
- A job that ends `failed` stays failed; a new settle message doesn't restart it. That is intended for integrity failures (it pages).

## Notes for D and Z

- **Stack.**
  - In `e2e/stack/up.mjs`, add `DRAND_RELAYS: <the stack's drand HTTP URL>` to `writeDevVars`.
  - Add `DRAND_RELAYS?: string` to `src/env.ts` (the code reads it through `RelayEnv` today).
  - Staging and production need nothing: quicknet uses the default relays.
  - `free-settle.test.ts` needs the relay var. Expect phase `done` once `applyFree` exists.
- **No new bindings:** `BUCKET`, `SETTLEMENT`, `QUEUE_DECRYPT_*`, `DB`, `ANCHOR` and `ANALYTICS` already exist.
- **R2.** Only `bundles/` may be public. `settlement/` holds private working files.
- **`indexer/holds.ts` (W4-F1's file).** `settlementHold` can now return reason `void_rate` with `txHash` null, so widen `HoldReason` and `txHash: Hex | null` when merging.
- **Migration 0008** rebuilds `settlement_holds` with the 0006 columns. If W4-F1's `0007` changes that table, fold the change into 0008.
- **Risky diffs worth reading:**
  - `src/do/settlement-do.ts`: the phase machine and the alarm interleaving with `chunkDone`;
  - `src/settlement/prepare.ts`: the anchored-set and root check.
