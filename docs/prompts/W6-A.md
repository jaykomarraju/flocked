# Session W6-A: Stakes settlement

**Role:** build. **Size:** M (split into `W6-A.2` if needed: Stakes ingestion, chunk streaming, reconciliation and the safe head first; `applyStakes`, the handlers, `finalize` and the rest of the W5-Z carry-over second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-6.md`: the intro, "Pinned interfaces", "W6-A", and the W6-A and "All" items of every "Carry-over" section (W2-Z, W3-Z, W4-Z, W5-Z).
- `docs/sessions/W5-Z.md` (wave-5 summary), including W5-F1's interface changes. Then `docs/bundle-format.md` and `e2e/stack/README.md` (the seam, the cron driver, the stack tests).
- Code you build on:
  - `apps/api/src/settlement/{safe-head,prepare,types}.ts`, `apply/stakes.ts` (the stub) and `do/settlement-do.ts` (the hold check; a held job is phase `applying` with `error: "held:<reason>"`);
  - `apps/api/src/chain/{client,tx,operator}.ts` (`propose`, `finalize`, `driveCancellations`) and `scheduler/tick.ts` (the cancellation sweep);
  - `apps/api/src/lifecycle/handlers.ts` (`stakes-ingest`, `stakes-void`), `do/round-do.ts` `ingestStakesEntry`, `do/types.ts` `StakesEntryEvent`;
  - `apps/api/src/indexer/{handlers,registry,entered,holds}.ts`, and `do/anchor-do.ts` (`expire`, the pre-send check, `submitManifest`);
  - `apps/api/src/lifecycle/void.ts`, read only (W6-D owns it this wave);
  - `packages/settle` (Stakes closed form, payout tree), `packages/abi` (FlockedEscrow events), `apps/api/src/local/seam.ts`.
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "Round lifecycle"                                     # the Stakes rows
  pnpm spec "Sealed picks (timelock encryption)" --sub "Stakes mode specifics"
  pnpm spec "Smart contract" --sub "Rules the contract enforces"  # only the propose, veto, finalize and refundTimeout bullets
  pnpm spec "Settlement and payout math" --sub "Stakes closed form"
  pnpm spec "Settlement and payout math" --sub "Settlement output"
  ```
  Changed in wave 5 (Decision log, Oct 12, 2026): "Round lifecycle" (`revealed_at`; Void), "Sealed picks (timelock encryption)" (Scheme; Invalid entries: a `void_rate` hold applies in either mode), "Settlement and payout math" (Refund rules; Settlement output: a refunded Stakes mode has no payout tree, `payoutRoot` null), "Smart contract" (Gas and UX: `TX_MAX_FEE_GWEI`, cancellations), "Data model" (`settlements`, `settlement_holds`, `payouts`, `chain_events`, `operator_txs`, `indexer_checkpoints`, `chain_event_removals`) and "Non-functional requirements" (Alerts; Scaling notes). Read the Oct 12 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 12'`.

## Objective
Make Stakes settle end to end at the API and contract level:
- Between close and the beacon, stream `Entered` logs up to the close block into chunk files, and reconcile the count and stake sum against `entryCount` / `roundBalance` at that block. On a mismatch, retry with the second RPC provider, alert, and post nothing.
- Wait for the safe head to pass the close block (ALERT-3 at beacon + 60 s), and write `closeBlock` into the Stakes manifest.
- `applyStakes` posts `propose(n0, n1, nVoid, payoutRoot, bundleHash)`. Payout leaves come from the settle output: win, rebate when r > 0, `void_refund`.
- Indexer handlers for `OutcomeProposed`, `ProposalVetoed` (both directions, superseding settlements), `RoundFinalized`, and `RoundRefunded` reasons 1 and 6.
- `finalize` (operator-sent, gasless) at `claimsOpenAt`. `refundTooFew` and `refundTimeout` stay open to anyone, and the backend calls them when due.
- The rest of Stakes ingestion, and the chain carry-over: the serialised operator nonce, S5, manifest resubmission after a reorg, and the void receipt lag.

## Starting point
- Base: tag `wave-5`. Branch: `w6-a-stakes-settlement`. Worktree: `../flocked-w6-a`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w6-a -b w6-a-stakes-settlement wave-5
  cd ../flocked-w6-a && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/settlement/apply/stakes.ts`, `apps/api/src/settlement/stakes/**`, `settlement/{safe-head,prepare}.ts`, and the Stakes paths of `apps/api/src/do/settlement-do.ts`;
  - `apps/api/src/chain/safe-head.ts` (new) and `chain/{tx,operator}.ts`; `scheduler/tick.ts` only if the nonce owner needs the cancellation sweep changed;
  - `apps/api/src/do/anchor-do.ts` (S5 and manifest resubmission), and the anchor path of `settlement/apply/free.ts` only if resubmission needs it;
  - `apps/api/src/indexer/handlers/stakes.ts` (new; D registers it), `apps/api/src/lifecycle/handlers.ts`, the Stakes paths of `do/round-do.ts` (`ingestStakesEntry`, and the close step if streaming starts there), and `StakesEntryEvent` in `do/types.ts` (a note for Z);
  - `apps/api/src/local/seam.ts`: Stakes options on `POST /__test/rounds/scheduled`, Stakes fields on `GET /__test/rounds/:id`, and test tickets; with `apps/api/test/local-seam.test.ts`;
  - migration `apps/api/migrations/0011_*.sql`, and `apps/api/test/migrations.test.ts` for your tables;
  - `apps/api/test/settlement/stakes-*.test.ts`, and your tests under `apps/api/test/{settlement,scheduler,anchor-do,lifecycle}/**` except `lifecycle/void.test.ts` (W6-D);
  - `e2e/tests/stakes-settle.test.ts` (D adds it as a Stack step);
  - the Stakes rows of `docs/bundle-format.md`, only if they must change (a note for Z), and `docs/sessions/W6-A.md`.
- Must not touch:
  - W6-B's `apps/signer/**`, `apps/api/src/{stakes,personhood}/**`, `routes/stakes.ts`, `apps/api/test/{stakes,personhood}/**` and migration `0012`;
  - W6-C's design files and `packages/shared/src/copy/**`;
  - W6-D's `lifecycle/void.ts`, `indexer/handlers.ts`, `routes/{rounds,claims,entries}.ts`, `read/**`, migration `0013`, and the registry files: `apps/api/src/{app,env,index}.ts`, `routes/index.ts`, `wrangler.jsonc`, `.github/workflows/*`, root and `e2e/` `package.json`, `pnpm-lock.yaml`, `e2e/stack/**`. Put registrations, bindings, vars and any `void.ts` change in "Notes for D";
  - `contracts/**` (the audit candidate; never), `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- `wave-6.md` "Pinned interfaces", safe-head input: `chain/safe-head.ts` exports `closeBlockFor(closesAt)` and `safeHeadPast(block)`; they back `settlement/safe-head.ts` `safeHeadReady(env, roundId, mode)`, which SettlementDO awaits. Read models are W6-D's.
- `applyStakes(env, result)` with `TallyResult` (`settlement/types.ts`). The bundle format (`docs/bundle-format.md`, `bundleFormat` 1, `closeBlock` for Stakes); `bundleHash` stays identical across retries.
- `registerHandler(event, name, fn, opts?)` (`indexer/handlers.ts`): export your registrations for D, and keep handler names stable.
- `OperatorTxResult` (`cancelled`, `pending.nonceTaken`) in `chain/operator.ts`. `OPERATOR_KEY` only in `chain/operator.ts`, `ANCHOR_KEY` only in AnchorDO (wave-4 pins). P2.4 DO signatures in `do/types.ts`; a change needs a note for Z.

## Tasks
1. Create the worktree (above).
2. The safe head (`chain/safe-head.ts`) behind `safeHeadReady`, `ALERT_SAFE_HEAD_LAG` at beacon + 60 s, and `closeBlock` in the Stakes manifest.
3. Ingestion: store each `Entered` ciphertext in `entries.ciphertext` (`prepare` throws without it). A re-add after a block move updates the block fields (today the (tx, logIndex) idempotency keeps the old ones). A removed `Entered` is un-counted (`StakesEntryEvent` has no `removed`; the handler only logs `stakes_entry_removed`).
4. Streaming and reconciliation between close and the beacon, per the Objective, through `BASE_RPC_URL_FALLBACK` and `ALERT_SETTLEMENT_FAILED` (ALERT-1). Mind RPC log-range limits.
5. `applyStakes`: the proposal per the Objective. A retry checks the onchain status first. Nothing posts while `settlement_holds` has an open hold.
6. The handlers in `indexer/handlers/stakes.ts`. Effects outside D1 are at least once. A vetoed refund proposal returns the mode to `revealing` and it settles again; `RoundFinalized` sets `final_at` and writes `payouts`.
7. W2-Z: a foreign entry has no `user_id`, but `payouts.user_id` is NOT NULL. Keep its payout only in the tree and bundle, or make the column nullable in `0011`. Decide, test it, and say which in the handoff.
8. `finalize` at `claimsOpenAt`, and `refundTooFew` / `refundTimeout` when due.
9. One owner of the `OPERATOR_KEY` nonce for `createRound` (cron), `voidRound` (RoundDO alarm) and `propose` / `finalize` (indexer), built on W5-F1's `chain/{tx,operator}.ts` and the tick's cancellation sweep. In the same work, a `pending` without `nonceTaken` after a re-sign refused at close becomes an indefinite answer (the void receipt lag).
10. AnchorDO: keep a failed commit open until the chain has passed beacon time (`expire` and the pre-send check), so `failed` is final when `anchoredCommitment` reads it (S5). Resubmit a confirmed manifest anchor that a reorg removes, for both modes, as W4-F1 did for `Locked` / `Committed`.
11. `e2e/tests/stakes-settle.test.ts`.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required:
  - SET-1b (rules 5 and 6); ALERT-1 (a reconciliation mismatch retries on the fallback, alerts, and posts nothing); ALERT-3;
  - a local-stack Stakes round proposes, and the contract-derived amounts equal settle's (NFR-4 part), in `stakes-settle.test.ts`;
  - a veto of a refund proposal returns the mode to `revealing`, and it settles again;
  - `propose` retries don't double-post (NFR-6, Stakes);
  - each carry-over fix with a test that fails without it: block fields on a re-add, un-counting, stored ciphertexts, S5, manifest resubmission (both modes), two operator sends never sharing a nonce, the indefinite receipt-lag answer, and the foreign-entry payout.
- Stack: `pnpm stack:up`, `pnpm --filter @flocked/e2e exec vitest run tests/stakes-settle.test.ts`, `pnpm stack:down`. You can reuse `POST /__test/rounds/scheduled`, the cron driver, `GET /__test/rounds/:id`, `GET /__test/bundles/:id/:mode/:file`, and `e2e/tests/free-settle.test.ts`'s pattern.
  - An `Entered` with no `stakes_tickets` row is a foreign entry and holds the settlement, so the seam records the test's tickets.
  - The escrow's ticket-signer key is in `e2e/stack/.run/ticket-signer.dev.vars` (`TICKET_SIGNER_KEY`, written by `stack:up` since W5-Z; never in the API's `.dev.vars`). Sign the test's tickets with it directly; W6-B's signer Worker isn't on the stack until W6-D.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- A Stakes round on the local stack streams, reconciles, waits for the safe head, proposes, and reaches `settled` through `finalize`, with payouts in D1.
- The listed tests pass, and SET-1b (5, 6), ALERT-1 (Stakes), ALERT-3, NFR-4 (part) and NFR-6 (Stakes) are named with their tests in the handoff. The handoff is written.

## Constraints
- Never commit secrets; tests generate keys.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W6-A.2`).

## End of session
1. Commit, then `git push -u origin w6-a-stakes-settlement`.
2. Write `docs/sessions/W6-A.md` from plan.md 3.2. Put the handler registrations, bindings, vars, the stack test and any `lifecycle/void.ts` change under "Notes for D and Z". Commit and push.
3. End with your status and: "When W6-A, B and C all report complete, start W6-D from `docs/prompts/W6-D.md`."
