# Wave 5 summary

## Status

Merged to `main` at `8fc7aef`, a `--no-ff` merge of `w5-integration` @ `9ca389c`. The tag `wave-5` is on `main`'s head: the commit that adds this summary and the wave-6 prompts. Wave-6 worktrees therefore contain them, and `main` equals the tag.

- All five handoffs were `complete`: W5-A, W5-B, W5-C, W4-F1 and W5-D.
- **W5-F1 ran inside W5-Z** (owner decision, Oct 12; plan.md 2.6). The wave was green, but the three reviews found defects that no test caught (see Carry-over and `wave-5.md` "W5-F1"). Two subagents fixed them on `w5-f1-settlement` and `w5-f1-chain`, and both were merged into `w5-integration` before the merge to `main`.
- `git diff audit-candidate-1 HEAD -- contracts/src` is empty, on `w5-integration` and on `main` after the merge.

CI:

- `w5-integration` @ `4cda979` (W5-D's head plus its handoff and the W5-Z prompt): CI run 38177251802 (check, contracts, properties, static-analysis) and Stack run 38177251748 (five test steps) passed.
- `w5-integration` @ `be26d2e` (with W5-F1, the spec and the plan): Stack run 38210471401 passed. Its CI run 38210471218 lost the `contracts` job to cancellation when the next commit was pushed; the other three jobs passed.
- `w5-integration` @ `9ca389c` (adds `stack:up`'s ticket-signer key file for wave 6, under 20 lines): CI run 38211124363 (all four jobs) and Stack run 38211124336 (five test steps) passed.
- `main` @ `8fc7aef`: CI run 38212180151 (all four jobs) and Stack run 38212180187 passed. Locally on `main`: `pnpm install --frozen-lockfile && pnpm check` (node:test 20, abi 13, settle 66, tlock 176, shared 439, api 691, forge 202) and `pnpm format:check` passed, and `git diff audit-candidate-1 HEAD -- contracts/src` is empty.

Local checks (Node 22.23.1):

| Check | `4cda979` | With W5-F1 (`d65544c`; the same code as `be26d2e`) |
| --- | --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` | node:test 20, abi 13, settle 66, tlock 176, shared 439, api 678, forge 202 | node:test 20, abi 13, settle 66, tlock 176, shared 439, api 691, forge 202 |
| `pnpm format:check` | pass | pass |
| `FOUNDRY_PROFILE=ci forge test` | 202 passed (391 s) | contracts unchanged |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run` | (CI Stack run above) | 5 files, 19 passed (318 s). After `9ca389c`, a local `stack:up` wrote the key file (mode 600, gitignored), and CI's Stack run passed |

- Nothing was skipped or weakened. W5-F1 changed four existing tests, each for a stated reason:
  - `test/settlement/helpers.ts`: `seedFreeRound` now mirrors the `Committed` event, because S3 makes settlement wait for it;
  - the SET-4 test whose premise was "no mirrored count" became the S3 test;
  - an ALERT-1 test now mirrors the same bad root, so S2 doesn't fail it first with another message;
  - the ID-3 cross-session test now expects a refusal (owner decision).
- The api run prints about 40 workerd "uncaught exception" lines. They are DO methods throwing over RPC on purpose in tests (for example `onModeResult` `not_found`); vitest exits 0 with no "Errors" summary. Wave 4 had 2.

## On main now

- **Settlement core (W5-A, `apps/api/src/settlement/`, `do/settlement-do.ts`, `queues/{settle,decrypt}.ts`):**
  - the settle consumer starts `SettlementDO(roundId, mode)`;
  - the beacon is fetched from `DRAND_RELAYS` and verified for exactly `beaconRound`. It retries every 3 s, then raises `ALERT_BEACON_LATE` and retries every 60 s;
  - decrypt batches of 500 go to R2 and the decrypt queues; `chunkDone` counts each once;
  - the reduce runs `settle`, the invariant, the payout tree and the write-once RFC 8785 bundle (`docs/bundle-format.md`, `bundleFormat` 1);
  - a VOID rate over 2 % with at least 10 VOIDs → a `void_rate` hold plus `ALERT_VOID_RATE`;
  - the Stakes apply waits for `settlementHold` and the safe head (a stub until W6-A).
- **Free apply (W5-D, `settlement/apply/free.ts`):**
  - the settlement record, entries' option and validity, payouts and ledger in chunked idempotent batches (a balance moves only by the ledger rows inserted);
  - creator award, dust, refund rules 1–3, 7 and 8;
  - `RoundDO.onModeResult`, the manifest anchor (`AnchorDO.submitManifest`), and ciphertext archival once the bundle is durable;
  - the nightly points reconciliation (`jobs/reconcile.ts`).
- **Personhood (W5-B, `apps/api/src/personhood/`):**
  - Coinbase sign-in with PKCE and a single-use state in `AuthDO`; the callback, `person_id` HMAC, country and region only, pending merges, and person tombstones;
  - EAS attestation lookups (cached 10 min; tickets read fresh);
  - geo rules, proxy signals, and `stakesEligibility` in `GET /me` and `PATCH /me`;
  - the `config` table (migration 0009);
  - the Coinbase and EAS mocks on the stack.
- **W4-F1 (chain, AnchorDO, indexer, void):** all 22 review items (V1–V3, T1–T4, N1–N4, I1–I11) fixed, each with a test. See Traceability.
- **W5-F1:** S1–S4, P1–P3, C1–C5. See `wave-5.md` "W5-F1".
- **Design (W5-C):** Paper page `Social`: 47 states × 3 breakpoints for Round detail, Archive, Verify, Profile, Boards, the You menu, Submit, Queue, Rooms and Settings. 141 exports are in `docs/design/exports/{social,settings}/`, and the two Components fixes from Oct 9 are re-exported. Every state is `review`, pending OA-D3.
- **Stack:** five stack tests (`free-settle` added); the Coinbase (8790) and EAS (8791) mocks; `stack:status` has `coinbase` and `eas` rows. Since W5-Z, `stack:up` also writes the escrow's ticket-signer key to `e2e/stack/.run/ticket-signer.dev.vars` (gitignored) for W6, never into the API's `.dev.vars` (NFR-7).

## Interfaces changed or added

- `apps/api/src/settlement/types.ts`: `TallyResult` as pinned. `docs/bundle-format.md`: `bundleFormat` 1.
- `settlement/apply/free.ts`:
  - `applyFree(env, result, deps?)` and `refundFree(env, roundId, 7 | 8, deps?)`, with `FreeApplyDeps`;
  - the pin said `applyFree(result)`.
- `settlement/apply/stakes.ts`: `applyStakes(env, result)` stub, for W6-A.
- `settlement/safe-head.ts`: `safeHeadReady(env, roundId, mode)` stub (true for Free). W6-A backs it with the pinned `chain/safe-head.ts`.
- `do/settlement-do.ts`: `SettlementPhase` has no `held`. A held job is phase `applying` with `error: "held:<reason>"`.
- `personhood/eligibility.ts`: `stakesEligibility(env, user: Pick<SessionUser,'id'>, request, opts?)`, where `opts.attestationMaxAgeMs` is set to `0` for tickets.
- `personhood/flow.ts`: `completePersonhood` takes `sessionUserId` (W5-F1, P1).
- `packages/shared/src/api/me.ts`:
  - `INELIGIBLE_REASONS` / `IneligibleReason` (renamed from `STAKES_INELIGIBILITY_REASONS`, with deprecated aliases kept);
  - adds `country_unverified`, `country_mismatch` and `proxy_detected`, so `MeResponse.stakes.reasons` is wider.
- `chain/operator.ts`:
  - `OperatorTxResult` gains `cancelled`, and `pending` gains `nonceTaken`;
  - `OperatorDeps.nonceBlock` (W5-F1);
  - `runOperatorTx` throws, rather than answering `refused`, when a row already exists (W5-F1).
- `chain/tx.ts`:
  - `TxSender.check(tx, label, opts?)`, with `opts.nonceBlock` (W5-F1);
  - `sign(…, { replace, bumpFrom })`;
  - `SentTx.acceptedAt` (W5-F1);
  - the `TX_MAX_FEE_GWEI` cap, 32 versions at most.
- `lifecycle/void.ts`: `chainHeadPastClose` returns `bigint | null` (W5-F1).
- `indexer/handlers.ts`: `registerHandler(event, name, fn, opts?)` with `{ independent }`.
- `indexer/rpc.ts`: `IndexerRpc.code(address, block)`.
- `chain/client.ts`: `ANCHOR_SINGLETON` (moved; still re-exported from `anchor-do.ts`).
- `scheduler/tick.ts`: `TickReport.cancellations`.
- `env.ts`: `DRAND_RELAYS`, `TX_MAX_FEE_GWEI` (`"5"` in every env in `wrangler.jsonc`), `ATTESTATION_NETWORK`, `ATTESTATION_RPC_URL`, and `COINBASE_{LOGIN,API}_ORIGIN` (local only).
- `local/seam.ts`: `GET /__test/rounds/:id` adds settlement fields, and there is a new `GET /__test/bundles/:id/:mode/:file`.
- Migrations:
  - 0007 (W4-F1): `operator_txs` gets status `cancelled`; adds `indexer_checkpoints` and `chain_event_removals`, `chain_events.dispatch_alerted_at`, and the trigger `chain_events_removal`, which a later rebuild of `chain_events` must recreate;
  - 0008 (W5-A): the `void_rate` hold reason;
  - 0009 (W5-B): `config` and `person_tombstones`;
  - 0010 is unused.

## Decisions

All are owner decisions from Oct 12, 2026. The spec was edited and five Decision log rows were added (settlement; personhood and compliance; the callback review fix; client and boards; indexer, void and chain).

- **Settlement, as built:**
  - the order of the VOID checks;
  - decrypt batches vs bundle chunks;
  - receipt fields in Free chunks;
  - `void_rate` holds in either mode;
  - refunded payout trees, with the creator award not a leaf;
  - `DRAND_RELAYS`;
  - what `settlements` holds for Free;
  - `revealed_at` for rules 1–3;
  - the points-mismatch and RoundDO-result alerts.

  Free modes refunded before the reveal (rules 4, 7, 8) publish no bundle, and a retention job deletes their ciphertexts 30 days after the refund. Every Free refund writes `refund` payouts rows (W6-D builds rule 4's). The beacon alert gets its own traceability row, ALERT-9; the spec already listed it.
- **Personhood, as built:**
  - the `config` and `person_tombstones` tables;
  - a 7-day merge TTL and a 10-minute state TTL;
  - the country matched at country level, and region rules applied to the request location;
  - Tor and a bot score below 30 as proxy signals;
  - `ATTESTATION_RPC_URL`;
  - a person ID bound without personal details is unverified.

  New: `geo.stakes.age21`. Any linked wallet holding both attestations suffices. A callback carrying another user's session is refused (review finding; ID-3 updated). The Coinbase response shape is checked with the real app in W14-A, and OA-22 shows 🟡 until then.
- **Client and design:**
  - the Streaks board ranks the best stray streak (all time);
  - Round detail shows one result box per mode played;
  - the Archive row shows the mode played;
  - Verify my entry without the receipt still offers the totals check;
  - the You tab toggles the You sheet;
  - the destructive confirm keeps the accent primary.

  W7-C, before the admin pages: remove the "Questions" header link (Core flow and the navigation sheet), draw `security_notice` as a locked row, and apply the five kit fixes (`wave-7.md`).
- **Indexer, void and chain wording from W4-F1, as built:** the new tables and columns, the re-index and changed-slot rules, head-age lag, the repeating stuck-entry alert, the constructor exemption, the void wording, `TX_MAX_FEE_GWEI`, and cancellations.
- **Protocol:** when the next wave edits the same files, Z may run the fix session itself before merging (plan.md 2.6).
- **Spec sections edited:**
  - "Round lifecycle" (mode status `revealed_at`; Void);
  - "Sealed picks (timelock encryption)" (Scheme; Invalid entries);
  - "Settlement and payout math" (Refund rules; Settlement output);
  - "Identity and personhood" (Merging accounts; Personhood);
  - "Smart contract" (Gas and UX);
  - "Architecture" (the Coinbase external system; the Decrypt workers row);
  - "Data model" (`settlements`, `settlement_holds`, `payouts`, `indexer_state`, `chain_events`, `operator_txs`, new `person_tombstones`, `config`, `indexer_checkpoints`, `chain_event_removals`; Archival);
  - "Client app" (Navigation; the Round detail, Archive and Verify rows);
  - "Profiles, leaderboards and rooms" (Leaderboards);
  - "Compliance and responsible play" (Geo-fencing; Age and terms);
  - "Non-functional requirements" (Alerts; Scaling notes);
  - "Testing and acceptance criteria" (login CSRF);
  - "Out of scope, launch gates and decision log" (gate 2; Decision log).

## Traceability

- **Closed (✅):** PIPE-4, ID-2, ID-3, SET-4 (math, classification and pipeline). W4-F1's tests were added to PIPE-2, PIPE-3, ALERT-4, ALERT-6 and ALERT-8.
- **Partly proven (🟡):**
  - SET-1b: rules 4, 7 and 8 are proven; 5 and 6 are W6-A's;
  - NFR-6: settlement and Free apply are proven; Stakes is W6-A's;
  - NFR-8: the Coinbase data part is proven; person tags are W6-B's, and the log scan W13-C's;
  - ALERT-1, ALERT-5 and the new ALERT-9: detection proven, with routing in W13-A. ALERT-1's Stakes reconciliation is W6-A's.
- **W4-F1 closure:** W5-Z's review re-ran the 11 files (112 tests, all pass) and matched every item to a named test. All 22 are closed:
  - V1–V3: `test/lifecycle/void.test.ts`;
  - T1–T4: `test/scheduler/tx.test.ts`;
  - N1–N4: `test/anchor-do/anchor-do.test.ts` › "W4-F1 review fixes", plus `test/lifecycle/anchor-reorg.test.ts`;
  - I1–I11: `test/indexer/{dispatch,reorg,core,alerts,indexer-do,budget}.test.ts`.

  There are two gaps:
  - N3's retried `applyReceipt` branch has no test (→ W13-A);
  - I5's chunk-apply does have a test ("applies each chunk as it arrives"), although W4-F1 said it was checked by reasoning.

## Carry-over

Details are in each wave file's "Carry-over from W5-Z (Oct 12, 2026)".

- **W6-A:**
  - the safe head and `closeBlock`;
  - Stakes ciphertexts in `entries.ciphertext`;
  - `applyStakes(env, result)`;
  - a re-added entry with new block fields, and un-counting a removed one (W4-F1);
  - resubmitting a reorged manifest anchor;
  - the serialised operator nonce;
  - S5 (keep a failed commit open until the chain passes beacon time);
  - a void abandoned when its receipt lags across two reads.
- **W6-B:**
  - `stakesEligibility(…, { attestationMaxAgeMs: 0 })` and the per-round checks;
  - any linked wallet suffices;
  - `geo.stakes.age21`.
- **W6-C:** refund cards and copy for rules 7 and 8.
- **W6-D:**
  - rule 4 writes `refund` payouts rows (`applyVoid`);
  - Free settlement fields in the read APIs;
  - no bundle for refunds before the reveal;
  - the wider `INELIGIBLE_REASONS`.
- **W7-B:**
  - `person_tombstones` at deletion;
  - coinbase merge confirmation;
  - refusing to unlink coinbase;
  - `profile.ts` `stakesReasons`.
- **W7-C:** the header link, the `security_notice` row, the Streaks board, and the five kit fixes.
- **W8-B:** the Streaks ranking. **W8-D:** the room `qualifies` flags.
- **W9-A:** the Free outcome's notifications from `applyFree`, `refundFree` and `applyVoid`. **W9-B:** the bundle-format decisions.
- **W11-A:** `config` edits with an `audit_log` row, and `void_rate` hold release.
- **W13:**
  - retention of `settlement/` working files and of ciphertexts from pre-reveal refunds;
  - 25 entries per dispatch;
  - the indexer write-budget gap;
  - N3's test;
  - a load test of reduce plus apply at 100k;
  - `PERSON_ID_KEY` and `ATTESTATION_RPC_URL` in the secrets runbook;
  - per-environment `TX_MAX_FEE_GWEI`.
- **W14-A:** the Coinbase API shape with real accounts (OA-22).
- **Later:** a personhood stack test.

## Owner actions

- **OA-20 (gate 3, audit):** not booked as of Oct 12. It is now the critical path: W15 needs the report. Send `docs/audit/package.md` with the contracts at `audit-candidate-1`, which is still unchanged.
- **OA-D3:** review the Paper `Social` page (47 states) and the two Components fixes. Needed by W11. W7-C's Paper fixes touch the Streaks board and the Settings notifications row, so you can review the rest now.
- **OA-D2:** the Core flow freeze, needed by W9. Review it after W7-C removes the header link.
- **OA-D4:** Cards and notifications, after W6-C. Needed by W10.
- **OA-09:** the Coinbase OAuth app, with redirect URI `${APP_ORIGIN}/api/v1/me/personhood/callback` and scopes `wallet:user:read` and `identity:user:address:read`. Start by W8.
- **OA-22:** the policy is confirmed; W14-A confirms the response shape with OA-09's app (🟡).
- **OA-21:** legal text by W12, and sign-off by W16. It also sets the `geo.stakes.allow` and `geo.stakes.age21` values.
- **OA-04:** Workers Paid and the deploy token. Start by W10.
- **OA-17:** the admin and guardian multisigs. Start by W10.

## Next wave

The prompts are `docs/prompts/W6-A.md`, `W6-B.md`, `W6-C.md` and `W6-D.md`. A, B and C run in parallel from the tag `wave-5`; D merges them.

Migrations are reserved: W6-A `0011`, W6-B `0012`, W6-D `0013` (0010 stays unused).

Changes from `wave-6.md`:

- the safe-head pin names W5-A's `safeHeadReady` predicate;
- W6-A takes S5, the void receipt-lag residual and manifest resubmission;
- W6-D takes rule 4's `refund` payouts rows (`lifecycle/void.ts`);
- W6-B takes `geo.stakes.age21`.

Stack tests can reuse `POST /__test/rounds/scheduled`, the cron driver, `GET /__test/bundles/...` and the pattern in `e2e/tests/free-settle.test.ts`.
