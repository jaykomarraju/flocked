# Session W5-Z: Consolidate wave 5

**Role:** consolidate. **Size:** M (about 40 spec issues across five handoffs, W4-F1's closure, the audit status). **Model:** Opus 5.5.

## Read first

- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.3 (Wave summary template), 3.4 (Z checklist), 4 (Global conventions) and 6 (Owner actions and launch gates; only OA-04, OA-09, OA-17, OA-20, OA-21, OA-22, OA-D2, OA-D3, OA-D4). Read nothing else in `plan.md` until a step needs it.
- `docs/plan/wave-5.md`: "Pinned interfaces", the "W5-Z checklist" and every "Carry-over" section. `docs/plan/wave-4.md` "W4-F1".
- The five handoffs on `w5-integration`: `docs/sessions/W5-A.md`, `W5-B.md`, `W5-C.md`, `W4-F1.md`, `W5-D.md`. Also `docs/sessions/W4-Z.md` (the wave-4 summary).
- `docs/plan/traceability.md`: rows PIPE-4, ID-2, ID-3, SET-1b, SET-4, NFR-6, NFR-8, ALERT-1, ALERT-5, plus every row W4-F1's handoff names.
- `docs/plan/wave-6.md`, to draft the next prompts. `docs/bundle-format.md` and `e2e/stack/README.md`.
- Spec sections only when an owner decision needs editing, loaded with `pnpm spec "<heading>"` (Node 22: `nvm use` first).

## Objective

Review wave 5 and W4-F1 on `w5-integration`, get the owner's decisions on the open spec issues, and merge into `main`. Then:

- confirm W4-F1's 22 items are closed;
- confirm the audit candidate is untouched, and record the audit status (OA-20);
- update the plan files and write the wave summary;
- emit the wave-6 prompts and tag `wave-5`.

No features.

## Starting point

- Base: `w5-integration`, pushed.
  - W5-D's code head is `6957500`, and its CI and Stack runs are listed in `W5-D.md`.
  - The handoff and this prompt sit on top.
- Worktree. W5-D's worktree `../flocked-w5-d` has `w5-integration` checked out. Work there, or remove it first (`git worktree remove`, which works on a clean worktree), then:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w5-z w5-integration
  cd ../flocked-w5-z && nvm use
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
- The stack needs OrbStack running and Foundry on `PATH`. If you make fixes, commit them on `w5-integration`.

## Scope and file ownership

- May create or edit:
  - `Product_Spec.md`: only the sections the owner's decisions change, plus the Decision log;
  - `plan.md`: Status, 4.3, 4.6, 6, and anything a decision changes;
  - `docs/plan/*`, `docs/sessions/W5-Z.md` and `docs/prompts/W6-*.md`;
  - `docs/bundle-format.md`, but only if the owner changes the bundle format (spec issue W5-D 1);
  - small fixes (< 50 lines, no new behaviour) anywhere needed to get green.
- Must not:
  - touch `contracts/src`, which is the audit candidate;
  - add features, or change pinned interfaces without an owner decision. Larger fixes become `W5-F{k}` (plan.md 2.6).

## Pinned interfaces

Compare `wave-5.md` "Pinned interfaces" with what was built:

- **W5-A:**
  - the apply hooks take `(env, result)`, not `(result)`;
  - `refundFree(env, roundId, 7 | 8)` was added;
  - `SettlementPhase` has no `held`, so a held job is `applying` with `error: "held:<reason>"`;
  - `docs/bundle-format.md` pins `bundleFormat` 1.
- **W5-B:**
  - `stakesEligibility(env, user: Pick<SessionUser,'id'>, request, opts?)`;
  - the shared enum was renamed to `INELIGIBLE_REASONS` and widened, so `MeResponse.stakes.reasons` is wider.
- **W5-D:** `applyFree` and `refundFree` take an optional `deps` (`FreeApplyDeps`).
- **W4-F1:**
  - `OperatorTxResult` gains `cancelled`, and `pending` gains `nonceTaken`;
  - `TxSender.check(tx, label, opts?)`;
  - `registerHandler(event, name, fn, opts?)`;
  - `IndexerRpc.code`;
  - `ANCHOR_SINGLETON` moved to `src/chain/client.ts`.

## Tasks

1. **plan.md 3.4 steps 1–3:**
   - All five handoffs must be `complete`.
   - Run `git diff --stat main...w5-integration`.
   - Read full diffs only where a handoff flags risk:
     - W5-A: `src/do/settlement-do.ts` (the phase machine; the alarm vs `chunkDone`), `src/settlement/prepare.ts` (the anchored set and root check);
     - W5-B: `src/personhood/verify.ts` `bindStatements`, the `DELETE` in `src/auth/accounts.ts` `createAccount`, and `src/routes/me.ts` `meView`;
     - W4-F1: `src/chain/tx.ts` `check`, `src/chain/operator.ts` `cancelOperatorTx`, `src/do/anchor-do.ts` `applyReceipt` and `recheckConfirmed`, `src/lifecycle/void.ts` `voidAbandonable`, `src/indexer/{dispatch,core}.ts`, and the `0007` trigger;
     - W5-D: `src/settlement/apply/free.ts` (the json_each SQL and the credit-by-inserted-rows upsert), `anchor-do.ts` `writeConfirmations`, and `src/local/seam.ts`.
   - Run:
     - `pnpm install --frozen-lockfile && pnpm check`;
     - `pnpm format:check`;
     - `(cd contracts && FOUNDRY_PROFILE=ci forge test)` (about 4 min);
     - `pnpm stack:up`, then `pnpm --filter @flocked/e2e exec vitest run` (five files, one at a time, about 5.5 min), then `pnpm stack:down`.
   - Confirm that `gh run list --branch w5-integration` shows CI (four jobs) and Stack (five test steps) green.
2. **W4-F1 closure.** Check each of V1–V3, T1–T4, N1–N4 and I1–I11 against the test that `W4-F1.md` names for it, and that the test passes. List any item not closed as carry-over, or as a `W5-F{k}` if it is a defect.
3. **Audit candidate and OA-20:**
   - `git diff audit-candidate-1 HEAD -- contracts/src` must be empty, on `w5-integration` and again on `main` after the merge;
   - ask the owner whether an auditor is booked and when the report is expected (it is needed before W15), and record the answer in `plan.md` Status and OA-20.
4. **W5-Z checklist (`wave-5.md`):**
   - Prove PIPE-4, ID-2, ID-3, SET-1b (rules 7 and 8), SET-4 (pipeline), NFR-6 (settlement and apply), and the detection halves of ALERT-1 and ALERT-5, by the tests the handoffs name.
   - Update `docs/plan/traceability.md`. SET-1b stays 🟡 (rules 5 and 6 are W6-A). ALERT-1/5 paging stays W13-A. W5-A's `ALERT_BEACON_LATE` has no ALERT-n row; decide whether to add one.
   - Ask the owner to review Social and Settings in Paper (OA-D3, needed before W11).
   - Reserve the wave-6 migrations: W6-A `0011`, W6-B `0012`, W6-D `0013`. W5-D used no `0010`; leave it unused.
5. **Spec issues.** Raise them with the owner via AskUserQuestion, recommendation first, batched by area:
   - **Settlement (W5-A 7, W5-D 5):**
     - the VOID order (`not_anchored`, then `stake_out_of_range`, then checks 1–5);
     - decrypt batches of 500 vs bundle chunks of 5,000;
     - "receipt fields", not signatures, in Free chunks;
     - `settlement_holds` reason `void_rate` for either mode;
     - refunded payout trees (Free has a tree; refunded Stakes has none; the award is not a leaf);
     - `DRAND_RELAYS`;
     - an ALERT row for `ALERT_BEACON_LATE`;
     - no bundle for modes refunded before reveal (rules 4, 7, 8). This touches the bundle format and Archival;
     - the Free meaning of `settlements.tally_json`, `winners_json` and `tx_hash`;
     - payouts rows for rule 4 vs rules 7 and 8;
     - `revealed_at` set for rules 1–3;
     - the alerts for the points mismatch and an undeliverable RoundDO result.
   - **Personhood (W5-B 9):**
     - the Coinbase API assumptions (gate 2, OA-22);
     - the `config` and `person_tombstones` tables;
     - pending-merge and OAuth-state TTLs;
     - country-level geo matching;
     - the proxy signals (Tor, a bot score below 30);
     - a `geo.stakes.age21` key;
     - `ATTESTATION_RPC_URL` in "Environments";
     - binding a person ID with no personal details.
   - **Design (W5-C 9):**
     - the "Questions" header link;
     - Strays today vs Streaks;
     - round detail with both modes;
     - the Archive row's mode;
     - Verify on another device;
     - the destructive confirm;
     - whether `security_notice` can be turned off;
     - the mobile You sheet;
     - the kit inconsistencies (OA-D1).
   - **Indexer, void and chain (W4-F1, about 10):**
     - the Data model rows (`indexer_checkpoints`, `chain_event_removals`, `dispatch_alerted_at`, `operator_txs` `cancelled`, the re-index rule, a changed slot as removal plus revision + 2);
     - the alert wording (head age in lag, the repeating stuck-entry alert, the constructor exemption, a void that can't confirm);
     - the "definitely" wording in Void, and the grace applying only on the local stack;
     - naming `TX_MAX_FEE_GWEI` and the cancellation of abandoned operator transactions.

   Apply the decisions to the spec and the Decision log. Anything that changes code beyond a small fix goes into wave 6 (or a `W5-F{k}`). Name the changed sections in the wave-6 prompts.
6. **Plan fixes from the handoffs:**
   - §4.3: the stack tests now include `free-settle` (about 5.5 min for all five), and `stack:status` has `coinbase` and `eas` rows;
   - §4.6: the Stack job's five steps.

   Record the open issues as carry-over in later wave files:
   - **W6-A:**
     - `safeHeadReady` and `closeBlock`;
     - Stakes ciphertexts in `entries.ciphertext`;
     - `applyStakes`;
     - a re-added entry with new block fields, and un-counting a removed one (W4-F1);
     - resubmitting a reorged manifest anchor;
   - **W6-B:**
     - `stakesEligibility(…, { attestationMaxAgeMs: 0 })` and the per-round checks;
     - whether the entering wallet must hold the attestations;
   - **W6-C / W9-A:** the Free outcome's cards and notifications (`applyFree` and `refundFree` are where those calls go);
   - **W7-B:** `person_tombstones` on deletion, coinbase merge confirmation, refusing to unlink coinbase, and `profile.ts` `stakesReasons`;
   - **W8:** room `qualifies` flags;
   - **W11-A:** `config` edits with an `audit_log` row;
   - **W13:** retention of `settlement/` working files and pre-reveal-refund ciphertexts; the throughput of 25 entries per dispatch; per-environment `TX_MAX_FEE_GWEI`; `PERSON_ID_KEY` in the secrets runbook; a load test of reduce plus apply at 100k;
   - **later:** a personhood stack test.
7. **Merge (plan.md 3.4 step 6):**
   - `main` ← `w5-integration` with `--no-ff`, then push.
   - Delete `w5-a-settlement`, `w5-b-personhood`, `w5-c-design`, `w4-f1-review-fixes` and `w5-integration` (local and remote), and the local-only `w4-f1-indexer`.
   - Remove the worktrees `../flocked-w5-{a,b,c,d}`, `../flocked-w4-f1` and `../flocked-w4-f1-idx`.
   - Tag `wave-5` on `main` only after the summary and the wave-6 prompts are committed (steps 8 and 10).
8. **Plan files:** update `plan.md` Status, `docs/plan/traceability.md`, and any later wave file whose plan changed. Write `docs/sessions/W5-Z.md` from plan.md 3.3.
9. **Owner actions:**
   - **OA-20:** the audit status (step 3). Booking is the critical path for W15.
   - **OA-D3:** Social and Settings in Paper.
   - **OA-D2:** the core flow, needed by W9.
   - **OA-D4:** share cards and notifications after W6-C, needed by W10.
   - **OA-09:** the Coinbase OAuth app and the redirect URI `${APP_ORIGIN}/api/v1/me/personhood/callback`, started by W8.
   - **OA-22:** confirm the `/v2/user/personal-details` shape (gate 2).
   - **OA-21:** legal text, needed by W12.
   - **OA-04:** Workers Paid, started by W10.
   - **OA-17:** the multisigs, started by W10.
10. **Wave-6 prompts:** emit them from `docs/plan/wave-6.md` and plan.md 3.1, pointing at `docs/sessions/W5-Z.md`.
    - Migrations: W6-A `0011`, W6-B `0012`, W6-D `0013`.
    - Name every spec section changed this wave.
    - Stack tests can reuse `POST /__test/rounds/scheduled`, the cron driver, `GET /__test/bundles/...` and `e2e/tests/free-settle.test.ts`'s pattern.

## Tests and checks

- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green on `w5-integration` before merging, and on `main` after.
- `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green, and every stack test green locally.
- CI and Stack green on `w5-integration`, and on `main` after the push.
- `git diff audit-candidate-1 HEAD -- contracts/src` empty.
- No test is skipped, deleted or weakened without a line in `W5-Z.md` with the reason.

## Definition of done

- `main` contains wave 5 and W4-F1, tagged `wave-5`, with CI and Stack green. The wave branches and worktrees are removed.
- W4-F1's items are confirmed closed, the audit candidate is confirmed unchanged, and the audit status is recorded in Status and OA-20.
- The traceability rows for wave 5 are updated. The owner's decisions are in the spec with Decision log rows, and the plan files are updated.
- `docs/sessions/W5-Z.md` is written, and the wave-6 prompts are saved, committed and printed.

## Constraints

- Never merge a red wave (plan.md 2.6). Fixes over ~50 lines, or with new behaviour, go to a `W5-F{k}` session, with a `W5-Z.2` prompt to run after it.
- Never commit secrets (`e2e/stack/.dev.vars` and `.state.json` are gitignored). Don't fake owner actions or launch gates. Booking the auditor is the owner's.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6. Subagents may take the diff reviews and the spec edits.

## End of session

1. Commit, and push `main`.
2. Write `docs/sessions/W5-Z.md` (plan.md 3.3), then commit and push it.
3. Save every wave-6 prompt to `docs/prompts/W6-{X}.md`, then commit and push them. Then tag `wave-5` on `main` and push the tag.
4. Print each prompt in its own fenced block. Say which run in parallel, and that the owner starts each in a fresh session.
