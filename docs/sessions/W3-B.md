# W3-B handoff: RoundDO Free entries

## Status
complete — tlock fix, receipts, the RoundDO Free path, alarm chain, close and root, and the entry route are in; `pnpm check` green.

## Summary
- `@flocked/tlock`: a stanza `U` that isn't the canonical compressed G2 encoding (a coordinate ≥ p, which noble reduces silently) or is infinity is now `decrypt_failed`. `TypeError`/`ReferenceError` from decryption are rethrown, and `classify` runs a once-per-isolate self-test that opens an embedded fixture pick first.
- Receipts (`src/crypto/receipt.ts`) use `@flocked/shared`'s EIP-712 builder and `@flocked/settle`'s `userIdHash`. They reproduce `packages/abi/test/fixtures/receipt.json` byte for byte. That fixture now hashes binary ULIDs and is verified on-chain by `AnchorReceipt.t.sol`.
- `RoundDO`: `init` (idempotent, validated against the pinned chain), `enterFree` (the spec's commit protocol), `getState`, and an alarm chain: open → streak_at_risk → closing_soon → close → settle at beacon time → rule 8 at +24 h. At close it drains in-flight entries, seals the round in D1, reconciles leaves against D1, builds the root with `freeCommitmentTree`, writes `round_modes.commitment_root`, and hands the root to the AnchorDO with retries until min(close + 90 s, beacon − 30 s).
- `POST /rounds/:id/entries` (`requireUser`, `validate()`; returns 201 with the entry and receipt), plus the daily grant on first entry (`src/rounds/grant.ts`).
- **How `seq` avoids gaps:** the entry insert allocates `receipt_seq` inside D1's transaction as MAX + 1 for the round. D1 runs batches one at a time, so committed seqs are always 0…n−1, and a rolled-back batch consumes nothing. The DO reserves nothing. The insert's `created_at` becomes NULL unless `rounds.status = 'open'`, so once close seals the round, no late write can commit an entry that the root would miss.

## Branch and head commit
`w3-b-round-do` @ `2fbe4a9` (commits: `b8ab870` tlock, `d24426f` abi fixture, `2fbe4a9` api). This handoff is committed on top.

## Files touched
- New: `apps/api/src/crypto/receipt.ts`, `apps/api/src/rounds/{entry,grant,schedule,close,hooks}.ts`, `apps/api/migrations/0003_round_do.sql`, `apps/api/test/round-do/{helpers,entries,close-race,alarms,receipt,route}.test.ts` (helpers is `.ts`), `packages/tlock/test/{environment,classify.properties}.test.ts`.
- Edited: `apps/api/src/do/round-do.ts`, `apps/api/src/routes/entries.ts`, `packages/tlock/src/{seal,classify}.ts`, `packages/tlock/README.md`, `packages/tlock/test/{classify.test,helpers,roundtrip.workers.test}.ts`, `packages/abi/scripts/receipt-fixture.{mjs,d.mts}`, `packages/abi/test/{receipt.test.ts,fixtures/receipt.json}`.
- Edited outside the listed paths (see Deviations): `apps/api/vitest.config.ts`, `apps/api/test/{do,routes,migrations}.test.ts`.

## Tests run
| Command | Result |
| --- | --- |
| `pnpm check` (Node 22.23.1) | pass: node:test 20, abi 13, settle 66, tlock 176, shared 438, api 330, forge 199 |
| `pnpm format:check` | pass |
| `pnpm --filter @flocked/tlock test` | pass (176; was 161), node + workers projects |
| `forge test --match-contract AnchorReceipt` | pass (4) against the regenerated fixture |

## Traceability rows covered
- **DO-1** `apps/api/test/round-do/entries.test.ts`::"DO-1: … › rejects an entry at or after closesAt, and before opensAt"; "rejects a second, different entry from the same user and keeps the first"; also "answers a retried identical request with the same receipt…", "serializes concurrent requests from one user…", "a retried stake that already committed (reply lost) gets its receipt, not insufficient_balance".
- **DO-2** same file::"DO-2: … › insufficient balance leaves no entry, no ledger row and no seq gap"; "a member with no balance row in the room is rejected the same way"; "rejects a room entry from a non-member, even with points in that scope".
- **DO-3** `apps/api/test/round-do/close-race.test.ts`::"every acknowledged entry is in the root, and its receipt verifies against it". It runs 40 entries, with the close alarm firing while entries are in flight (asserted). Each receipt is checked by recovering the signer and verifying an independent OZ-style proof against the root. Also "an entry committed to D1 whose leaf was lost is recovered into the root at close". Fixture equivalence: `receipt.test.ts`::"reproduces the fixture signature with the shared builder and settle userIdHash".
- **DO-4** `entries.test.ts`::"DO-4: … › stake %s is outside 10–100", "accepts the bounds of the locked range…", "rejects suspended and deleted accounts", "rejects a self-excluded user under the single exclusion rule".
- **DO-5 (alarm half)** `apps/api/test/round-do/alarms.test.ts`::"runs every event in order, once, at its time", plus rule 8 after leaving pending, catching up on missed alarms, a late open, commit retry, the commit deadline, a not_implemented AnchorDO, and idempotent init.
- **TL-3 (additions)** `packages/tlock/test/classify.test.ts`::"decrypt_failed: U must be the canonical compressed encoding of a G2 point" (x_c0 + p, x_c0 + 2p, x_c1 + p, infinity; each forged ciphertext classifies **valid** with the check disabled); `environment.test.ts`::"TL-3: a broken runtime throws instead of turning entries into VOIDs"; `classify.properties.test.ts` (mutations never throw).
- Submit checks: `entries.test.ts`::"sealed pick checks at submit" (non-canonical header, wrong target round, the 2,048-byte cap, no Free mode).

## Deviations
- **Files outside the listed scope**, all needed to keep `pnpm check` green:
  - `apps/api/vitest.config.ts` pre-bundles tlock-js's deep imports. Its own comment said to do this once the Worker imports `@flocked/tlock`.
  - `test/do.test.ts`: RoundDO's init, enterFree and getState are no longer stubs.
  - `test/routes.test.ts`: an `IMPLEMENTED` set excludes `POST /rounds/:id/entries` from the 501 sweep.
  - `test/migrations.test.ts`: lists `daily_grant_skips`.
- **New table `daily_grant_skips`** (0003). A daily grant skipped at ≥ 1,000 must be final for the game day yet writes no ledger row. The skip is recorded inside the grant's own batch, so the decision is atomic. `grantMovement` can't express this and `src/points/**` is pinned, so `src/rounds/grant.ts` builds its own statements and still runs them through `applyMovement`.
- **`seq` is allocated at commit in SQL**, not reserved in the DO (see Summary). The plan allowed either; this one is gap-free by construction.
- **Idempotent replay:** an identical retry (same stake and commitment) returns the original receipt instead of `already_entered`. A different second entry is still `already_entered`.
- **Rule 8** at beacon + 24 h: if `round_modes` Free is still `pending`, the DO enqueues `settle` with key `${roundId}:free:rule8`. The conditional update and the refunds belong to the settle consumer (W5-A). The DO doesn't flip the status itself, because the flip and the refunds must happen together.
- **Notification hooks** run at their times but resolve no recipients yet (`notificationsFor` returns `[]`; W9-A). `broadcast()` is a no-op (W7-A).
- **Status mapping:** `getState()` before `init` throws `not_found: …`; `deleted`/`merged` accounts map to `account_deleted`.
- **`LOCAL_DEPLOYMENT`:** receipt signing on chain 31337 reads this var (the JSON of `contracts/deployments/31337.json`), typed locally in `receipt.ts` because `env.ts` is pinned.
- No test was skipped, deleted or weakened. The tlock subagent's work (fix and tests) is reported above.

## Spec issues
- **"Data model":** add a `daily_grant_skips` row (user_id, round_id, balance, skipped_at; PK (user_id, round_id)) to back the Oct 8 "skipped grant is final" rule. Recommend adopting it as built.
- **"Anti-abuse" / the `turnstileToken` field:** the first Free entry of each game day requires Turnstile, but no wave assigns it, and W3-B doesn't enforce it. Recommend W4-A or the anti-abuse session add it in the entries route.
- **"Sealed picks" › Free mode specifics:** a Free mode with no entries has no root (an OZ tree needs ≥ 1 leaf), so nothing is anchored and rule 7 would refund nothing. Recommend stating that an empty Free mode skips the commit and settles as refund rule 1 (too few).
- **Room rounds:** the Free table names only the daily grant, but `points` mentions room-round grants below 1,000. Recommend confirming whether room rounds pay a per-round grant (W6).

## Open issues
- The AnchorDO is a stub, so roots are recorded as `not_implemented` and are not anchored yet (W4). The visit-path daily grant must call `applyDailyGrant`, not `grantMovement` (whoever builds first-visit grants, likely W4-A).
- Not built here: `requestVoid` and `onModeResult` (W4-D), `ingestStakesEntry` (W6-A), `GET /rounds/:id/me` (W6), and the WebSocket hub (W7-A).
- Under a frozen test clock, an alarm for an event 1 ms ahead re-arms on wall time every millisecond until the clock moves. That's harmless, but e2e (W3-D, E2E-14) should advance the clock rather than freeze it just before an event.
- The tlock self-test failure is sticky per isolate (a broken runtime keeps throwing until the isolate is replaced). This was a deliberate choice; review in Z.

## Notes for D and Z
- **CI** (`.github/workflows/ci.yml`, D's file): add `test/classify.properties.test.ts` to tlock's properties step, e.g. `exec vitest run --project node test/plaintext.test.ts test/classify.properties.test.ts` (about 20 s at `FAST_CHECK_RUNS=10000`).
- **Env** (`src/env.ts`): add `LOCAL_DEPLOYMENT?: string` (local only). The W3-D stack must write `LOCAL_DEPLOYMENT` (the deployments JSON) and a generated `RECEIPT_SIGNER_KEY` to `.dev.vars`; entries answer 503 `unavailable` without them. No binding or `src/index.ts` changes.
- **Merge conflicts to expect with W3-A:** `test/routes.test.ts` (merge both `IMPLEMENTED` lists) and `test/migrations.test.ts` (`SPEC_COLUMNS` if 0002 adds tables).
- **Worth reading:** `src/rounds/entry.ts` `entryInsert` (seq allocation and the D1 seal) and `src/do/round-do.ts` `commit`/`close`. Also confirm `decryptWithSignature` and the self-test under `wrangler dev` (W3-D).
- **Test technique:** mutating `env` from `cloudflare:test` reaches the DOs' env (clock, signer key, queues). Swapping a DO namespace breaks `runInDurableObject`, so the tests patch `AnchorDO.prototype` instead.
