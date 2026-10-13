# Session W7-Z: Consolidate wave 7

**Role:** consolidate. **Size:** M (about 30 spec issues across five handoffs, the audit status, two Paper reviews, the merge-notice copy). **Model:** Opus 5.5.

## Read first

- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.3 (Wave summary template), 3.4 (Z checklist), 4 (Global conventions) and 6 (Owner actions and launch gates; only OA-04, OA-07, OA-09, OA-17, OA-20, OA-21, OA-22, OA-D1, OA-D2, OA-D3, OA-D5). Read nothing else in `plan.md` until a step needs it.
- `docs/plan/wave-7.md`: "Pinned interfaces", the "W7-Z checklist" and every "Carry-over" section. `docs/plan/wave-6.md` "W6-F1".
- The five handoffs on `w7-integration`: `docs/sessions/W7-A.md`, `W7-B.md`, `W7-C.md`, `W6-F1.md` and `W7-D.md`. Also `docs/sessions/W6-Z.md` (the wave-6 summary).
- `docs/plan/traceability.md`: rows DO-5, ID-1, PIPE-1, E2E-1, E2E-2, E2E-4, E2E-6, E2E-9, E2E-10, E2E-14, AC-1, AC-5, and the rows W6-F1 advances (ID-5, AC-2, AC-4, NFR-6, NFR-7).
- `docs/plan/wave-8.md`, to draft the next prompts. `e2e/stack/README.md` ("The test seam" and "Playwright specs").
- Spec sections only when an owner decision needs editing, loaded with `pnpm spec "<heading>"` (Node 22: `nvm use` first).

## Objective

Review wave 7 and W6-F1 on `w7-integration`, get the owner's decisions on the open spec issues, and merge into `main`. Then:

- confirm the audit candidate is untouched, and record the audit status (OA-20);
- ask the owner to review Admin in Paper (OA-D5) and the Core flow after W7-C's header fix (OA-D2), and confirm OA-D1 is frozen before W8-C;
- update the plan files and write the wave summary;
- emit the wave-8 prompts and tag `wave-7`.

No features.

## Starting point

- Base: `w7-integration`, pushed. W7-D's head and its CI, Stack and E2E runs are listed in `W7-D.md`; the handoff and this prompt sit on top.
- Worktree. W7-D's worktree `../flocked-w7-d` has `w7-integration` checked out. Work there, or remove it first (`git worktree remove`, which works on a clean worktree), then:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w7-z w7-integration
  cd ../flocked-w7-z && nvm use
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
- The stack needs OrbStack running and Foundry on `PATH`. If another local project holds port 8787, start it with `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239` (W7-D's first full run lost its API that way). The wave's other worktrees are `../flocked-w7-{a,b,c}` and `../flocked-w6-f1`.

## Scope and file ownership

- May create or edit:
  - `Product_Spec.md`: only the sections the owner's decisions change, plus the Decision log;
  - `plan.md`: Status, 4.3, 4.6, 6, and anything a decision changes;
  - `docs/plan/*`, `docs/sessions/W7-Z.md` and `docs/prompts/W8-*.md`;
  - `packages/shared/src/copy/notifications.ts`, only for the merge-notice copy the owner approves (step 6);
  - small fixes (< 50 lines, no new behaviour) anywhere needed to get green.
- Must not:
  - touch `contracts/src`, which is the audit candidate;
  - add features, or change pinned interfaces without an owner decision. Larger fixes become `W7-F{k}` (plan.md 2.6).

## Pinned interfaces

Compare `wave-7.md` "Pinned interfaces" with what was built:

- **WS (W7-A):** as pinned. `GET /rounds/:id/ws` → a `RoundViewerDO` shard by FNV-1a(connection ID) mod N; N is `WS_VIEWER_SHARDS` (16 when unset; W7-D added it to `Env` and the `wrangler.jsonc` header). The RoundDO's `broadcast()` seam is `rounds/hooks.ts`. `refunded` gained `provisional` and `finalAt`.
- **Identity (W7-B):** the nine routes live in `routes/me.ts` and `routes/limits.ts` (the pin named `identity.ts`; the prompt said `me.ts`). `AcceptTosRequest.ageAttested` is `18 | 21` and `TosState.ageRequired` is required. `AuthDORpc` was replaced by `AuthDOMethods` (`do/auth-do.ts`). `Env.FARCASTER_HUB_URL?`. Migration `0015`.
- **W6-F1:** migration `0016` (`settlement_holds` takes `refund_vetoed`); the seam route `POST /__test/holds/release`; `ClaimsResponse.roomClaims?`; `StakesLockedConfig.payoutAddress?`; signer `RefusalReason` `expiry_too_far`.
- **e2e harness (W7-D):** Playwright projects `api` and `ui` as pinned, plus `api-warp`, a second phase of `api` that runs the `@warp`-tagged tests after every round they warp exists (anvil's clock can't move back, and the escrow refuses `createRound` past opensAt). Fixtures `stack`, `wallet`, `user`, `clock` in `e2e/fixtures/`. `pnpm e2e` runs `api` and `api-warp`. New stack pieces: the Turnstile siteverify mock (`:8792`, `TURNSTILE_SITEVERIFY_URL`, local only), `holds` in `GET /__test/rounds/:id`, the seam's 404 body equal to the app's.

## Tasks

1. **plan.md 3.4 steps 1–3:**
   - All five handoffs must be `complete`.
   - Run `git diff --stat main...w7-integration`.
   - Read full diffs only where a handoff flags risk:
     - W7-A: `src/ws/snapshot.ts` (reads D1 for status and the result, gated by `revealed_at`), `src/ws/hub.ts`, the RoundDO lines W7-A lists;
     - W7-B: `src/identity/merge.ts` `transferStatements`, `src/identity/delete.ts`, `src/personhood/verify.ts` `bindStatements`;
     - W6-F1: `src/indexer/handlers/stakes.ts` (R2, R3, O1 removal paths), `chain/operator.ts` `newNonce`, `stakes/cap.ts` `indexedThroughSec`, `read/proofs.ts` `liveStakesPayoutIndex`;
     - W7-D: `e2e/playwright.config.ts` (the `api-warp` phase), `e2e/fixtures/{http,clock}.ts`, `apps/api/src/lib/turnstile.ts`, `src/local/seam.ts` (404 body, `holds`, the question category).
   - Run:
     - `pnpm install --frozen-lockfile && pnpm check` (W7-A's `ws/coalescing.test.ts` can fail once under heavy load, a receive-time gap below 900 ms; rerun before calling it red, and decide its hardening from `W7-D.md` "Open issues");
     - `pnpm format:check`;
     - `(cd contracts && FOUNDRY_PROFILE=ci forge test)` (about 4 min);
     - `pnpm stack:up`, then `pnpm --filter @flocked/e2e exec vitest run` (the eight stack files in CI order through the sequencer, about 10 min), then `pnpm stack:down`;
     - on a fresh stack: `pnpm stack:up && pnpm e2e && pnpm stack:down` (about 20 min; `api-warp` leaves anvil 72 h ahead).
   - Confirm that `gh run list --branch w7-integration` shows CI (check, contracts, properties, static-analysis), Stack (eight steps) and E2E green.
2. **Audit candidate and OA-20:**
   - `git diff audit-candidate-1 HEAD -- contracts/src` must be empty, on `w7-integration` and again on `main` after the merge;
   - ask the owner whether an auditor is booked and when the report is expected (needed before W15; still not booked on Oct 12), and record the answer in `plan.md` Status and OA-20.
3. **W7-Z checklist (`wave-7.md`):** prove each row by a named, passing test, and update `docs/plan/traceability.md`:
   - **DO-5:** `apps/api/test/ws/snapshot.test.ts` › "DO-5: a reconnect gets a fresh state" (W7-A);
   - **ID-1:** `apps/api/test/identity/{link,unlink,merge,delete,cap}.test.ts` (W7-B);
   - **PIPE-1 (WS):** `apps/api/test/ws/reveal-gating.test.ts` › "PIPE-1 (WebSocket)…" (cards W10-A and the log scan W13-C stay open);
   - **E2E-1 (API), E2E-2 (API), AC-1 (local):** `e2e/tests/lifecycle.spec.ts` (W7-D names each test);
   - **E2E-4 (API):** `e2e/tests/stakes-claims.spec.ts`; **E2E-6:** `stakes-veto.spec.ts`; **E2E-10:** `stakes-copy.spec.ts`; **E2E-14:** `drand-outage.spec.ts`; **AC-5 (timeout part):** `stakes-timeout.spec.ts`;
   - **E2E-9 (API):** `apps/api/test/limits/limits.test.ts` › "E2E-9 (API): self-exclusion" (the UI half stays W12-D).
4. **W6-F1:** confirm it is merged (`9807464` on `w7-integration`) and that each of R1–R13 and O1–O5 has a named, passing, mutation-checked test: W6-F1's table names the test and the mutations for each. Re-run a sample of its mutation scripts on the merged tree if a merge touched the file (W7-D's merges touched none of W6-F1's source files; W7-B's ticket carry sits beside O2 in `stakes_tickets`).
5. **Spec issues.** Raise them with the owner via AskUserQuestion, recommendation first, batched by area:
   - **WS (W7-A, 3):** `refunded.finalAt` is when the RoundDO learns of it; a refunded mode's snapshot has `result: null`; the Stakes reveal is the confirmed `OutcomeProposed`.
   - **Identity (W7-B, 6):** email codes in AuthDO; `person_tombstones.user_id`; merge confirmation rules; responsible-play edge cases and a maximum cap; rooms owned by a deleted account; an `identity_unlinked` notice. Also W7-B's deviation: suspended accounts may still lower their cap, self-exclude and edit notification prefs (confirm).
   - **Reorgs and holds (W6-F1, 5):** reorged Stakes events undo their D1 effect; a second refund veto reopens the hold; `roomClaims` fields; O2's "processed past expiry" bound (recommend storing the block timestamp in `indexer_state`); the creator and `payoutAddress` at lock.
   - **Admin (W7-C, 10):** the caption weight token; pause = Stakes entries only (and `/prepare` while paused); the streaks pill; the question pipeline gaps; `geo.deny`; dashboard metrics; hold history; RoundDO-down states and admin search; monospace and switch; destructive confirms.
   - **E2E (W7-D):** see `W7-D.md` "Spec issues" (E2E-6's wording vs the deterministic re-proposal, and the others it lists).

   Apply the decisions to the spec and the Decision log. Anything that changes code beyond a small fix goes into wave 8 (or a `W7-F{k}`). Name the changed sections in the wave-8 prompts.
6. **Owner reviews and copy:**
   - **OA-D5:** ask the owner to review the Paper page `Admin` (41 states at desktop and tablet; needed before W12), with W7-C's "Schema gaps for W11-A" and its open questions (config placeholders for OA-21, the Settings "6 of 9 on" count, nav-bar labels, the share-sheet avatar, `screens.md`'s Freeze column).
   - **OA-D2:** ask the owner to review the Core flow after W7-C's header fix (74 tablet and desktop artboards, header only), needed before W9.
   - **OA-D1:** confirm the Components freeze still holds after W7-C's five kit fixes. If it isn't frozen before W8-C starts, W8-C waits and wave 8 runs with A, B and D only.
   - **Merge notices (W7-B):** bring W7-B's copy report to the owner (`merge_pending` goes to whichever account holds the linked identity; W7-B suggests new push and email bodies). Apply the approved copy to `packages/shared/src/copy/notifications.ts`.
7. **Plan fixes from the handoffs:**
   - §4.3: `pnpm e2e` (Playwright, two `api` phases, about 20 min, on a fresh stack); the Turnstile mock (`:8792`) in `stack:up` and `stack:status`; the seam's `holds` and hold release;
   - §4.6: `e2e.yml` (the stack plus `pnpm e2e` on `main` and `w*-integration`, 45-minute timeout, the report and stack logs kept on failure); like Stack, it doesn't run on PRs, so it can't be a required check.

   Record the open issues as carry-over in later wave files (each handoff's "Open issues"; W7-D's list them with an owner session).
8. **Merge (plan.md 3.4 step 6):**
   - `main` ← `w7-integration` with `--no-ff`, then push.
   - Delete `w7-a-ws`, `w7-b-identity`, `w7-c-admin-design`, `w6-f1-review-fixes` and `w7-integration` (local and remote).
   - Remove the worktrees `../flocked-w7-{a,b,c,d}` and `../flocked-w6-f1`.
   - Tag `wave-7` on `main` only after the summary and the wave-8 prompts are committed (steps 9 and 11).
9. **Plan files:** update `plan.md` Status, `docs/plan/traceability.md`, and any later wave file whose plan changed. Write `docs/sessions/W7-Z.md` from plan.md 3.3.
10. **Owner actions:**
    - **OA-20:** the audit status (step 2). Booking is the critical path for W15.
    - **OA-D5:** Admin (step 6), needed by W12. **OA-D2:** the Core flow, needed by W9. **OA-D3:** Social and Settings, needed by W11. **OA-D1:** confirm before W8-C.
    - **OA-09:** the Coinbase OAuth app, start by W8. **OA-22:** the response shape, checked in W14-A.
    - **OA-21:** legal text by W12; it also sets `geo.stakes.allow` and `geo.stakes.age21`.
    - **OA-04:** Workers Paid and the deploy token, start by W10. **OA-17:** the admin and guardian multisigs, start by W10.
    - **OA-07:** DNS and email sending for `flocked.xyz`, needed by W14 (start by W12).
    - W7-B asks for a Farcaster hub (`FARCASTER_HUB_URL`; Neynar's needs an API key, a secret).
11. **Wave-8 prompts:** emit them from `docs/plan/wave-8.md` and plan.md 3.1, pointing at `docs/sessions/W7-Z.md`.
    - Reserve the wave-8 migrations: **W8-A `0017`, W8-B `0018`, W8-D `0019`**.
    - Name every spec section changed this wave.
    - W8-C (the first `ui` specs) uses `e2e/fixtures/` and the `ui` project in `e2e/playwright.config.ts`; browser specs that move anvil's clock follow the same two-phase rule.

## Tests and checks

- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green on `w7-integration` before merging, and on `main` after.
- `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green; every stack test and `pnpm e2e` green locally.
- CI, Stack and E2E green on `w7-integration`, and on `main` after the push.
- `git diff audit-candidate-1 HEAD -- contracts/src` empty.
- No test is skipped, deleted or weakened without a line in `W7-Z.md` with the reason.

## Definition of done

- `main` contains wave 7 and W6-F1, tagged `wave-7`, with CI, Stack and E2E green. The wave branches and worktrees are removed.
- DO-5, ID-1, PIPE-1 (WS), E2E-1/2/4 (API), E2E-6, E2E-9 (API), E2E-10, E2E-14, AC-1 (local) and AC-5 (timeout part) are each proven by a named test, and R1–R13 and O1–O5 each by W6-F1's named, mutation-checked test. The traceability rows are updated.
- The audit candidate is confirmed unchanged, and the audit status is recorded in Status and OA-20. The owner has been asked about OA-D5, OA-D2 and OA-D1, and about the merge-notice copy.
- The owner's decisions are in the spec with Decision log rows, and the plan files are updated.
- `docs/sessions/W7-Z.md` is written, and the wave-8 prompts are saved, committed and printed.

## Constraints

- Never merge a red wave (plan.md 2.6). Fixes over ~50 lines, or with new behaviour, go to a `W7-F{k}` session, with a `W7-Z.2` prompt to run after it (or, by the Oct 12 option, Z runs the fix itself on branches off `w7-integration`).
- Never commit secrets (`e2e/stack/.dev.vars`, `.state.json` and `.run/` are gitignored). Don't fake owner actions or launch gates. Booking the auditor is the owner's.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6. Subagents may take the diff reviews and the spec edits.

## End of session

1. Commit, and push `main`.
2. Write `docs/sessions/W7-Z.md` (plan.md 3.3), then commit and push it.
3. Save every wave-8 prompt to `docs/prompts/W8-{X}.md`, then commit and push them. Then tag `wave-7` on `main` and push the tag.
4. Print each prompt in its own fenced block. Say which run in parallel, and that the owner starts each in a fresh session.
