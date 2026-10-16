# Session W8-Z: Consolidate wave 8

**Role:** consolidate. **Size:** M (about 40 spec issues across five handoffs, the OA-D3 review and its Paper fixes, the `question_rejected` copy). **Model:** Opus 5.5.

## Read first

- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.3 (Wave summary template), 3.4 (Z checklist), 4 (Global conventions) and 6 (Owner actions and launch gates; only OA-04, OA-07, OA-09, OA-10, OA-11, OA-17, OA-20, OA-21, OA-22, OA-D3, OA-D5). Read nothing else in `plan.md` until a step needs it.
- `docs/plan/wave-8.md`: "Pinned interfaces", the "W8-Z checklist" and every "Carry-over" section. `docs/plan/wave-7.md` "W7-F1".
- The five handoffs on `w8-integration`: `docs/sessions/W8-A.md`, `W8-B.md`, `W8-C.md`, `W7-F1.md` and `W8-D.md`. Also `docs/sessions/W7-Z.md` (the wave-7 summary).
- `docs/plan/traceability.md`: the rows wave 8 advances (W8-D's handoff names them) and E2E-13 (W8-A's API part).
- `docs/plan/wave-9.md`, to draft the next prompts. `e2e/stack/README.md` ("The test seam", "Playwright specs") and `e2e/ui/README.md` (the phase rule).
- Spec sections only when an owner decision needs editing, loaded with `pnpm spec "<heading>"` (Node 22: `nvm use` first).

## Objective

Review wave 8 and W7-F1 on `w8-integration`, get the owner's decisions on the open spec issues, and merge into `main`. Then:

- confirm the audit candidate is untouched, and record the audit status (OA-20);
- run the OA-D3 review (Social, Settings) with the owner and apply its Paper fixes, with the W7-Z design items, through a design subagent;
- approve W8-A's `question_rejected` copy with the owner;
- update the plan files and write the wave summary;
- emit the wave-9 prompts and tag `wave-8`.

No features.

## Starting point

- Base: `w8-integration`, pushed. W8-D's head `c272959` (handoff and this prompt) has CI 38857002282, Stack 38857002294 and E2E 38857002327 green; `W8-D.md` lists the earlier runs and the local checks.
- Worktree. W8-D's worktree `../flocked-w8-d` has `w8-integration` checked out. Work there, or remove it first (`git worktree remove`, which works on a clean worktree), then:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w8-z w8-integration
  cd ../flocked-w8-z && nvm use
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
- The stack needs OrbStack running and Foundry on `PATH`. Another local process held port 9229 during W8-D, so W8-D ran the stack with `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239`. The wave's other worktrees are `../flocked-w8-{a,b,c}` and `../flocked-w7-f1`.

## Scope and file ownership

- May create or edit:
  - `Product_Spec.md`: only the sections the owner's decisions change, plus the Decision log;
  - `plan.md`: Status, 4.3, 4.6, 6, and anything a decision changes;
  - `docs/plan/*`, `docs/sessions/W8-Z.md` and `docs/prompts/W9-*.md`;
  - `packages/shared/src/copy/notifications.ts`, only for the `question_rejected` copy the owner approves;
  - Paper and `docs/design/` (exports, `screens.md`), only through the design subagent for the OA-D3 fixes and the W7-Z design items;
  - small fixes (< 50 lines, no new behaviour) anywhere needed to get green.
- Must not:
  - touch `contracts/src`, which is the audit candidate;
  - add features, or change pinned interfaces without an owner decision. Larger fixes become `W8-F{k}` (plan.md 2.6).

## Pinned interfaces

Compare `wave-8.md` "Pinned interfaces" with what was built:

- **Settlement hooks:** `apps/api/src/settlement/hooks.ts` `onModeFinal(handler)` / `runModeFinal(env, {roundId, mode, kind, outcome})` (W8-B). Registered: stats, referrals (W8-B) and W8-A's `onQuestionModeFinal` (W8-D). Free apply and refund call it (W8-B); the Stakes indexer calls it from second handlers `stakes-finalized-hooks` and `stakes-refunded-hooks`, after the outcome handlers' commit (W8-D). Nothing calls it for voided modes yet (W8-B open issue).
- **Web (W8-C):** `apps/web/src/routes.tsx` (D-owned from wave 9), `src/ui/**`, `src/theme/**`, `src/api/client.ts`, `src/auth/**`, `packages/shared/src/mascot/**` (React at `@flocked/shared/mascot/react`).
- **Screenshot tests:** `e2e/ui/*.spec.ts` against `docs/design/exports/**` with `maxDiffPixelRatio` 0.01, in e2e.yml's `screens` job on macos-15 (`pnpm e2e:screens`), not in the stack job (W8-C deviation: Linux text rendering misses the Mac exports).
- **Rooms (W8-D):** migration `0019` (`rooms.closed_at`, `questions.room_id`, `rounds_room_slot`); `RoomDetailResponse` gained `leaderboard: RoomLeaderboardRow[]` (with `winsThisWeek`, `streak`) and `memberPicks`; shared `ROOM_MAX_MEMBERS`, `ROOM_MIN_QUALIFYING_ENTRANTS`, `ROOM_QUALIFYING_ACCOUNT_AGE_MS`, `ROOMS_STAKES_ENABLED_KEY`; room bundles carry `qualifies` per entry (`docs/bundle-format.md`).
- Migrations: `0017` (W8-A), `0018` (W8-B), `0019` (W8-D), `0020` (W7-F1).

## Tasks

1. **plan.md 3.4 steps 1–3:**
   - All five handoffs must be `complete`.
   - Run `git diff --stat main...w8-integration`.
   - Read full diffs only where a handoff flags risk:
     - W8-A: `src/scheduler/lock.ts` (creator resolution, closing the day, the `recordGap` fix; W8-D then added the room-round rules), `src/questions/submit.ts` (the conditional insert);
     - W8-B: `src/stats/apply.ts` (day order, chunk cursor), `src/settlement/hooks.ts`;
     - W7-F1: the files its "Merge hazards" names, and `src/identity/delete.ts` with W8-D's room hand-over (`src/rooms/handover.ts`);
     - W8-D: `src/scheduler/{create,lock,tick}.ts` (room rounds), `src/settlement/reduce.ts` (qualification), `src/rooms/{join,questions,detail,picks}.ts` (gating, the cap, reveal gating of member picks), `src/indexer/handlers/stakes.ts` (`stakesModeFinalHandler`).
   - Run:
     - `pnpm install --frozen-lockfile && pnpm check` (rerun once under load before calling a wall-time test red);
     - `pnpm format:check`;
     - `(cd contracts && FOUNDRY_PROFILE=ci forge test)` (about 5 min);
     - `pnpm stack:up`, then `pnpm --filter @flocked/e2e exec vitest run` (the eight stack files in CI order, about 10 min), then `pnpm stack:down`;
     - on a fresh stack: `pnpm stack:up && pnpm e2e && pnpm stack:down` (api, then api-warp, with W8-D's `rooms.spec.ts`); then on another fresh stack `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` (W8-C: the `stack` fixture refuses a non-warp project after a warp), and `pnpm e2e:screens` (no stack; macOS only).
   - Confirm that `gh run list --branch w8-integration` shows CI (check, contracts, properties, static-analysis), Stack (eight steps) and E2E (`api`, `ui`, `screens`) green.
2. **Audit candidate and OA-20:** `git diff audit-candidate-1 HEAD -- contracts/src` must be empty, on `w8-integration` and again on `main` after the merge. Ask the owner whether an auditor is booked and when the report is expected (in talks, not booked, on Oct 12), and record it in `plan.md` Status and OA-20.
3. **W8-Z checklist (`wave-8.md`):**
   - Moderation and boards tests named: W8-A's decision table (`apps/api/test/questions/moderation-*.test.ts`), duplicate detection, decay scoring and the 7-day block (E2E-13's API part); W8-B's streaks across refunded and voided days and DST weeks, tie-breaks, verified-only boards, the referral cap and qualification (`test/{stats,boards,referrals}/**`). Each handoff names them.
   - The UI screenshot suite green in CI (`screens` job) and the `ui` job (axe, sign-in on the stack).
   - W7-F1's R1–R18 each have a passing test (`W7-F1.md`'s table) and W7-F1 is merged (`e404aae` on `w8-integration`). Its mutation scripts were lost with its scratchpad; W8-D's merges touched only `indexer/handlers/stakes.ts` (a new handler after the outcome ones) and `identity/delete.ts` (the room statements before the audit row) among its files, so re-run a sample of mutations by hand there if the diff review leaves doubt.
   - W8-D's required tests: non-member entry and view rejected, the room minimum refund, room rounds never touch global stats, a room round settles on the stack, a deleted owner's rooms, the Stakes hook fires once per final mode (`W8-D.md` names each).
   - Update `docs/plan/traceability.md`.
4. **Spec issues.** Raise them with the owner via AskUserQuestion, recommendation first, batched by area:
   - **Questions (W8-A, 9):** the vote queue after E4 (`submitted` and `queued`), the Data model for 0017, the creator payout wallet's location pass and the treasury address, what is embedded and fallbacks, split quality for refunded modes, "per game day" rate limits, `question_rejected` channels, the rounded score, the request schema's trimming.
   - **Stats and referrals (W8-B, 10):** the 0018 tables, voided and invalid entries in streaks, the referral wait and the weekly cap overflow, the client-side attribution window, the crowd hint per mode, suspended accounts and Stakes net on boards, profiles' authored questions, stats on merge.
   - **Web (W8-C, 7):** the email code length and lifetime vs the artboard, undrawn sign-in states and their draft copy, the mode-toggle check on Core-flow artboards, sheet captions, the kit details list, Paper export quirks, `docs/design/README.md` and `screens.md` notes.
   - **W7-F1 (3):** tickets on merge, the indexer `revealed` wording (after the D1 commit), `revealing` on `GET /rounds/:id` past beacon time.
   - **Rooms (W8-D):** see `W8-D.md` "Spec issues" (the member cap and deleted members, a custom room round without a question, mirror rooms on a no-round day, room-question moderation and allowance, Stakes room rounds and the draft, the room leaderboard's week and streak, the visit grant, the Data model columns).

   Apply the decisions to the spec and the Decision log. Anything that changes code beyond a small fix goes into wave 9 (or a `W8-F{k}`). Name the changed sections in the wave-9 prompts.
5. **Owner reviews, design and copy:**
   - **OA-D3:** ask the owner to review Social and Settings in Paper (needed by W11). Apply the review's Paper fixes and the W7-Z design items (the Streaks pill wraps the row's current streak, decision E3; the share sheets' viewer avatar "J" becomes "W", F5) through a design subagent, re-exporting what changes and updating `screens.md`, before W11.
   - **OA-D2** is frozen (Oct 12), so W9-C needs no check.
   - **`question_rejected`:** bring W8-A's copy draft (push title and body, optional email) to the owner and apply the approved copy to `packages/shared/src/copy/notifications.ts` (W9-A writes the consumer). The Paper page "Cards and notifications" and `screens.md` lack it (W8-A open issue).
6. **Plan fixes from the handoffs:**
   - §4.3: `pnpm e2e:ui` and `pnpm e2e:screens` (W8-C); the Anthropic mock on `:8793` (`STACK_ANTHROPIC_PORT`) in `stack:up` and `stack:status` (W8-D); the seam's room-round option and account backdating (W8-D); `rooms.spec.ts` in `pnpm e2e`.
   - §4.6: e2e.yml's `api`, `ui` (stack, `--grep-invert @screenshot`) and `screens` (macos-15) jobs, `globalTimeout` 40 min (W8-C).
   - §4.5 / OA-10: `ANTHROPIC_API_KEY` per environment; the Vectorize indexes and their `createdAt` metadata index (W8-A "Notes for D and Z").

   Record the open issues as carry-over in later wave files (each handoff's "Open issues" names an owner session).
7. **Merge (plan.md 3.4 step 6):**
   - `main` ← `w8-integration` with `--no-ff`, then push.
   - Delete `w8-a-questions`, `w8-b-stats`, `w8-c-web-shell`, `w7-f1-review-fixes` and `w8-integration` (local and remote).
   - Remove the worktrees `../flocked-w8-{a,b,c,d}` and `../flocked-w7-f1`.
   - Tag `wave-8` on `main` only after the summary and the wave-9 prompts are committed (steps 8 and 10).
8. **Plan files:** update `plan.md` Status, `docs/plan/traceability.md`, and any later wave file whose plan changed. Write `docs/sessions/W8-Z.md` from plan.md 3.3.
9. **Owner actions:**
   - **OA-20:** the audit status (step 2). Booking is the critical path for W15.
   - **OA-D3:** Social and Settings (step 5), needed by W11. **OA-D5:** Admin, before W11.
   - **OA-09:** the Coinbase OAuth app (due now). **OA-10:** the Anthropic key in staging and production secrets; the Vectorize indexes (W8-A's commands) before the first deploy.
   - **OA-11:** Farcaster app, account, signer, manifest and the hub, by W11.
   - **OA-04:** Workers Paid and the deploy token, start by W10. **OA-17:** the admin and guardian multisigs, start by W10.
   - **OA-21:** legal text by W12 (it also sets `geo.stakes.allow`, `geo.stakes.age21`, `geo.deny`, and may lower `limits.stakes.maxDailyCap`). **OA-07:** DNS and email for `flocked.xyz`, needed by W14 (start by W12). **OA-22:** checked by W14-A.
10. **Wave-9 prompts:** emit them from `docs/plan/wave-9.md` and plan.md 3.1, pointing at `docs/sessions/W8-Z.md`.
    - Migrations for wave 9: **W9-A `0021`, W9-B none, W9-D `0022`**.
    - Name every spec section changed this wave.
    - W9-B (`@flocked/verify`): room bundles carry `qualifies`, and rule 1 counts only qualifying entrants there (`docs/bundle-format.md`).
    - W9-C: `apps/web/src/routes.tsx` is D-owned from now; the Today entry flow replaces W8-C's interim screen and shows W8-B's crowd hint.

## Tests and checks

- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green on `w8-integration` before merging, and on `main` after.
- `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green; every stack test, `pnpm e2e`, `pnpm e2e:ui` and `pnpm e2e:screens` green locally.
- CI, Stack and E2E green on `w8-integration`, and on `main` after the push.
- `git diff audit-candidate-1 HEAD -- contracts/src` empty.
- No test is skipped, deleted or weakened without a line in `W8-Z.md` with the reason.

## Definition of done

- `main` contains wave 8 and W7-F1, tagged `wave-8`, with CI, Stack and E2E green. The wave branches and worktrees are removed.
- The W8-Z checklist rows are each proven by a named test, and the traceability rows are updated.
- The audit candidate is confirmed unchanged, and the audit status is recorded in Status and OA-20. The OA-D3 review is done and its Paper fixes and the W7-Z design items are applied and exported (or scheduled with the owner's agreement before W11). The `question_rejected` copy is approved.
- The owner's decisions are in the spec with Decision log rows, and the plan files are updated.
- `docs/sessions/W8-Z.md` is written, and the wave-9 prompts are saved, committed and printed.

## Constraints

- Never merge a red wave (plan.md 2.6). Fixes over ~50 lines, or with new behaviour, go to a `W8-F{k}` session, with a `W8-Z.2` prompt to run after it (or, by the Oct 12 option, Z runs the fix itself on branches off `w8-integration`).
- Never commit secrets (`e2e/stack/.dev.vars`, `.state.json` and `.run/` are gitignored; the Anthropic mock's key is a placeholder). Don't fake owner actions or launch gates.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6. Subagents may take the diff reviews, the spec edits and the Paper work.

## End of session

1. Commit, and push `main`.
2. Write `docs/sessions/W8-Z.md` (plan.md 3.3), then commit and push it.
3. Save every wave-9 prompt to `docs/prompts/W9-{X}.md`, then commit and push them. Then tag `wave-8` on `main` and push the tag.
4. Print each prompt in its own fenced block. Say which run in parallel, and that the owner starts each in a fresh session.
