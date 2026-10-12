# W6-A handoff: Stakes settlement

## Status

complete — a Stakes round on the local stack streams, reconciles, waits for the safe head, proposes and reaches `settled` through `finalize`, with payouts in D1; every carry-over item is fixed with a test that fails without it.

## Summary

- **Entry set** (`settlement/stakes/{escrow,entry-set}.ts`, `chain/safe-head.ts`). The RoundDO's close step starts the Stakes SettlementDO (queue `settle`). It streams `Entered` logs from the createRound block into R2 files (`entered-nnnn.json`), never past the safe head and 2,000 blocks per `eth_getLogs`; a range a provider refuses is halved. Once the safe head passes the close block (`ALERT_SAFE_HEAD_LAG` at beacon + 60 s), it reconciles count and stake sum against `entryCount` / `roundBalance` at that block. A mismatch alerts (`ALERT_SETTLEMENT_FAILED`) and is re-read from `BASE_RPC_URL_FALLBACK`; a second mismatch fails the job, posts nothing and leaves the round Open.
- **Prepare** checks D1's entries against the streamed set, entry by entry, and that each ciphertext hashes to its onchain commitment. While D1 lags it waits, alerting once after 10 min. The manifest carries `closeBlock`.
- **`applyStakes`** reads the round onchain first, writes the settlement record, the entries' outcomes and `bundle_hash`, then calls `propose`, at most once per `propose:<roundId>:<seq>`. `seq` moves on only when the indexer supersedes the record (a veto or a reorg).
- **Follow** (SettlementDO phase `proposing`):
  - calls `finalize` at `claimsOpenAt`;
  - proposes again when the round is Open again;
  - calls `refundTooFew` when entries < `minEntrants` (no reveal, no bundle);
  - calls `refundTimeout` at closesAt + 72 h, from any unfinished job, failed ones included.
- **Indexer** (`indexer/handlers/stakes.ts`):
  - `OutcomeProposed` → `settle_proposed` / `refund_proposed`; a removal that isn't live again → back to `revealing`, superseded;
  - `ProposalVetoed` (both directions, with an `audit_log` row; a vetoed refund proposal alerts and settles again);
  - `RoundFinalized` (Settled) → `settled` and the `payouts`;
  - `RoundRefunded` reasons 1, 2, 3, 5 and 6 → `refunded` and `refund` payouts.
- **Ingestion** (`lifecycle/handlers.ts`, `RoundDO.ingestStakesEntry`): each ticketed `Entered` gets its `entries` row with the ciphertext. A removal deletes the row and un-counts it, and a re-add keeps the new block fields (D1 and RoundDO).
- **Carry-over:**
  - one owner of the operator nonce (a D1-claimed allocator in `chain/operator.ts`);
  - a void whose receipt lags is an indefinite answer;
  - S5 (a sent commit stays open until the head is past beacon time; a 20 s grace on the local stack only);
  - `ManifestAnchored` removals are resubmitted to the AnchorDO;
  - Stakes proposals removed by a reorg are posted again.

## Branch and head commit

`w6-a-stakes-settlement` @ `eb1dba4` (this handoff is the next commit)

## Files touched

- New:
  - `apps/api/src/chain/safe-head.ts`, `src/settlement/stakes/{escrow,entry-set}.ts`, `src/indexer/handlers/stakes.ts`;
  - `migrations/0011_stakes_settlement.sql`;
  - `test/settlement/{stakes-chain,stakes-helpers}.ts`, `test/settlement/{stakes-settle,stakes-safe-head}.test.ts`;
  - `test/scheduler/operator-nonce.test.ts`, `test/lifecycle/manifest-reorg.test.ts`;
  - `e2e/tests/stakes-settle.test.ts`, `docs/sessions/W6-A.md`.
- Edited:
  - `src/settlement/{apply/stakes,prepare,reduce,safe-head}.ts`, `src/do/{settlement-do,round-do,anchor-do,types}.ts`;
  - `src/chain/operator.ts`, `src/lifecycle/handlers.ts`, `src/local/seam.ts`;
  - `docs/bundle-format.md` (Stakes rows);
  - tests: `test/{migrations,local-seam}.test.ts`, `test/settlement/{helpers.ts,holds.test.ts}`, `test/lifecycle/{helpers.ts,handlers,void}.test.ts`, `test/round-do/alarms.test.ts`, `test/scheduler/{helpers.ts,operator.test.ts}`, `test/anchor-do/anchor-do.test.ts`.

## Tests run

| Command | Result |
| --- | --- |
| `pnpm check` (Node 22.23.1) | pass: node:test 20, abi 13, settle 66, tlock 176, shared 439, api 719 (was 691), forge 202; no "Errors" summary |
| `pnpm format:check` | pass |
| `pnpm stack:up` + the five existing stack tests, then `tests/stakes-settle.test.ts` | 5 files, 19 passed (316 s); then 4 passed (215 s) |
| 20 source mutations (scratchpad script: one replacement, the test that should catch it, restore) | all 20 caught |

## Traceability rows covered

- **SET-1b, rules 5 and 6:** `apps/api/test/settlement/stakes-settle.test.ts`:
  - "a vetoed settlement is refunded with reason 5, its record superseded (SET-1b rule 5)";
  - "a mismatch on both providers alerts, posts nothing and keeps the round Open; refundTimeout ends it at closesAt + 72 h (SET-1b rule 6)".
- **ALERT-1 (Stakes reconciliation):** same file:
  - "a mismatch on the primary provider alerts and is read again from the fallback, which reconciles";
  - "a mismatch on both providers …";
  - "waits while the indexer hasn't stored every streamed entry" (alerts after 10 min).
- **ALERT-3:** same file, "streams, waits for the safe head (ALERT-3), proposes …" (once, at beacon + 60 s).
- **NFR-4 (part):** `e2e/tests/stakes-settle.test.ts`, "proposes after the beacon and the safe head: the contract derives settle's amounts (NFR-4, part)", which compares the real escrow's `getRound` with settle in Node. The unit version is the first test in the settlement file.
- **NFR-6 (Stakes):** "a proposal still pending is polled, never posted again, and a later apply checks the chain first".
- **Also:**
  - "a vetoed refund proposal returns the mode to revealing, alerts, and it settles again";
  - "a proposal a reorg removed (not re-mined) is posted again";
  - "fewer entries than minEntrants: refundTooFew after close, no reveal (rule 1)";
  - `test/lifecycle/handlers.test.ts` "W6-A: stores the entry with its ciphertext, keeps a re-added log's new block, and un-counts a removed one";
  - `test/scheduler/operator-nonce.test.ts` (3 tests);
  - `test/scheduler/operator.test.ts` "a nonce seen taken a block apart, with the re-sign refused, is no definite answer …";
  - `test/anchor-do/anchor-do.test.ts` › "W6-A S5" (4 tests);
  - `test/lifecycle/manifest-reorg.test.ts` (4 tests);
  - `test/settlement/stakes-safe-head.test.ts` (4).
- **Mutation check:** 20 mutations of the fixes (each carry-over item, the alerts, the nonce claims, the stream check, the foreign payout); every one fails its test.

## Deviations

- The Stakes handlers are registered by `registerLifecycleHandlers` (my file), not by D in `indexer/handlers.ts`, so the stack test works on this branch. D has nothing to register.
- `settlement/reduce.ts`, which isn't in my list, has 8 lines: `ReduceInputs.closeBlock` → the manifest's `closeBlock`. No one else owns it this wave.
- The pinned `closeBlockFor` / `safeHeadPast` take a viem client first: `closeBlockFor(client, closesAtSec)` and `safeHeadPast(client, {number, hash})`. `safeHeadReady(env, roundId, mode, deps?)` and `applyStakes(env, result, deps?)` gain optional deps.
- P2.4 (for Z):
  - `StakesEntryEvent.removed?`;
  - SettlementDO uses the existing phase `proposing` for Stakes after the proposal, and is `done` only when the round is final onchain;
  - new non-RPC fields `stakesDeps` and `hooks.stakesEntrySet`.
- `finalize` is sent by the SettlementDO, which already follows the proposal onchain, not by the indexer (see Spec issues).
- Changed tests, each because the behaviour changed on purpose:
  - `void.test.ts` and `alarms.test.ts`: Stakes is enqueued at close too;
  - `lifecycle/helpers.ts`: one operator key per fake chain, since a fresh chain starts at nonce 0 while D1 keeps the file's earlier sends and the allocator skips their nonces;
  - `handlers.test.ts`: the registry lists the new handlers, and V3 now returns the entry's D1 row (D1 is settlement's input; the RoundDO counters are display);
  - `holds.test.ts`: the seeded round needs `minEntrants: 3`, because 3 of 20 now takes `refundTooFew` before any reveal; it ends in `proposing`, and its manifest has a `closeBlock`.
- Subagents: two (the operator nonce owner and receipt lag; S5 and manifest resubmission). I reviewed both diffs, fixed their tests' fallout, and mutation-checked them.

## Spec issues

- "Round lifecycle" (settle_proposed → settled): "The indexer calls `finalize`". As built, the settlement coordinator calls it, since it follows the proposal anyway. Recommend "the backend calls `finalize`".
- "Round lifecycle": `refund` payouts are named only for a vetoed settlement. As built, every Stakes refund (reasons 1, 2, 3, 5, 6) writes them, like Free (Oct 12). Recommend saying so.
- "Sealed picks" › Stakes mode specifics: "retries against a second RPC provider and alerts, and does not post a result". As built, each mismatch alerts, a fallback that reconciles proceeds, and a second mismatch posts nothing. Recommend that wording.
- A vetoed refund proposal "settles again" with the same deterministic bundle, so the same refund is proposed again unless code or data changed first. Recommend the spec say what the guardian's veto is for (a fix deployed before the re-proposal), with the timeout as the backstop. Its alert is `ALERT_DO_ERROR` step `refund_proposal_vetoed`; the spec names no code.
- Too few entrants: `refundTooFew` after the reconciliation, with no reveal and no bundle (`revealed_at` stays null). Recommend confirming, as for Free rules 4, 7 and 8.

## Open issues

- **W13 (load):** the `RoundFinalized` payouts insert is one INSERT … SELECT per round (100k entries in one statement).
- **W13 (retention):** `entered-*.json` working files and Stakes ciphertexts in D1 are kept (archival is Free only).
- **Re-sending:** a `finalize` / `refundTooFew` / `refundTimeout` that reverts is final for its purpose and isn't resent. Anyone can call them, and claims finalize too.
- **W7-A / W6-D:** the RoundDO's Stakes status stays `settle_proposed` after `RoundFinalized`, since no final ModeResult exists. D1 is the record.
- **W9-A:** Stakes notifications and cards.
- **W4-F1 (pre-existing):** a `handlers.test.ts` Locked-removal test logs an uncaught `NOT NULL items.beacon_round` from the AnchorDO; the test passes.

## Notes for D and Z

- **Registrations:** none for D. `stakes-proposal`, `stakes-veto`, `stakes-finalized` and `stakes-refunded` are registered through `registerLifecycleHandlers`, plus `anchor-confirmation` for `ManifestAnchored`. Names are stable.
- **Bindings and vars:** none new. `BASE_RPC_URL_FALLBACK` (existing secret) is now the reconciliation re-read: set it in staging and production (W13).
- **`lifecycle/void.ts`:** no change needed (the receipt-lag fix is in `operator.ts`).
- **Stack (D owns `e2e/stack/**` and `stack.yml`):**
  - add `tests/stakes-settle.test.ts` as the LAST Stack step: it moves anvil's clock 2 h forward, which can't be undone (~3.5 min);
  - anvil's `safe` tag trails `latest` by 32 blocks, so the test mines 40 blocks after close; consider `--slots-in-an-epoch 1` in `up.mjs`;
  - README seam rows: `POST /__test/stakes/tickets`; `stakes` and `free` options on `POST /__test/rounds/scheduled`; the `stakes` section of `GET /__test/rounds/:id` (`free` is null for a Stakes-only round).
- **W6-D read models:**
  - Stakes `settlements` rows: `proposal_seq`, `superseded_at`, `tx_hash` = the proposal, `settled_at` = final, and `winners_json` = `{winner, refundReason, voidCount, voidStake, total, winPayout, rebatePayout, chainRoundId}`;
  - `round_modes` `claims_open_at`, `revealed_at` and `final_at`;
  - `payouts` win/rebate/void_refund/refund rows, none for foreign entries (their payout is only in the tree and the bundle; `payouts.user_id` stays NOT NULL);
  - `Claimed` / `RefundClaimed` → `claimed_at` is W6-D's.
- **Risky diffs worth reading:** the nonce allocator (`chain/operator.ts`), S5 (`anchor-do.ts` `checkOnchain` / `expire`), `settlement-do.ts` `follow` / `backstop` / `timedOut`, and the stream check (`prepare.ts`).
- **Migration 0011:** one index, `entries_round_stakes_chain_idx`.
