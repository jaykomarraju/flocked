# W5-D handoff: Free settlement apply

## Status

complete — wave 5 and W4-F1 merged; a 50-entry Free round settles, anchors its bundle and pays out on the local stack; checks, CI and Stack green.

## Summary

- **Merge.** `w5-integration` from `main` (`dfd3cb3`), `--no-ff` merges of W4-F1, W5-A, W5-B and W5-C. All four handoffs were `complete`. There were no conflicts; git merged `migrations.test.ts` on its own.
- **`applyFree`** (`settlement/apply/free.ts`):
  - inserts the settlement record once; its `settled_at` is the time on every later row;
  - writes each entry's option, `valid` and `void_reason`;
  - writes payouts and ledger credits in chunked D1 batches (500 rows per statement, 4 per batch). A balance moves only by the ledger rows that attempt inserted (fresh IDs, `ON CONFLICT DO NOTHING`), so the ledger's unique key stops double credit;
  - writes the creator award and records burned dust;
  - moves `revealing` → `settled`/`refunded` (rules 1–3) conditionally, then calls `RoundDO.onModeResult` and `AnchorDO.submitManifest`, then archives ciphertexts per bundle chunk once R2 holds the manifest bytes and the chunk.
- **`refundFree`** (rules 7, 8): a conditional `pending` → `refunded` update comes first; then `refund` payouts and ledger rows, then the RoundDO result.
- **AnchorDO.** A confirmed Free manifest sets `settlements.tx_hash`.
- **`jobs/reconcile.ts`:** a paged balances-vs-ledger check on the nightly cron. It raises `ALERT_SETTLEMENT_FAILED` (`step: points_reconcile`).
- **Registry:**
  - `env.ts`: `DRAND_RELAYS`, `TX_MAX_FEE_GWEI` (`"5"` in every env in `wrangler.jsonc`), `ATTESTATION_*`, `COINBASE_*_ORIGIN`;
  - the stack starts the Coinbase and EAS mocks and writes the personhood and relay vars;
  - `free-settle` is its own Stack step.

## Branch and head commit

`w5-integration` @ `6957500` (this handoff and the W5-Z prompt are the next commits)

## Files touched

- **New:**
  - `apps/api/src/jobs/reconcile.ts`;
  - `apps/api/test/settlement/free-{apply,refund,reconcile}.test.ts`;
  - `e2e/tests/free-settle.test.ts`;
  - this file and `docs/prompts/W5-Z.md`.
- **Edited:**
  - `apps/api/src/settlement/apply/free.ts` (stub → implementation), `src/{env,cron}.ts`, `wrangler.jsonc`;
  - `.github/workflows/stack.yml`, `e2e/stack/{up,env,status}.mjs`, `e2e/stack/README.md`;
  - integration edits (see Deviations): `src/do/{anchor-do,settlement-do}.ts`, `src/chain/tx.ts` (comment), `src/personhood/config.ts`, `src/local/seam.ts`, `test/settlement/{helpers,pipeline}.ts`, `test/worker.test.ts`.

## Tests run

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` (Node 22.23.1) | pass: abi 13, settle 66, tlock 176, shared 439, api 678 (was 659 after the merge), forge 202 |
| `pnpm format:check` | pass |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | 202 passed |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run` | 5 files, 19 passed (318 s); `free-settle` alone 3 passed (177 s) |
| CI on `6957500` | run 38176397885: check, contracts, properties, static-analysis all success |
| Stack on `6957500` | run 38176397674 success (5 steps) |
| Mutation checks | dropping the `pending` guard, the `revealing` guard, or the inserted-rows-only credit each fails its tests |

## Traceability rows covered

- **SET-1b (rules 7, 8):** `apps/api/test/settlement/free-refund.test.ts`:
  - "SET-1b rule 7: the SettlementDO refunds the pending mode once the AnchorDO gave up";
  - "SET-1b rule 7: applies only while the mode is pending";
  - "SET-1b rule 8: the rule-8 job refunds a pending mode once, however often it is delivered";
  - "SET-1b rule 8: is a conditional update; a mode that revealed is not refunded";
  - "SET-1b rule 8: a failure after the update is retried without refunding twice".
- **NFR-6 (apply):** `apps/api/test/settlement/free-apply.test.ts`:
  - "NFR-6: re-running apply yields identical rows and no extra ledger rows";
  - "NFR-6: a step failing after the ledger is written is retried by the DO without crediting twice".
- **Rules 1–3 (Free):** `free-apply.test.ts` "rule 2 (one-sided) …", "rule 3 (headcount tie) …", "rule 1: a mode with no entries …".
- **Rule 4 not refunded twice:** `free-apply.test.ts` "is refunded once, at void confirmation: …".
- **DoD (stack):** `e2e/tests/free-settle.test.ts`, "settles after the beacon: the bundle in R2, anchored onchain, the ledger applied".

## Deviations

- **Signatures.** `applyFree(env, result, deps?)` and `refundFree(env, roundId, reason, deps?)`. The optional `deps` (`FreeApplyDeps`) replaces the RoundDO and AnchorDO calls in tests.
- **No migration 0010.** No schema change was needed.
  - `settlements.tally_json` is the API's `TallySchema`.
  - `winners_json` holds `{winner, refundReason, voidCount, voidStake, total, creatorAward, awardRecipient}`.
- **Edits outside the list, all small:**
  - `anchor-do.ts` `writeConfirmations` also writes the manifest's `settlements.tx_hash`;
  - `settlement-do.ts`: a `RelayEnv` cast that lint flagged once `Env` had `DRAND_RELAYS`;
  - `personhood/config.ts`: `PersonhoodEnv = Env`;
  - `local/seam.ts` (additive): `GET /__test/rounds/:id` adds settlement fields; new `GET /__test/bundles/:id/:mode/:file`.
- **Changed tests:**
  - `pipeline.test.ts` asserted the stub; it now asserts the real `applyFree` settles the mode. This is not weakened;
  - `helpers.ts`: `apply: 'stub'` became `apply: 'real'`, plus `recordedDeps()`;
  - `worker.test.ts`: a fee-cap assertion per environment.
- **Apply runs in one alarm.** It is chunked into D1 batches (about 100 D1 calls at 100k entries), not split across invocations.
- **RoundDO not initialized.** A `not_found` or `RangeError` from `onModeResult` raises `ALERT_DO_ERROR` and the job continues (W4-F1 V3's rule). Anything else is retried.
- **Size:** about 210k tokens, over M. There was no `.2` split.

## Spec issues

1. **"Data model" › Archival:** voided (rule 4) and rule-7/8 Free modes "also write a bundle", but they have no tally. Such a bundle needs a manifest without `drand` or a settle `record`, which is a bundle-format change (a Z decision). Built: no bundle; their ciphertexts stay in D1, and the RoundDO still enqueues no settle message after a void. Recommend: modes refunded before reveal publish no bundle, and a retention job (W13) deletes their ciphertexts after N days. The alternative is a `bundleFormat` 2 "unrevealed refund" manifest.
2. **"Data model" `settlements`:** name the Free contents of `tally_json` and `winners_json` as built (creator award and VOID details), and `tx_hash` = the manifest anchor transaction for Free.
3. **Payout rows differ across refunds:** rule 7/8 refunds write `payouts` rows of kind `refund` and no `settlements` row; rule 4 (`applyVoid`) writes neither. Recommend that rule 4 also write `refund`-kind payouts (W9-A may read them), or that the spec state the difference.
4. **"Round lifecycle":** `revealed_at` is set for both outcomes of a reveal (rules 1–3 included), since the tally is public. Recommend saying so.
5. **"Non-functional requirements" › Alerts:** name the nightly points mismatch (it raises `ALERT_SETTLEMENT_FAILED`) and an undeliverable RoundDO result (`ALERT_DO_ERROR`).

## Open issues

- **W6-C / W9-A:** the Free rows' "enqueue cards and notifications". No outcome hook exists yet; `applyFree` and `refundFree` are where those calls go.
- **W13:**
  - the private working files `settlement/{roundId}/{mode}/` (decrypt inputs repeat the ciphertexts) are never deleted; add them to retention;
  - load-test reduce plus apply at 100k entries in one alarm.
- **W6-A / W11:** a confirmed manifest anchor that is reorged out isn't resubmitted (`applyFree` skips any known state, and no handler resubmits on removal).
- **Later:** a personhood stack test. The mocks now run on the stack.

## Notes for D and Z

- Read in full: `settlement/apply/free.ts` (the json_each SQL and the credit-by-inserted-rows upsert), the `writeConfirmations` change in `anchor-do.ts`, and the `seam.ts` additions.
- `git diff audit-candidate-1 HEAD -- contracts/src` is empty.
- Every Stack step passed. The only alerts in the stack log are the expected `ALERT_SCHEDULE_GAP` for today's real daily round.
- Worktrees that Z can remove: `../flocked-w4-f1`, `../flocked-w4-f1-idx` (local branch `w4-f1-indexer`), `../flocked-w5-a`, `../flocked-w5-b`, `../flocked-w5-c`, and this one (`../flocked-w5-d`) after the merge.
