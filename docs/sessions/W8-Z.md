# Wave 8 summary

## Status

Merged to `main` at `ec14069`, a `--no-ff` merge of `w8-integration` @ `597fd26`. The tag `wave-8` is on `main`'s head: the commit that adds the wave-9 prompts after this summary. Wave-9 worktrees therefore contain them, and `main` equals the tag.

- All five handoffs were `complete`: W8-A, W8-B, W8-C, W7-F1 (the wave-7 review fixes) and W8-D.
- **Review findings on a green wave** (plan.md 2.6, Oct 11 option, owner decision Oct 16): W8-Z's three adversarial reviews (questions and the scheduler; stats, hooks and qualification; rooms and the deletion hand-over) found 1 high, 3 medium and 6 low defects no test catches, and no reveal leak or room-gating bypass. Wave 9's A, B and C don't edit those files, so W8-Z merged and **W8-F1** runs alongside W9-A/B/C from the tag `wave-8`; W9-D merges it (`wave-8.md` "W8-F1": H1, M1–M3, L1–L6 and five decisions that need code). The high: every cron tick does D1 work for every open room, so a few hundred rooms pass D1's 1,000 queries per invocation and starve the daily round, and nothing caps rooms per account.
- The W7-F1 merge: W8-D's changes to W7-F1's files are a second handler after the outcome handlers in `indexer/handlers/stakes.ts` and the room statements after the guards in `identity/delete.ts`'s batch. Both reviews confirmed they don't weaken R6, R7, R8, R13, R15 or R16, and W8-F1 re-runs those mutations on its tree.
- `git diff audit-candidate-1 HEAD -- contracts/src` is empty on `w8-integration` and on `main` after the merge.
- **Session size (owner note, Oct 16):** W8-D ran far over its size M: about 0.6M tokens in its own context plus about 1.5M across its six subagents (W8-C used about 2.5M across nine, W8-A about 1.2M across four). The owner's rule from now on (plan.md 2.8): integrate sessions that build after their merges are split up front into D and D.2, and subagent tokens count toward a session's size. W9-D is split that way. W8-Z itself also ran well past M through subagents: three reviews (about 0.74M tokens), a spec editor (0.17M), a plan editor (0.18M) and a design subagent (0.5M), about 1.6M in all.
- **Worktree:** the auto-mode classifier refused `git worktree remove ../flocked-w8-d`, so W8-Z worked in W8-D's worktree (the prompt allows it) instead of `../flocked-w8-z`.

CI:

- `w8-integration` @ `99999c0` (W8-D's head with the W8-Z prompt): CI run 38859125026 (check, contracts, properties, static-analysis), Stack run 38859125028 (eight steps) and E2E run 38859124940 (api, ui, screens) passed; `c272959`'s runs (38857002282, 38857002294, 38857002327) too.
- `w8-integration` @ `597fd26` (W8-Z's spec, plan, copy and design commits): CI run 38865549671 (check, contracts, properties, static-analysis), Stack run 38865549644 (eight steps) and E2E run 38865549654 (api, ui, screens) passed.
- `main` @ `ec14069` (the merge; its tree equals `597fd26`'s): CI run 38868814727, Stack run 38868814672 and E2E run 38868814680 passed. Locally on `main`: `pnpm install --frozen-lockfile && pnpm check` (the counts below), `pnpm format:check` and `git diff audit-candidate-1 HEAD -- contracts/src` (empty) passed. The summary and prompt commits after the merge are docs only.

Local checks on `w8-integration` @ `99999c0` (Node 22.23.1; the stack on `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239`, because another process held 9229):

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 504, e2e phase check 4, web 284, signer 19, api 1311, forge 202 |
| `pnpm format:check` | pass |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | 202 passed (265 s) |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run` + `stack:down` | 8 files passed (569 s) |
| fresh stack: `pnpm stack:up && pnpm e2e && pnpm stack:down` | 25 passed (21.5 min: W7's 19 plus `rooms.spec.ts`'s 6) |
| fresh stack: `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` | 52 passed (30 s) |
| `pnpm e2e:screens` (macOS) | 38 passed (16 s), before and after the W8-Z re-exports |

After W8-Z's commits (`b909e11` spec, plan and copy; `597fd26` design and the two sheet edits): `pnpm check` passed again (same counts), `pnpm format:check` passed, and `pnpm e2e:screens` passed (38) against the new exports.

- Nothing was skipped or weakened. Each handoff lists the tests it changed (W8-A: the lock tests rewritten for C5 and E4; W8-B: two `crowdHint` expectations; W8-D: room-grant balances, the hourly-dedupe test moved, `stakes-settle`'s anvil clock). W8-Z changed no test; its only code edits are a comment in `copy/notifications.ts` and the two sheet values (`codeLength` 8, `codeMinutes` 5; the navigation note).

## On main now

- **Question pipeline (W8-A, `src/questions/`, `src/moderation/`):** `POST /questions` with format checks, the 7-day block, 3 per game day, Turnstile and synchronous moderation (Claude Sonnet 5.5 through `@anthropic-ai/sdk`, a cached rubric, structured output; Workers AI + Vectorize duplicates, a D1 stand-in locally); votes with a 3-day half-life and the top-50 queue; the admin queue actions (approve, reject with `question_rejected`, assign, edit, add a house question; W11-A mounts them); creator and `payoutAddress` at lock (C5); the no-round day (E4); the house backlog alert; `onQuestionModeFinal` (`question_splits`, `question_used`). The Anthropic mock on `:8793`.
- **Stats, boards, referrals (W8-B):** `settlement/hooks.ts` (`onModeFinal` / `runModeFinal`); `user_stats` in game-day order per mode with the streak rules; the Strays, Streaks, Weekly and Creators boards (verified only); `GET /users/:handle`; referrals and `GET /me/referrals`; the crowd hint per mode on `GET /rounds/today`.
- **Web shell (W8-C, `apps/web`):** Vite 8 + React 19, the theme from tokens, self-hosted fonts, 40 components matching the Paper sheets, the mascot (`@flocked/shared/mascot/react`), the five-tab shell, onboarding, sign-in (SIWE, Farcaster Quick Auth and relay, email codes, Turnstile), an interim read-only Today; the `ui`/`ui-warp` Playwright projects, the screenshot helper and the macOS `screens` job.
- **Rooms (W8-D, `src/rooms/`):** the four room routes, room rounds from the scheduler (mirror and custom), room points and grants, qualification (`countQualifyingOnly`, `qualifies` in room bundles), the room board, member picks after the reveal, the Stakes-rooms flag, a deleted owner's rooms; the Stakes `onModeFinal` call; `rooms.spec.ts` on the stack.
- **W7-F1:** R1–R18 and two optional items (each mutation-checked; `W7-F1.md` table).
- **Design (W8-Z):** a design subagent applied the OA-D3 sign-off and the Core-flow fixes in Paper and re-exported: the mode-toggle check on 39 Core-flow artboards (onboarding, sign-in, Today); the email code copy (8 digits, 5 minutes); two new sign-in states (`core/sign-in/{email-address,farcaster-wait}/*`); the dark smug glint on the dark result card; the navigation note without "Profile"; an unticked checkbox (`components/checkbox/*`); `--font-mono`; the share sheets' avatar "W"; `notifications/{farcaster,webpush}/question-rejected/mobile`. The Streaks pill already wrapped the row's current streak (no change). `screens.md` marks every Social and Settings row frozen and lists the W8-Z fixes; `docs/design/README.md` records the kit conventions and export quirks. The app's sign-in and navigation sheets follow the new exports (`apps/web/src/sheets/{core/sign-in,components/navigation}.sheet.tsx`), and `pnpm e2e:screens` passes against them.

## Interfaces changed or added

- Migrations: `0017` (question pipeline), `0018` (stats), `0019` (rooms: `rooms.closed_at`, `questions.room_id`, `rounds_room_slot`), `0020` (`indexer_state.last_block_timestamp`).
- `apps/api/src/settlement/hooks.ts`: `onModeFinal(handler)`, `runModeFinal(env, {roundId, mode, kind, outcome})`; registered: stats, referrals, `onQuestionModeFinal`. The Stakes indexer runs it from `stakes-finalized-hooks` and `stakes-refunded-hooks`, after the outcome handlers commit.
- `packages/shared`: `api/questions.ts` (`QuestionQuotaSchema`, `quota` on submit and list responses; `QUESTIONS_PER_DAY`, `QUESTION_REJECTION_LIMIT`, `QUESTION_REJECTION_WINDOW_MS`, `QUESTION_BLOCK_MS`, `QUEUE_TOP_LIMIT`); `api/rounds.ts` (`RoundsTodayResponse.crowdHint`, `CrowdHintSchema`); `api/boards.ts` (`LeaderboardRow.topLiveStreak?`); `api/rooms.ts` (`RoomDetailResponse.leaderboard` rows with `winsThisWeek` and `streak`, `memberPicks`); `config.ts` (`ROOM_MAX_MEMBERS`, `ROOM_MIN_QUALIFYING_ENTRANTS`, `ROOM_QUALIFYING_ACCOUNT_AGE_MS`, `ROOMS_STAKES_ENABLED_KEY`, `MAX_DAILY_STAKE_CAP_KEY`, `DEFAULT_MAX_DAILY_STAKE_CAP`); `api/me.ts` (`MeLimitsSchema`); `enums.ts` and `queues.ts` (`question_rejected` `{questionId, reason}`); `copy/notifications.ts` (`question_rejected`, approved); `mascot/**` and the `./mascot/react` and `./design-tokens.json` exports; the `mono` token.
- `apps/api/src/env.ts`: `ANTHROPIC_BASE_URL?` (local only). Bindings: Workers AI, Vectorize (`flocked-questions`, `flocked-questions-staging`).
- `scheduler/lock.ts`: `lockRound` takes the full `Env`; `configToLock` takes the creator and a room-Stakes flag; `LockOutcome` gains `{status: 'closed', reason}`; `GapReason` `no_daily_round`.
- Seam: `roomId` on `POST /__test/rounds/scheduled`, `POST /__test/users/age`. `docs/bundle-format.md`: `qualifies` per entry in room bundles.
- e2e: `pnpm e2e:ui`, `pnpm e2e:screens`; `e2e.yml` jobs `api`, `ui`, `screens` (macos-15), `globalTimeout` 40 min.

## Decisions

All are owner decisions from Oct 16, 2026; the owner took every recommendation. Five Decision log rows (W8-Z): questions; stats, boards and referrals; rooms; web sign-in and design; real time and merges.

Sections edited in `Product_Spec.md`: "Settlement and payout math" (the Stakes creator at lock), "Identity and personhood" (Account deletion: the room hand-over; Merging accounts: tickets, stats; Entry tickets (Stakes): `rooms.stakes.enabled`), "Data model" (0017–0019 and `prefs_json.creator_payout_location_ok_at`), "API" (the `GET /rounds/:id`, `GET` and `POST /questions`, `POST /rooms`, `GET /rooms/:id` and `POST /rooms/:id/questions` rows; Reveal gating; Rate limits), "Real-time and the reveal" (the WebSocket `state` row), "Question pipeline" (steps 1–5), "Client app" (the crowd-history hint), "Share cards and distribution" (Referral), "Profiles, leaderboards and rooms" (Profiles, Game day and streaks, Leaderboards, Rooms), "Notifications" (`question_rejected`; game notifications), "Anti-abuse" (room questions). `Design_Language.md` is unchanged; the kit conventions went into `docs/design/README.md`.

- **Owner actions and reviews:** OA-20 still in talks, not booked; OA-D3 frozen with W7-Z's two items (no other fixes); the `question_rejected` copy approved as drafted, push only (title "Your question was rejected", body the reason cut to 128 characters).
- **Questions:** the vote queue is `submitted` + `queued` (not needing review), votes count until Assign; 0017 in the Data model; the payout wallet's location pass is stored by `PATCH /me` (W12-B) and the lock checks the draft's creator against the escrow's treasury (W11-A); "not suspended" means active; what is embedded and when moderation goes to review; split quality for settled modes only (the boards too); 3 per game day; `question_rejected`, `question_edited` and `question_used` are game notifications; the score stays an integer; `isSingleEmoji` moves to shared (W12-A).
- **Stats and referrals:** the 0018 tables; a voided entry counts as played and absence on a refunded or voided day ends the play streak; an invalid entry ends the stray streak; a qualified referral waits until both users pass the farming rule; over-cap referrals are paid in a later week; the attribution window is the client's; the crowd hint is per mode; suspended accounts aren't listed, Stakes net is hidden but still breaks ties, the default period is the latest counted day; profiles' authored questions; stats stay with the merged-away account.
- **Web and design:** the email code is 8 digits for 5 minutes (artboards fixed); the two undrawn sign-in states drawn with W8-C's copy; the mode-toggle check on the Core-flow artboards; Paper is the source of truth for the kit details, written down in `docs/design`, with the dark smug glint, `--font-mono`, an unticked checkbox and the navigation note fixed.
- **Real time and merges (W7-F1):** both ticket rules on merge; the Stakes `revealed` follows the D1 commit; `GET /rounds/:id` shows `revealing` past beacon time (W8-F1).
- **Rooms:** a custom room round with no question closes quietly; room questions' moderation, allowance and Approve; Stakes room rounds' three conditions; the room board's week, streak and ties; the visit grant; the 0019 columns; the status codes; deleted members don't count toward the 50 cap; the hand-over prefers an active member; at most 10 open rooms owned per account; `rooms.stakes.enabled` is a kill switch (`/prepare` refuses too).
- **Fixes:** merge the green wave and run W8-F1 alongside wave 9 (plan.md 2.6, Oct 11 option); W9-D merges it and is split into W9-D and W9-D.2.

## Traceability

- **Advanced (🟡):** E2E-13 (API part: `test/questions/quota.test.ts` › "the 7-day block after 5 rejections (E2E-13)", `admin.test.ts`; UI half W12-D), E2E-7 and AC-9 (API pieces: moderation, voting, queue, approval, scheduling, creator at lock and credit in `test/questions/*`; the e2e is W12-D's), NFR-9 (axe on every W8-C screen in `e2e/ui/{shell,onboarding,sign-in}.spec.ts`; reduced motion W9-C, audit W14-B). ALERT-6 stays 🟡 with W8-A's no-round day, backlog and `recordGap` tests (DO errors W13-A). PIPE-1 and AC-2 stay 🟡 with W7-F1's R6 and R1 (cards W10-A, log scan W13-C).
- **Evidence added to closed rows (✅):** SET-1 (the room half in the API: `test/rooms/qualify.test.ts` › "settleParams…"); DO-5, ID-1, ID-2, ID-5 and NFR-6 (W7-F1's R1–R18, `W7-F1.md` table).
- **The W8-Z checklist** (`wave-8.md`), each proven by a named, passing test: moderation (`test/questions/moderation-{decide,claude,duplicates}.test.ts`), duplicates (`moderation-duplicates.test.ts`), decay (`score.test.ts`) and the 7-day block (`quota.test.ts`); streaks across refunded, voided and no-round days and DST weeks (`test/stats/streaks.test.ts`), tie-breaks and verified-only boards (`test/boards/boards.test.ts`, `pill-and-net.test.ts`), the referral cap and qualification (`test/referrals/referrals.test.ts`); the UI screenshot suite (`e2e:screens` in CI's `screens` job and locally) and the `ui` job (axe, sign-in on the stack); W7-F1's R1–R18 (`W7-F1.md` table, merged at `e404aae`); W8-D's required tests (`test/rooms/detail.test.ts` and `test/gating/rooms.test.ts` for non-member entry and view, `test/rooms/qualify.test.ts` for the room minimum, `test/rooms/isolation.test.ts` for global stats, `e2e/tests/rooms.spec.ts` for a room round on the stack, `test/rooms/delete-owner.test.ts`, `test/indexer/stakes-hooks.test.ts` for the Stakes hook once per final mode). W8-B's and W8-D's other required tests have no traceability row (both handoffs say so).
- Every row assigned to wave 8 has a named, passing test; `docs/plan/traceability.md` names them.

## Carry-over

- **W8-F1** (`wave-8.md` "W8-F1"; alongside W9-A/B/C, merged by W9-D; no migration): H1 the tick's per-room work and the rooms-per-account cap (high); M1 a room question stored after the tick's read (and L1 the daily Assign/Reject races with the lock); M2 the room-question rate limit; M3 the visit grant for suspended members; L2 `editQuestion` re-indexes room questions; L3 account status in the member and room inserts; L4 the hand-over prefers active members; L5 the Stakes stats budget inside the indexer poll; L6 split quality settled-only on boards and profiles; plus the cap ignoring deleted members, `/prepare` and `rooms.stakes.enabled`, and `GET /rounds/:id` `revealing`.
- **W9-A:** the `question_rejected` consumer (cut the reason to 128 characters); `identity_unlinked` in `SECURITY_NOTICE_KINDS`; an email mock W9-D's E2E-8 can read. **W9-B:** rule 1 counts only `qualifies` entries in room bundles. **W9-C:** Today replaces W8-C's interim screen with the crowd hint; `routes.tsx` is D-owned; WS events are idempotent; Today's exports carry the mode-toggle check. **W9-D:** merge W8-F1; the split into W9-D.2.
- **W9-Z (a design subagent, before W10-C):** the mode-toggle check on the remaining Core-flow toggles (Sealed, Reveal, Stakes entry, global states) and the Social page's toggles; `question_rejected` on the all-events notification sheets; the 2 px avatar ring on the feedback sheet's offline-banner header (the kit is 1.5 px).
- **Later:** W10-A (the share page's Play link carries the ref and share ID), W11-D (keep `?ref=` and `/s/:shareId` in the client for 7 days and send the ref at sign-in; mini app sign-in e2e), W11-A (mount the admin question actions; no unassign; a no-round day can't be rescued; the treasury check at lock; room questions in review), W11-C (lowercase handles before linking), W12-A (`isSingleEmoji` in shared; the Rooms tab), W12-B (the payout location pass in `PATCH /me`; `maxDailyCap` on `PUT /me/limits`), W13-A (`question_used` at most once; prompt-cache usage; the noisy veto alert; the score epoch; an index on `rounds.question_id`), W13-B (reorged-out Stakes finals and stats; voided modes and `runModeFinal`; `RoundRefunded` before its D1 commit; reorged proposals and viewers; the tick and the room insert under load), W13-C (R12's timing), W14-A (R8 on a fresh deployment), W14-B (the header while `/me` loads; the 581 KB main chunk).
- Each is written into the later wave file's "Carry-over from W8-Z" section.

## Owner actions

- **OA-20 (gate 3, audit):** still in talks with an auditor (Oct 16), not booked, no report date. It is the critical path: W15 needs the report. `contracts/src` is unchanged from `audit-candidate-1`.
- **OA-D3 (Social, Settings):** frozen Oct 16 with the W7-Z items applied. **OA-D5 (Admin):** review before **W11**.
- **OA-09:** the Coinbase OAuth app (redirect `${APP_ORIGIN}/api/v1/me/personhood/callback`, scopes `wallet:user:read`, `identity:user:address:read`): due now.
- **OA-10:** the Anthropic key in staging and production secrets (`wrangler secret put ANTHROPIC_API_KEY --env staging|production`), and the Vectorize indexes with their `createdAt` metadata index before the first deploy (plan.md section 6).
- **OA-11:** Farcaster app, account, signer, manifest and the hub, by W11.
- **OA-04:** Workers Paid and the deploy token, start by W10. **OA-17:** the admin and guardian multisigs, start by W10.
- **OA-21:** legal text by W12 (it also sets `geo.stakes.allow`, `geo.stakes.age21`, `geo.deny` and may lower `limits.stakes.maxDailyCap`). **OA-07:** DNS and email for `flocked.xyz`, needed by W14 (start by W12). **OA-22:** checked by W14-A.

## Next wave

The prompts are `docs/prompts/W9-A.md`, `W9-B.md`, `W9-C.md`, `W8-F1.md` and `W9-D.md`. W9-A, W9-B, W9-C and W8-F1 run in parallel from the tag `wave-8`; W9-D merges all four and emits `W9-D.2` (the browser Free round, E2E-1 Free UI and E2E-2), which emits the W9-Z prompt.

Migrations are reserved: W9-A `0021`, W9-B none, W9-D `0022`. W8-F1 has none.

Changes from `wave-9.md` as first planned: W8-F1 runs alongside and W9-D merges it; W9-D is split into W9-D and W9-D.2 (the owner's sizing rule); W9-A may enqueue through `onModeFinal`; W9-C replaces the interim Today and shows the crowd hint per mode; W9-B counts only `qualifies` entries for rule 1 in room bundles.
