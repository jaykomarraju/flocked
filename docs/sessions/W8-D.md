# W8-D handoff: Rooms (integrate)

## Status

complete — W7-F1, W8-A, W8-B and W8-C merged onto `w8-integration`, their registrations applied, the settlement hooks wired (Stakes included), and rooms built: the four routes, room rounds from the scheduler, room points, qualification, the room board, member picks, the Stakes-rooms flag, a deleted owner's rooms and `account_suspended` on room writes; `rooms.spec.ts` settles a room round on the stack.

## Summary

- **Merges** (`--no-ff`, in the prompt's order): conflicts only in `test/migrations.test.ts` (kept every side's block, in migration order), `test/routes.test.ts` (both IMPLEMENTED lists) and `pnpm-lock.yaml` (re-resolved; every package of both sides kept). Breaks fixed: W8-C's "no round" stubs lacked W8-B's required `crowdHint`; W8-B's crowd-hint test seeded categories W8-A's CHECK rejects.
- **Registrations:** `ANTHROPIC_BASE_URL?` in `src/env.ts` (local only) and the wrangler header; the Anthropic mock on `:8793` (`STACK_ANTHROPIC_PORT`) in `stack:up` (with `ANTHROPIC_API_KEY=mock-anthropic-key` in the API's `.dev.vars`), an `anthropic` row in `stack:status`. Vectorize/AI bindings, `e2e.yml`'s `ui`/`screens` jobs and `pnpm e2e:ui`/`e2e:screens` were already on the branches. W7-F1's `0020` and `limits.stakes.maxDailyCap` need nothing more.
- **Hooks:** `onQuestionModeFinal` registered in `settlement/hooks.ts`. Stakes: `stakesModeFinalHandler` (`indexer/handlers/stakes.ts`) runs as a second handler on `RoundFinalized` (Settled) and `RoundRefunded` (not reason 4), after the outcome handler's batch commits; a hook failure retries the entry without re-running the outcome handler, and the handled mark stops a replay.
- **Rooms API** (`src/rooms/**`, `routes/rooms.ts`): `POST /rooms` (201; the owner's 500 join grant; the upcoming room rounds), `POST /rooms/join` (cap 50 in SQL, `room_full`, once), `GET /rooms/:id` (members only: 401/404; members, current round, leaderboard with `winsThisWeek` and `streak`, `memberPicks` after the Free reveal; the +100 visit grant), `POST /rooms/:id/questions` (owner of a custom room; moderated; private). Every room write refuses suspended accounts.
- **Room rounds:** `src/rooms/schedule.ts` + `scheduler/create.ts` insert one room round per open room and slot whose lock is ahead. At lock (`scheduler/lock.ts`): a mirror room takes the daily question once the daily round locks; a custom room takes the owner's; without one, or for a closed room, the round closes quietly. Room rounds lock with `minEntrants` 3 and no award; Stakes stays only with `rooms.stakes.enabled`, `mode.stakes.enabled` and a Stakes draft. The tick locks daily rounds first. The RoundDO applies the room grant before a room stake.
- **Qualification** (`settlement/reduce.ts`): valid, the user's first entry, account `created_at` ≤ closesAt − 24 h (Stakes entries: valid, as tickets are age-gated); `countQualifyingOnly` for room rounds; `qualifies` per entry in room bundle chunks (`docs/bundle-format.md`).
- **Deleted owner (B5):** `src/rooms/handover.ts` statements in `identity/delete.ts`'s batch: the oldest remaining non-deleted member becomes owner, else the room closes with its unlocked rounds. Room questions stay out of the vote queue, lists, profiles, the duplicate check, the house backlog and the admin Approve/Assign actions.
- **Subagents:** a survey agent, a hook-test builder, R1 (rooms API, deletion), R2 (room rounds, points, qualification), R3 (e2e). R1 and R2 worked in this worktree on disjoint files; the parent pinned the interfaces first and did every git write.

## Branch and head commit

`w8-integration` @ `161a8a4` (code; `848c941` before the `stakes-settle` hardening); this handoff and `docs/prompts/W8-Z.md` are the next commit.

## Files touched

- Merges: everything on the four branches. Integration fixes: `apps/web/src/layout/testing.tsx`, `e2e/ui/{shell,onboarding}.spec.ts`, `apps/api/test/stats/crowd-hint.test.ts`.
- Registrations: `apps/api/src/env.ts`, `apps/api/wrangler.jsonc`, `e2e/stack/{env,up,status}.mjs`, `e2e/stack/README.md`.
- New: `apps/api/migrations/0019_rooms.sql`; `apps/api/src/rooms/{schedule,rows,create,join,detail,leaderboard,picks,questions,handover}.ts`; `apps/api/test/rooms/*` (10 test files and two helpers); `apps/api/test/indexer/stakes-hooks.test.ts`; `e2e/tests/rooms.spec.ts`; `e2e/fixtures/rooms.ts`.
- Edited: `routes/rooms.ts`, `settlement/{hooks,reduce}.ts`, `indexer/handlers/stakes.ts`, `scheduler/{create,lock,tick}.ts`, `do/round-do.ts`, `rounds/grant.ts`, `identity/delete.ts`, `questions/{list,votes,admin,rows,backlog}.ts`, `moderation/duplicates.ts`, `stats/profile.ts`, `local/seam.ts`; `packages/shared/src/{config.ts,api/rooms.ts}` and `test/fixtures/api/rooms.json`; `docs/bundle-format.md`; `e2e/fixtures/{rounds,user}.ts`; `e2e/tests/stakes-settle.test.ts` (the anvil clock, Deviations).
- Existing tests changed (see Deviations): `test/{migrations,routes,local-seam}.test.ts`, `lifecycle/handlers.test.ts`, `scheduler/lock.test.ts`, `questions/{lock-day,creator,list}.test.ts`, `round-do/{entries,hardening}.test.ts`, `lifecycle/void.test.ts`, `anti-abuse/turnstile.test.ts`.

## Tests run

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 504, e2e phase check 4, web 284, signer 19, api 1311, forge 202 |
| `pnpm format:check` | pass |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | 202 passed (268 s) |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run` + `stack:down` | 8 files, 30 passed (9.6 min), after the `stakes-settle` fix (Deviations); twice before it, `stakes-settle` failed (`RoundNotYetOpen`) and `claims-wallet` with it, while it passed alone and in CI |
| fresh stack: `pnpm stack:up && pnpm e2e && pnpm stack:down` | 25 passed (21.4 min; W7's 19 plus `rooms.spec.ts`'s 6) |
| fresh stack: `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` | 52 passed (25 s) |
| `pnpm e2e:screens` (macOS) | 38 passed (14 s) |
| `e2e/tests/rooms.spec.ts` alone, fresh stack, three runs | 6 passed each (about 2.4 min) |
| CI on `dd0460e` (merges, registrations, hooks) | CI 38845883069, Stack 38845883063, E2E 38845883108 (api, ui, screens) green |
| CI on `fe4c707` (rooms) | CI 38849011657, Stack 38849011629, E2E 38849011615 green |
| `git diff audit-candidate-1 HEAD -- contracts/src` | empty |

Mutation checks: the Stakes hook wiring (3 mutations: registrations removed, the status condition, reason 4), R2's nine (room creation, min-3 forcing, `countQualifyingOnly`, the age rule twice, the entry grant, daily-first ordering, the Stakes flags, VOID qualifying), the privacy filters and the admin guard. Each fails a named test.

## Traceability rows covered

The session's required tests (no new row IDs; DO-2's non-member entry stays W3-B's):

- Non-member entry and view rejected: `apps/api/test/rooms/detail.test.ts` › "Non-member entry and view rejected" (plus `test/gating/rooms.test.ts`), and `rooms.spec.ts` › "…outside the room nothing answers".
- Room minimum refund: `test/rooms/qualify.test.ts` › "3 valid entries, one account under 24 h old at closesAt: refunded under rule 1…", and `rooms.spec.ts` › "room B misses the room minimum…".
- Room rounds never touch global stats: `test/rooms/isolation.test.ts` › "a settled room round changes no stats, streak, board, referral, split or global balance".
- A room round settles on the stack: `e2e/tests/rooms.spec.ts` › "room A reveals and settles on its own…".
- A deleted owner's rooms: `test/rooms/delete-owner.test.ts` (three tests).
- The Stakes hook fires once per final mode: `test/indexer/stakes-hooks.test.ts` › "fires once per final mode…" (seven tests).
- SET-1's room half now runs in the API: `test/rooms/qualify.test.ts` › "settleParams…".

## Deviations

- **Changed tests:** `lifecycle/handlers.test.ts` lists the two new hook handlers. `scheduler/lock.test.ts`: a room round without a question no longer alerts, so the hourly-dedupe test moved to `invalid_config` on a daily round. `questions/lock-day.test.ts`: a custom room round without a question now closes quietly. `questions/creator.test.ts`: its room is a real custom room with `room_id` questions; the Stakes case sets both flags. `round-do/entries`, `round-do/hardening`, `lifecycle/void`: balances include the +100 room grant; insufficient-balance cases raise `stakeMax` so they still refuse. `anti-abuse/turnstile.test.ts`: two room rounds shared a close time, which `rounds_room_slot` forbids. `questions/list.test.ts`: a `QuestionRow` literal gains `room_id`. `migrations.test.ts`, `routes.test.ts`, `local-seam.test.ts`: new rows. Nothing skipped or weakened.
- **`e2e/tests/stakes-settle.test.ts` (W6-A's), hardened:** locally it failed twice in the full sequence. `enter` reverted `RoundNotYetOpen`, and then no block reached `closesAt`. `indexer-reorg`'s `evm_revert` sets anvil's clock back to the reverted-to block's time, anvil keeps that offset, and this wave's longer runs made the lag large enough. `stakes-ticket` already mines past it. Its `beforeAll` now sets anvil's next block to wall time when the head trails it. There is no behaviour change, and CI passed both before and after.
- **Outside the listed paths, as integration fixes:** W8-A's `questions/{list,votes,admin,rows,backlog}.ts` and `moderation/duplicates.ts`, W8-B's `stats/profile.ts` (room-question privacy); `local/seam.ts` (room rounds and account age for the e2e).
- **Interface changes:** `RoomDetailResponse.leaderboard` rows gain `winsThisWeek` and `streak`, plus `memberPicks`; `LockOutcome` gains `{status: 'closed', reason}`; `configToLock` takes a room-Stakes flag; `QuestionRow.room_id`.
- **Not done:** W8-B's optional `runModeFinal` for voided modes (`lifecycle/void.ts`); W8-C's suggested seam email route.

## Spec issues

1. **"Rooms": the member cap.** 50 is the constant `ROOM_MAX_MEMBERS` (no per-room setting), and it counts deleted members' rows, which stay (Account deletion). Recommend: deleted members don't count toward the cap, or say they do.
2. **A custom room round without a question** by its lock closes quietly: no round that day, no alert. A mirror room on a no-round day (E4) has none either. Recommend writing both down.
3. **Room questions:** moderated like public ones, but a duplicate of a public question passes, and room questions are never indexed. Review stores the question for an admin and sets nothing. They share POST /questions' allowance (3 per game day, the rejection block). No Turnstile, because the pinned request has no token. Recommend confirming. Also say what Approve does for a room question: W8-D refuses it, `conflict`.
4. **Stakes room rounds:** a Stakes mode needs `rooms.stakes.enabled`, `mode.stakes.enabled` and the round's admin draft, which carries the treasury creator (W8-A's issue 3: the API doesn't know the treasury). Recommend stating it.
5. **The room leaderboard:** "wins this week" counts settled room-round wins in the ISO week of the current game day. "Streaks" are consecutive settled wins, with refunded and voided rounds neutral and absence ending the streak, over the last 120 final rounds. Ties share a rank (then join order). Deleted and merged members are left off the board. Recommend a line for each.
6. **The visit grant:** a visit is `GET /rooms/:id` (and entering). `GET /rounds/:id` of a room round doesn't grant. Recommend naming it.
7. **"Data model":** add `rooms.closed_at` and `questions.room_id` (0019), and note `rounds_room_slot`.
8. **Status codes** the spec doesn't list: an unknown, closed or foreign room is 404 "No such room"; a question for a mirror room, or with no room round that can take one, is 409 `conflict`. POST /rooms/:id/questions answers 201 for every moderation outcome, like POST /questions.

## Open issues

- **W11-A:** how an admin resolves a room question sent to review. Approve and Assign refuse it today; one option is to approve it onto the room's next round.
- **W8-B carry:** voided modes never call `runModeFinal`, so a voided day is applied when a later day's hook runs (`lifecycle/void.ts`). A reorged-out Stakes final doesn't undo stats or referrals (W13-B).
- **W7-F1 carry:** `GET /rounds/:id` still says `pending` past beacon time (W9-C). W7-F1's mutation scripts were lost, and its table names every test.
- **W9-B:** `@flocked/verify` must count only `qualifies` entries for rule 1 in room bundles (`docs/bundle-format.md`).
- **W9-C / W12:** the web Rooms tab, room pages and invites. `refuseOverQuota` is copied in `rooms/questions.ts` (it could be exported from `questions/submit.ts`).
- **W13:** the hourly room-round insert pages through every open room. That's fine at launch scale; measure it under load.

## Notes for D and Z

- Run the stack with `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239`: another local process held 9229 during this session.
- Risky diffs worth reading: `scheduler/lock.ts` (the room rules on top of W8-A's), `settlement/reduce.ts` (qualification), `rooms/{join,questions,picks}.ts` (the cap, the lock race, reveal gating), `rooms/handover.ts`, `indexer/handlers/stakes.ts` (`stakesModeFinalHandler`).
- The seam gains `roomId` on `POST /__test/rounds/scheduled` and `POST /__test/users/age`; `rooms.spec.ts` runs in `pnpm e2e`'s `api` project (about 2.4 min, no warp).
- Wave 9's migrations: W9-A `0021`, W9-D `0022`.
