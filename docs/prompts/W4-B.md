# Session W4-B: Chain indexer

**Role:** build. **Size:** M. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-4.md`: the intro, "Pinned interfaces", "W4-B", and the W4-B and "All" items of "Carry-over from W2-Z" and "Carry-over from W3-Z".
- `docs/sessions/W3-Z.md` (wave-3 summary). Then `e2e/stack/README.md` (the local stack: anvil on port 18545 by default, with real `FlockedEscrow`/`FlockedAnchor` deployments recorded in `e2e/stack/.state.json`).
- Code you build on: `apps/api/src/do/{types,indexer-do}.ts` (P2.4), `apps/api/src/lib/**` (`alert`, logger, clock), `apps/api/migrations/0001_init.sql` (`indexer_state`, `anchors`, `entries` and its foreign-entry columns), `packages/abi` (event ABIs, `addressesFor`), `packages/shared/src/alerts.ts`, `contracts/src/{FlockedEscrow,FlockedAnchor}.sol` (events; read only).
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "Architecture"                     # row Chain indexer only
  pnpm spec "Data model"                       # rows indexer_state, anchors, entries only
  pnpm spec "Round lifecycle"                  # the Stakes rows of the table
  pnpm spec "Identity and personhood" --sub "Entry tickets (Stakes)"   # the Entered-mapping bullets
  pnpm spec "Non-functional requirements"      # "Alerts" only
  ```
  Changed in wave 3 (Decision log, Oct 9, 2026): "Data model" (`users.handle` nullable, `daily_grant_skips`). Nothing in your sections changed in substance.

## Objective
Build the chain indexer:
- A cron runs every minute. From `closesAt` − 5 min until the round's proposals confirm, IndexerDO alarms also poll every few seconds.
- It mirrors every `FlockedEscrow` and `FlockedAnchor` event into `chain_events`.
- It handles reorgs through `indexer_state`: on a block-hash mismatch, re-index from 5 blocks back.
- It dispatches each event to its handlers through a registry.
- It also owns `sent_txs` and `recordSentTx`, so ALERT-8 can flag events from transactions the backend didn't send.

## Starting point
- Base: tag `wave-3`. Branch: `w4-b-indexer`. Worktree: `../flocked-w4-b`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w4-b -b w4-b-indexer wave-3
  cd ../flocked-w4-b && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/indexer/**` (the handler registry, but not the lifecycle registrations W4-D adds), `apps/api/src/do/indexer-do.ts`, `apps/api/migrations/0006_*.sql`, `apps/api/test/indexer/**`;
  - anvil-backed tests in `e2e/tests/indexer-*.test.ts`;
  - `docs/sessions/W4-B.md`.
- Must not touch:
  - `apps/api/src/chain/**`, `apps/api/src/scheduler/**`, `apps/api/src/do/anchor-do.ts` (W4-A);
  - `apps/api/src/do/round-do.ts`, `apps/api/src/lifecycle/**` (W4-D);
  - `contracts/**` (W4-C);
  - the registry files: `apps/api/src/{app,env,index}.ts`, `apps/api/wrangler.jsonc`, `.github/workflows/*`, root `package.json`, `e2e/package.json`;
  - `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- `wave-4.md` "Pinned interfaces":
  - `chain_events` (migration `0006`) has the columns chain_id, contract, block_number, block_hash, tx_hash, log_index, event, args_json, removed;
  - `apps/api/src/indexer/handlers.ts` is a registry of `(eventName) → handler(evt, env)`;
  - `recordSentTx(env, {chainId, txHash, kind, roundKey})` lives in `src/indexer/sent.ts`, with the `sent_txs` table in `0006`.
- P2.4 `IndexerDO` signatures.

## Tasks
1. Create the worktree (above).
2. `0006`: `chain_events` (unique on chain, tx hash and log index) and `sent_txs`.
3. Indexer core:
   - range polling within RPC log-range limits;
   - reorg detection and replay;
   - `removed` handling;
   - idempotent handler dispatch, so replaying a range never applies a handler twice.
4. IndexerDO's fast-poll window and alarm schedule. Also the cron entry, as a function W4-D registers.
5. Foreign entries (Carry-over from W2-Z): an `Entered` event with no matching ticket is stored with `user_id` NULL and the foreign flag. It raises `ALERT_FOREIGN_EVENT` and holds that round's settlement for the guardian. Log and alert only; the response is manual.
6. ALERT-4 (lag over 150 s) and ALERT-8 (an event from a transaction the backend didn't send).
7. Put the anvil-backed reorg test (`anvil_reorg`, or snapshot and revert) in `e2e/tests/indexer-*.test.ts` against the local stack. Unit tests mock the RPC so `pnpm check` needs no Docker. List the stack tests under "Notes for D".

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22). Run the stack tests locally with `pnpm stack:up` and `pnpm --filter @flocked/e2e exec vitest run tests/indexer-*.test.ts`, then `pnpm stack:down`.
- Required:
  - PIPE-3: a reorg replayed on anvil.
  - ALERT-4 and ALERT-8.
  - A foreign `Entered` is stored and alerted.
  - Handler dispatch is idempotent across a replay.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Every escrow and anchor event on the stack's anvil shows up in `chain_events`, and a reorg is repaired.
- PIPE-3, ALERT-4 and ALERT-8 are named with their tests in the handoff.
- The handoff is written.

## Constraints
- Never commit secrets. RPC URLs come from env (`BASE_RPC_URL`, `BASE_RPC_URL_FALLBACK`); locally they come from the stack.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W4-B.2`).

## End of session
1. Commit, then `git push -u origin w4-b-indexer`.
2. Write `docs/sessions/W4-B.md` from plan.md 3.2. Put cron registration, env vars, the `src/index.ts` dispatch and the stack tests for D under "Notes for D and Z". Commit and push.
3. End with your status and: "When W4-A, B and C all report complete, start W4-D from `docs/prompts/W4-D.md`."
