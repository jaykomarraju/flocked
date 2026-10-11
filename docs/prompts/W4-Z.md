# Session W4-Z: Consolidate wave 4

**Role:** consolidate. **Size:** M (18 spec issues across the four handoffs, the audit tag and the audit hand-off). **Model:** Opus 5.5.

## Read first

- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.3 (Wave summary template), 3.4 (Z checklist), 4 (Global conventions) and 6 (Owner actions and launch gates, only OA-20, OA-21, OA-D2, OA-D3, OA-04). Read nothing else in `plan.md` until a step needs it.
- `docs/plan/wave-4.md`: "Pinned interfaces", the "W4-Z checklist" and both "Carry-over" sections.
- The four handoffs on `w4-integration`: `docs/sessions/W4-A.md`, `W4-B.md`, `W4-C.md`, `W4-D.md`.
- `docs/plan/traceability.md` (rows PIPE-2, PIPE-3, SET-1b, AC-6, ALERT-2, ALERT-4, ALERT-6, ALERT-8, CON-7, CON-8, CON-9, CON-12).
- `docs/plan/wave-5.md`, to draft the next prompts. `docs/audit/package.md`, to hand to the owner.
- `e2e/stack/README.md` (the cron driver, the seam routes and the stack tests).
- Spec sections only when an owner decision needs editing, loaded with `pnpm spec "<heading>"` (Node 22: `nvm use` first).

## Objective

Review wave 4 on `w4-integration`, get the owner's decisions on the open spec issues, and merge into `main`. Then:

- tag `audit-candidate-1` on the merge commit and tell the owner the audit package is ready (OA-20);
- update the plan files and write the wave summary;
- emit the wave-5 prompts and tag `wave-4`.

No features.

## Starting point

- Base: `w4-integration`, pushed. W4-D's code head is in `W4-D.md`, with the handoff and this prompt on top. The CI and Stack runs are listed in `W4-D.md`.
- Worktree:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w4-z w4-integration
  cd ../flocked-w4-z && nvm use
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
- The stack needs OrbStack running and Foundry on `PATH`. If you make fixes, commit them on `w4-integration`.

## Scope and file ownership

- May create or edit:
  - `Product_Spec.md`: only the sections the owner's decisions change, plus the Decision log;
  - `plan.md`: Status, 4.3, 4.6, 6, and anything a decision changes;
  - `docs/plan/*`, `docs/sessions/W4-Z.md` and `docs/prompts/W5-*.md`;
  - small fixes (< 50 lines, no new behaviour) anywhere needed to get green.
- Must not:
  - touch `contracts/src` at all: it is the audit candidate (`36d115c`);
  - add features, or change pinned interfaces without an owner decision. Larger fixes become `W4-F{k}` (plan.md 2.6).

## Pinned interfaces

- P2.4 and the wave-4 pinned interfaces (`chain_events`, the `handlers.ts` registry, `OPERATOR_KEY` only in `chain/operator.ts`, `ANCHOR_KEY` only in the AnchorDO). Compare them with what was built:
  - **W4-A:** `operator_txs`; AnchorDO test-only fields.
  - **W4-B:** extra `chain_events` columns; `registerHandler(event, name, fn)` with an optional third `ctx`.
  - **W4-C:** the ABI changes `GuardianReplaced(previous, newGuardian)` and `GuardianTransferred` on admin replacement.
  - **W4-D:** no new RPC methods; RoundDO test-only fields `beforeEntryBatch` and `operatorDeps`; the stack cron goes through `POST /__test/cron`, not `--test-scheduled`.

## Tasks

1. **plan.md 3.4 steps 1–3:**
   - all four handoffs must be `complete`;
   - `git diff --stat main...w4-integration`;
   - read full diffs only where a handoff flags risk:
     - W4-A: `src/do/anchor-do.ts` (`process`, `applyReceipt`, `checkOnchain`), `src/chain/operator.ts` (`runOperatorTx`), `src/rounds/grant.ts`;
     - W4-B: `src/indexer/core.ts` (`applyRange`, `forkPoint`), `src/indexer/dispatch.ts`;
     - W4-D: `src/do/round-do.ts` (`runVoid`, `resolveVoidAtClose`, `applyVoid`, `adoptVoidedModes`, `eventFailed`), `src/lifecycle/{void,handlers}.ts`.
   - Run:
     - `pnpm install --frozen-lockfile && pnpm check`;
     - `(cd contracts && FOUNDRY_PROFILE=ci forge test)` (about 4 min);
     - `pnpm stack:up`, then `pnpm --filter @flocked/e2e exec vitest run` (all four stack files, one at a time, about 2.5 min), then `pnpm stack:down`.
   - Confirm `gh run list --branch w4-integration` shows CI (now four jobs, with `static-analysis`) and Stack green.
2. **W4-Z checklist:**
   - PIPE-2, PIPE-3, SET-1b (rule 4) and the detection halves of ALERT-2/4/6/8 must be proven by the tests the handoffs name.
   - Update `docs/plan/traceability.md`:
     - PIPE-2 ✅, PIPE-3 ✅;
     - SET-1b 🟡 (rule 4 done; 5 and 6 are W6-A, 7 and 8 W5-D);
     - AC-6 🟡 (first half: `test/lifecycle/free-anchor.test.ts` and `e2e/tests/lifecycle-open-close.test.ts`; the receipt half is W11-B);
     - ALERT-2/4/6/8: detection proven; paging stays W13-A.
     - Note W4-C's invariant strengthening on CON-7/8/9/12.
3. **Spec issues.** Raise them with the owner via AskUserQuestion, recommendation first, batched by area:
   - **Scheduler and anchoring (W4-A, 6):**
     - the points-farming reading (verified Farcaster, or a verified wallet with nonce > 0 or code);
     - `nonDefaultAuditId` in the locked config (W12);
     - the house-question backlog status (`queued` → `used`);
     - an alert for a Free lock leaf that never lands;
     - `operator_txs` in the data model;
     - Stakes voided when `createRound` misses `opensAt`.
   - **Indexer (W4-B, 4):**
     - the data-model rows for `chain_events`, `sent_txs`, `chain_event_handled` and `settlement_holds`;
     - ALERT-8 wording: role-only events only, plus a reason-4 `RoundRefunded`;
     - the guardian's release of a settlement hold (admin action plus audit log);
     - the fast-polling bound (closesAt + 2 h; Free-only rounds don't fast-poll).
   - **Contracts (W4-C, 3):**
     - the wrong-tree residual risk (the watcher recomputes the tree);
     - a "USDC issuer" residual risk (a blocklisted entrant, a frozen escrow);
     - `getRoleAdmin(GUARDIAN_ROLE)` (no change recommended).
   - **Lifecycle (W4-D, 5):**
     - when an unconfirmed void is abandoned (chain head ≥ closesAt, or 20 s past it);
     - Free rule-4 refunds written at void confirmation;
     - the guardian-void "notify" (W9-A) and ticket refusal (W6);
     - a reorged-out void alerts only;
     - the admin void's audit row (W12).

   Apply the decisions to the spec and the Decision log. Anything that changes code beyond a small fix goes into wave 5 (or a `W4-F{k}`).
4. **Plan fixes from the handoffs:**
   - §4.3: the stack-test command, and `pnpm stack:status` now has a `cron` row;
   - §4.6: the `static-analysis` CI job (slither 0.11.6, aderyn 0.6.8, NatSpec), and the Stack job's four steps;
   - §4.2: aderyn comes from npm (`@cyfrin/aderyn`).

   Record the open issues as carry-over in later wave files:
   - **W6-A:** the rest of Stakes ingestion (including un-counting a reorged `Entered`), the proposal, veto, refund and finalize handlers, and a serialised operator nonce;
   - **W9-A:** void and refund notifications;
   - **W12:** the admin void route with an audit row, and `nonDefaultAuditId`;
   - **W13/W14:** a fee cap in `TxSender`, and orphan `anchors` rows;
   - **wave 5:** `settlementHold` before posting, and `onModeResult` calls;
   - **W14-A:** re-confirm the CREATE2 factory.

   If Ubuntu 26 broke the Stack job after Oct 19, pin `ubuntu-24.04`.
5. **Merge (plan.md 3.4 step 6):**
   - `main` ← `w4-integration` with `--no-ff`, and push.
   - Tag `audit-candidate-1` on that merge commit and push the tag. Check that `git diff 36d115c audit-candidate-1 -- contracts/src` is empty (W4-C).
   - Delete `w4-a-scheduler`, `w4-b-indexer`, `w4-c-audit-prep` and `w4-integration` (local and remote), and the worktrees `../flocked-w4-{a,b,c,d}`.
   - Tag `wave-4` on `main` only after the summary and the wave-5 prompts are committed (steps 6 and 8).
6. **Plan files:** update `plan.md` Status, `docs/plan/traceability.md`, and any later wave file whose plan changed. Write `docs/sessions/W4-Z.md` from plan.md 3.3.
7. **Owner actions:**
   - **OA-20:** the audit package is ready. Give the owner `docs/audit/package.md` (with `threat-model.md` and `static-analysis.md`) and the tag `audit-candidate-1`. The auditor isn't booked yet, and the report is needed before W15.
   - Optionally, add `static-analysis` to the required checks in the `main` ruleset (OA-03).
   - Remind them of OA-D2 (core-flow review, needed by W9), OA-21 (ToS and privacy text by W12), OA-D3 (after W5-C) and OA-04 (Workers Paid, by W10), plus anything due in waves 5–6.
8. **Wave-5 prompts:** emit them from `docs/plan/wave-5.md` and plan.md 3.1, pointing at `docs/sessions/W4-Z.md`.
   - Migrations reserved for wave 5: W5-A `0008`, W5-B `0009`, W5-D `0010`. `0007` was not used.
   - Name any spec sections changed this wave.
   - Wave 5's stack tests can reuse `POST /__test/rounds/scheduled` and the cron driver.

## Tests and checks

- `pnpm install --frozen-lockfile && pnpm check` green on `w4-integration` before merging, and on `main` after.
- `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green, and every stack test green locally.
- CI and Stack green on `w4-integration`, and on `main` after the push.
- No test is skipped, deleted or weakened without a line in `W4-Z.md` with the reason.

## Definition of done

- `main` contains wave 4, tagged `wave-4`, with CI and Stack green. The audit candidate is tagged `audit-candidate-1`, and the owner has the package. The wave branches and worktrees are removed.
- The traceability rows for wave 4 are updated. The owner's decisions are in the spec with Decision log rows, and the plan files are updated.
- `docs/sessions/W4-Z.md` is written, and the wave-5 prompts are saved, committed and printed.

## Constraints

- Never merge a red wave (plan.md 2.6). Fixes over ~50 lines, or with new behaviour, go to a `W4-F{k}` session, with a `W4-Z.2` prompt to run after it.
- Never commit secrets (`e2e/stack/.dev.vars` and `.state.json` are gitignored). Don't fake owner actions or launch gates. Booking the auditor is the owner's.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6.

## End of session

1. Commit, and push `main` and `audit-candidate-1`.
2. Write `docs/sessions/W4-Z.md` (plan.md 3.3), then commit and push it.
3. Save every wave-5 prompt to `docs/prompts/W5-{X}.md` and commit and push them. Then tag `wave-4` on `main` and push the tag.
4. Print each prompt in its own fenced block. Say which run in parallel, and that the owner starts each in a fresh session.
