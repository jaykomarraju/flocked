# Session W9-Z: Consolidate wave 9

**Role:** consolidate. **Size:** M (about 25 spec issues across six handoffs, the guardian-void decision, the design subagent's Core-flow leftovers). **Model:** Opus 5.5.

## Read first

- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.3 (Wave summary template), 3.4 (Z checklist), 4 (Global conventions) and 6 (Owner actions and launch gates; only OA-04, OA-05, OA-09, OA-10, OA-11, OA-12, OA-17, OA-18, OA-19, OA-20, OA-24, OA-D3, OA-D4, OA-D5). Read nothing else in `plan.md` until a step needs it.
- `docs/plan/wave-9.md`: "Pinned interfaces", the "W9-Z checklist" and every "Carry-over" section. `docs/plan/wave-8.md` "W8-F1".
- The six handoffs on `w9-integration`: `docs/sessions/W9-A.md`, `W9-B.md`, `W9-C.md`, `W8-F1.md`, `W9-D.md` and `W9-D.2.md`. Also `docs/sessions/W8-Z.md` (the wave-8 summary).
- `docs/plan/traceability.md`: TL-1, E2E-1, E2E-2, E2E-8, PIPE-6 and NFR-9 (the handoffs name their tests).
- `docs/plan/wave-10.md`, to draft the next prompts. `e2e/stack/README.md` ("The test seam", "Playwright specs") and `e2e/ui/README.md` (the phase rule).
- Spec sections only when an owner decision needs editing, loaded with `pnpm spec "<heading>"` (Node 22: `nvm use` first).

## Objective

Review wave 9 and W8-F1 on `w9-integration`, get the owner's decisions on the open spec issues and on the guardian-void notification, and merge into `main`. Then:

- confirm the audit candidate is untouched, and record the audit status (OA-20);
- confirm OA-D4 (share cards, share sheet, notification copy) is frozen before W10-A;
- run the design subagent on W8-Z's Core-flow leftovers and W9-C's design problems;
- update the plan files and write the wave summary;
- emit the wave-10 prompts and tag `wave-9`.

No features.

## Starting point

- Base: `w9-integration`, pushed. W9-D.2's code head `0029bdd` has CI 38912163398, Stack 38912163544 and E2E 38912163586 green on the first attempt (the docs commits after it re-run them); `W9-D.2.md` lists the local checks.
- Worktree. W9-D's worktree `../flocked-w9-d` has `w9-integration` checked out (W9-D.2 worked there too). Work there, or remove it first (`git worktree remove`, which works on a clean worktree), then:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w9-z w9-integration
  cd ../flocked-w9-z && nvm use
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
- The stack needs OrbStack running and Foundry on `PATH`. If port 9229 is taken: `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239`. The wave's other worktrees are `../flocked-w9-{a,b,c}` and `../flocked-w8-f1`.

## Scope and file ownership

- May create or edit:
  - `Product_Spec.md`: only the sections the owner's decisions change, plus the Decision log;
  - `plan.md`: Status, 4.3, 4.6, 6, and anything a decision changes;
  - `docs/plan/*`, `docs/sessions/W9-Z.md` and `docs/prompts/W10-*.md`;
  - Paper and `docs/design/` (exports, `screens.md`), only through the design subagent (task 5);
  - small fixes (< 50 lines, no new behaviour) anywhere needed to get green, and the two named in task 6.
- Must not:
  - touch `contracts/src`, which is the audit candidate;
  - add features (the guardian-void wiring included), or change pinned interfaces without an owner decision. Larger fixes become `W9-F{k}` (plan.md 2.6).

## Pinned interfaces

Compare `wave-9.md` "Pinned interfaces" with what was built:

- **Notification senders (W9-A):** `apps/api/src/notify/channels/{farcaster,webpush,email}.ts` implement `Channel.send(batch)`; `queue()` hands the `notify` queue's whole batch to `notifyQueueBatch` (W9-D); migration `0021`. `POST /farcaster/webhook` is mounted in `routes/index.ts` beside `push` but **outside `ENDPOINTS`** (W9-D Deviations; spec issue below).
- **Verify (W9-B):** `@flocked/verify` `verifyRound` / `verifyEntry`, the `flocked-verify` bin (exit 0/1/2), `@flocked/verify/browser`.
- **Web (W9-C):** `apps/web/src/{ws,crypto}/**`, `features/{today,sealed,reveal}/**`; the route imports `Today` from `features/today/Today` (W9-D). Non-production builds read `window.__FLOCKED_LOCAL_CHAIN__` (with `skipDailyClose`); production builds never do.
- **e2e:** `e2e/fixtures/notify.ts` (W9-D), `e2e/fixtures/browser.ts` (W9-D.2: a browser player on the stack, shared by `ui/today.spec.ts` and `ui/free-round.spec.ts`). The stack runs the push (`:8794`), farcaster-notify (`:8795`) and email (`:8796`) mocks.
- Migrations: `0021` (W9-A). `0022` (reserved for W9-D) is unused.

## Tasks

1. **plan.md 3.4 steps 1–3:**
   - All six handoffs must be `complete`. W9-D is `partial` by design (the up-front split, plan.md 2.8); W9-D.2's is the completing one.
   - Run `git diff --stat main...w9-integration`.
   - Read full diffs only where a handoff flags risk:
     - W9-A: `src/notify/{consumer,dedupe,recipient,outcomes}.ts`, `src/notify/alarms.ts` (the RoundDO alarm bodies), the outcome enqueues in `settlement/apply/free.ts`, `lifecycle/void.ts` and `indexer/handlers/stakes.ts`;
     - W9-B: `packages/verify/src/{verify,chain}.ts` (the live-chain reader W9-D ran for the first time);
     - W9-C: `apps/web/src/crypto/{entry,chain}.ts` (the receipt checks and the local-chain global), `ws/live.ts`;
     - W8-F1: the files `wave-8.md` "W8-F1" names, against W9-D's merge;
     - W9-D: `apps/api/src/{env.ts,queues/index.ts,routes/index.ts}`, `e2e/stack/{env,up}.mjs`.
   - Run:
     - `pnpm install --frozen-lockfile && pnpm check` (rerun once under load before calling a wall-time test red);
     - `pnpm format:check`;
     - `(cd contracts && FOUNDRY_PROFILE=ci forge test)` (about 5 min);
     - `pnpm stack:up`, then `pnpm --filter @flocked/e2e exec vitest run` (the eight stack files in CI order, about 10 min), then `pnpm stack:down`;
     - on a fresh stack: `pnpm stack:up && pnpm e2e && pnpm stack:down` (api, then api-warp, with W9-D's `notifications.spec.ts` and `verify-cli.spec.ts`; about 27 min); then on another fresh stack `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` (with W9-D.2's `free-round.spec.ts`), and `pnpm e2e:screens` (no stack; macOS only).
   - Confirm that `gh run list --branch w9-integration` shows CI (check, contracts, properties, static-analysis), Stack (eight steps) and E2E (`api`, `ui`, `screens`) green.
2. **Audit candidate and OA-20:** `git diff audit-candidate-1 HEAD -- contracts/src` must be empty, on `w9-integration` and again on `main` after the merge. Ask the owner whether an auditor is booked and when the report is expected (in talks, not booked, on Oct 16), and record it in `plan.md` Status and OA-20.
3. **W9-Z checklist (`wave-9.md`):**
   - TL-1, E2E-1 (Free UI), E2E-2, E2E-8 and PIPE-6 proven: W9-C's `e2e/ui/tlock-bundle.spec.ts` and `today.spec.ts` (TL-1), W9-D.2's `e2e/ui/free-round.spec.ts` (E2E-1 Free UI, E2E-2 UI), W9-D's `e2e/tests/notifications.spec.ts` (E2E-8) and `verify-cli.spec.ts` with `packages/verify/test/cli.test.ts` (PIPE-6). Each handoff names the tests. E2E-1's "verify personhood" is Stakes-only in the browser (W10-D), see `W9-D.2.md`.
   - W8-F1's items (H1, M1–M3, L1–L6 and the Oct 16 decisions): W9-D re-ran 18 of its mutations on the merged tree, 17 killed on the first pass; the owned-rooms SQL cap needed four more runs (task 6).
   - Confirm OA-D4 is frozen before W10-A.
   - The design subagent (task 5).
   - Migrations for wave 10: W10-A `0023`, W10-B (the watcher's own D1) `watcher/0001`, W10-D `0024`.
   - Update `docs/plan/traceability.md`.
4. **Spec issues and the guardian void.** Raise them with the owner via AskUserQuestion, recommendation first, batched by area:
   - **Guardian void notifications (W9-D Open issue 1; decision needed):** a guardian `RoundRefunded(4)` tells nobody: wiring `enqueueVoidOutcomes` as an indexer handler broke W8-F1's poll-budget guard (619 > 500 calls; the poll's worst case sits at exactly 500). Options, cheapest first: (a) the scheduler tick sweeps rounds whose Stakes mode was voided since its last pass and enqueues (the consumer's dedupe drops repeats; W8-F1's tick-budget test applies); (b) re-balance the indexer budget; (c) a dispatcher post-commit hook. Recommend (a), as a `W9-F1` alongside wave 10 or inside W10-B/W10-D; it needs the test "a guardian `RoundRefunded(4)` tells each Stakes entrant once". The spec stays as written ("Notifications" › `refunded` / rule 4).
   - **API (W9-D):** the "API" table has no `POST /farcaster/webhook` row (auth none; request the JFS `{header, payload, signature}`; response `{ok, result}`). Recommend adding it; then the `ENDPOINTS` row and the shared schemas follow (a small fix or W10-D's).
   - **Notifications (W9-A, 6):** a Stakes 1/6 refund as the user's first outcome of the day (built: `outcome` when first, `refunded` after); a Free 1–3 refund after the Stakes outcome is app-only; the `identity_unlinked` email's subject, preheader, heading and CTA (copied from `identity_linked`); the daily cast's text (the question alone, the round as the embed); OA-11's providers (Neynar for the cast, the hub for app keys); "Got flocked again." is share text (W10's).
   - **Verify (W9-B, 3):** what a disputed anchor (a later-revoked key) means for the verdict and how routine rotations avoid it; where bundles are fetched from (`/rounds/:id/bundles/:mode/:file`) in `docs/bundle-format.md`; a Free bundle with entries and a null commitment can't happen (rule 4 refunds it before the reveal).
   - **Web (W9-C, 6):** the draft copy (crowd-hint days per category, the three refusals, the entry errors, the receipt-mismatch line, "Reconnecting…", "Clocks go forward tonight"); the win motion (walk off, then fade back); the Today slider; "Remind me" opens Settings until W12; the Free win figure waits for `/me` payouts; the builders' design notes (to the design subagent).
   - **Rooms and identity (W8-F1, 2):** a merged member as a room's successor; which member count the room view shows.
   - **Reveal (W9-D.2):** "Counting the flock…" shows from the client's first 1 s tick past beacon time until `revealed`; on the stack that was 61 ms, and a later tick skips it (`free-round.spec.ts` holds `revealed` 2 s to see it). Recommend the spec give the counting state a minimum display (about 1.5 s) before the bars, so the reveal never flashes or jumps straight from the countdown; then the client holds the result that long (W10-C, or a small fix here).

   Apply the decisions to the spec and the Decision log. Anything that changes code beyond a small fix goes into wave 10 (or a `W9-F{k}`). Name the changed sections in the wave-10 prompts.
5. **Design subagent (W8-Z's leftovers, before W10-C builds Stakes entry), through Paper:**
   - the mode-toggle check on the remaining Core-flow toggles (Sealed, Reveal, Stakes entry, global states; W8-Z did onboarding, sign-in and Today) and on the Social page's toggles;
   - `question_rejected` on the all-events notification sheets;
   - the feedback sheet's offline-banner header draws the 32 px avatar ring at 2 px (the kit is 1.5 px);
   - W9-C's design problems (`W9-C.md` "Spec issues" 2, 3 and 6): the win end state (the sheep walks off), the Today slider's fill and end labels, the note spacing under the CTA, the DST notice's clock icon, a disabled pick keeping its selected look, the Sealed and Reveal type sizes and "Counting the flock…" (no role), counter rows 28 vs 40, "Refunded" letter spacing, the refund band's second line.
   - Re-export what changes, update `screens.md`, and re-run `pnpm e2e:screens`; an export that moves past the app's 1% means a small web fix here or a W10-C item.
6. **Small fixes named by the handoffs (each < 50 lines, no new behaviour; each with a test that fails without it):**
   - `apps/api/test/rooms/review-w8.test.ts` › "holds the cap under concurrent creates" kills the owned-rooms SQL cap's removal only when the four creates' pre-checks overlap (W9-D Open issue 4): force the order (stub the app-level pre-check, or bypass its count read) so the SQL guard alone is tested, then re-run the mutation (`< ?7` → `< ?7 + 100`) five times; or schedule it for W13-B.
   - `e2e/ui/sign-in.spec.ts` keeps its own copy of the test wallet and the page setup that `e2e/fixtures/browser.ts` now holds (W9-D.2 Open issues): have it import `installWallet` from the fixture, and re-run `pnpm e2e:ui`.
   - Today's remount at close (W9-D.2 Open issues): `/rounds/today` moves the round that just closed to `previousRoundId`, and `TodayScreen` (`apps/web/src/features/today/Today.tsx`) shows `<Skeleton />` while `prevView` fetches `GET /rounds/:id`, so the unsealing screen blinks and remounts (a new socket, the skew reset). Seed `prevView` with the round already on screen (`initialData` when the IDs match), test it in `Today.test.tsx`, and drop the gap filter in `free-round.spec.ts` › `phasesSeen`; or leave it to W10-C, which edits Today next.
7. **Plan fixes from the handoffs:**
   - §4.3: the push, farcaster-notify and email mocks in `stack:up` and `stack:status` (`STACK_PUSH_PORT` `:8794`, `STACK_FARCASTER_NOTIFY_PORT` `:8795`, `STACK_EMAIL_PORT` `:8796`) and the VAPID pair in `.dev.vars` (W9-D); `notifications.spec.ts` and `verify-cli.spec.ts` in `pnpm e2e` (now about 27 min of the 40-min `globalTimeout`, W9-D Open issue 3); `free-round.spec.ts` in `pnpm e2e:ui`.
   - §4.5 / OA-11, OA-12: the new secrets and vars (`VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `NOTIFY_EMAIL_FROM`, `NEYNAR_API_KEY`, `FARCASTER_CAST_SIGNER_UUID`, `FARCASTER_CAST_API_URL`; `wrangler.jsonc`'s header documents them).
   - Record the open issues as carry-over in later wave files (each handoff's "Open issues" names an owner session): W9-A's fan-out size (W13), the daily cast's retry alert (W13-A), `notification_log` pruning (W12/W13), the event defaults shared with web Settings (W12), the web service worker and the mini app's `webhookUrl` (W11/W12); W9-B's `npx @flocked/verify` build (W11-C or the release wave), long `getLogs` scans on Base, one-entry verification on the Verify page (W11-C); W9-C's Stakes reveal behind `STAKES_UI_ENABLED` (W10-C/W10-D), bundle size (W14-B), `contracts/deployments/{8453,84532}.json` (W13/W14), `/s/:shareId` cards (W10-A); W8-F1's rate-limit wall-clock flake (W13-A), `revealing` on `GET /rounds` (Z may extend), the H1 residual (W13-B).
8. **Merge (plan.md 3.4 step 6):**
   - `main` ← `w9-integration` with `--no-ff`, then push.
   - Delete `w9-a-notify`, `w9-b-verify`, `w9-c-today`, `w8-f1-review-fixes` and `w9-integration` (local and remote).
   - Remove the worktrees `../flocked-w9-{a,b,c,d}` and `../flocked-w8-f1`.
   - Tag `wave-9` on `main` only after the summary and the wave-10 prompts are committed (steps 9 and 11).
9. **Plan files:** update `plan.md` Status, `docs/plan/traceability.md`, and any later wave file whose plan changed. Write `docs/sessions/W9-Z.md` from plan.md 3.3.
10. **Owner actions:**
    - **OA-20:** the audit status (step 2). Booking is the critical path for W15.
    - **OA-D4:** share cards, share sheet and notification copy, frozen before W10-A. **OA-D3** (Social, Settings, …) and **OA-D5** (Admin): before W11.
    - **OA-04:** Workers Paid and the deploy token, start by W10. **OA-17:** the admin and guardian multisigs, start by W10.
    - **OA-05, OA-18, OA-19:** the watcher's second Cloudflare account, the guardian paging channel and the dead-man's switch, start by W11. **OA-24:** the house question backlog, by W11.
    - **OA-09:** the Coinbase OAuth app (due). **OA-10:** the Anthropic key and the Vectorize indexes before the first deploy. **OA-11:** Farcaster app, account, the cast signer (Neynar, per W9-A), manifest and hub, by W11. **OA-12:** the VAPID pair for staging (`scripts/gen-vapid.mjs`), by W13.
11. **Wave-10 prompts:** emit them from `docs/plan/wave-10.md` and plan.md 3.1, pointing at `docs/sessions/W9-Z.md`.
    - Migrations for wave 10: **W10-A `0023`, W10-B `watcher/0001`, W10-D `0024`**.
    - Name every spec section changed this wave.
    - W10-A (share cards): `GET /rounds/:id/me` `cards` and `/s/:shareId` are what the reveal's Share already links (W9-C); the outcome email shows no card image yet (W6-Z).
    - W10-C (Stakes entry): flip `STAKES_UI_ENABLED` in `features/today/Today.tsx`, and match the re-exported toggles (task 5).
    - W10-D (Stakes UI e2e): build `e2e/ui/stakes-round.spec.ts` from `e2e/fixtures/browser.ts` and the shape of `free-round.spec.ts` (serial tests sharing three player pages; phases recorded in the page, since "Counting the flock…" lasts only seconds on the stack); E2E-1's personhood step in the browser belongs there.

## Tests and checks

- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green on `w9-integration` before merging, and on `main` after.
- `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green; every stack test, `pnpm e2e`, `pnpm e2e:ui` and `pnpm e2e:screens` green locally.
- CI, Stack and E2E green on `w9-integration`, and on `main` after the push.
- `git diff audit-candidate-1 HEAD -- contracts/src` empty.
- No test is skipped, deleted or weakened without a line in `W9-Z.md` with the reason.

## Definition of done

- `main` contains wave 9 and W8-F1, tagged `wave-9`, with CI, Stack and E2E green. The wave branches and worktrees are removed.
- The W9-Z checklist rows are each proven by a named test, and the traceability rows are updated.
- The audit candidate is confirmed unchanged, and the audit status is recorded in Status and OA-20. OA-D4 is confirmed frozen (or W10-A's start is held with the owner's agreement). The design subagent's fixes are applied and exported (or scheduled with the owner's agreement before W10-C).
- The guardian-void notification has an owner decision and a scheduled session. The owner's decisions are in the spec with Decision log rows, and the plan files are updated.
- `docs/sessions/W9-Z.md` is written, and the wave-10 prompts are saved, committed and printed.

## Constraints

- Never merge a red wave (plan.md 2.6). Fixes over ~50 lines, or with new behaviour, go to a `W9-F{k}` session, with a `W9-Z.2` prompt to run after it (or, by the Oct 12 option, Z runs the fix itself on branches off `w9-integration`; or, by the Oct 11 option, a green wave merges and the fix runs alongside wave 10).
- Never commit secrets (`e2e/stack/.dev.vars`, `.state.json` and `.run/` are gitignored; the VAPID pair is made per run, and the mocks' values and the Anthropic key are placeholders). Don't fake owner actions or launch gates.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6. Subagents may take the diff reviews, the spec edits and the Paper work; their tokens count toward the size (plan.md 2.8).

## End of session

1. Commit, and push `main`.
2. Write `docs/sessions/W9-Z.md` (plan.md 3.3), then commit and push it.
3. Save every wave-10 prompt to `docs/prompts/W10-{X}.md`, then commit and push them. Then tag `wave-9` on `main` and push the tag.
4. Print each prompt in its own fenced block. Say which run in parallel, and that the owner starts each in a fresh session.
