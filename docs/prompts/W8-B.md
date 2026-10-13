# Session W8-B: Stats, streaks, boards, referrals

**Role:** build. **Size:** M (split into `W8-B.2` if needed: `user_stats`, streaks, the settlement hook and the boards first; profiles and referrals second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-8.md`: the intro, "Pinned interfaces", "W8-B", and the W8-B and "All" items of every "Carry-over" section (W2-Z, W3-Z, W4-Z, W5-Z, W7-Z).
- `docs/sessions/W7-Z.md` (wave-7 summary). W8-A, W8-C and W7-F1 run alongside you; their paths are in `wave-8.md` and `docs/plan/wave-7.md` "W7-F1". Don't edit them.
- Code you build on:
  - `apps/api/src/routes/{boards,users}.ts` (stubs), the `GET /me/referrals` stub in `routes/me.ts` (W7-B), `packages/shared/src/api/{boards,me}.ts` (the board, profile and referral shapes);
  - `apps/api/migrations/` (`user_stats` and its CHECK `best_stray_streak >= stray_streak`, `referrals`, `users.ref_code`, `merged_into`, `status`);
  - `apps/api/src/settlement/apply/free.ts` (where Free settles or refunds a mode) and `src/indexer/handlers/stakes.ts` (`RoundFinalized`; W7-F1's file this wave), `src/rounds/grant.ts` (the daily grant's points-farming eligibility, `recordPriorTransactions`), `src/points/index.ts` (ledger reasons), `src/read/rounds.ts` (`GET /rounds/today`, for the crowd-history hint).
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Profiles, leaderboards and rooms" --sub "Profiles"
  pnpm spec "Profiles, leaderboards and rooms" --sub "Game day and streaks"
  pnpm spec "Profiles, leaderboards and rooms" --sub "Leaderboards"
  pnpm spec "Share cards and distribution" --sub "Referral"
  pnpm spec "Anti-abuse"                    # the points-farming bullet
  pnpm spec "Client app"                    # Today: the crowd-history hint
  pnpm spec "Data model"                    # user_stats, referrals
  ```
  Changed in wave 7 (Decision log, Oct 12, 2026, W7-Z): "Profiles, leaderboards and rooms" (Game day and streaks: a game day with no daily round is neutral; Leaderboards: the Streaks accent pill wraps the top live streak's current streak; Rooms: a deleted owner's rooms pass to the oldest member), "Question pipeline" (House questions: a day with nothing to lock has no daily round), "Identity and personhood" (suspended accounts; merges), plus the other W7-Z rows in `docs/sessions/W7-Z.md` "Decisions". Read them: `pnpm spec "Out of scope, launch gates and decision log" | grep 'W7-Z'`.

## Objective
Build `wave-8.md` "W8-B": `user_stats` updates on final daily-round outcomes only (Free at settlement, Stakes when final); the game-day streak rules (refunded and voided are neutral for stray streaks, refunded still counts as played, and a day with no daily round is neutral); the Strays, Streaks, Weekly (ISO week of the game day) and Creators boards with tie-breaks and a mode filter, verified users only, excluding merged and deleted accounts; public profiles `GET /users/:handle` (Stakes net private unless opted in); referrals (`ref_code` attribution for 7 days, qualification when the first valid Free daily entry settles, 100 points each, 10 per referrer per week, the anti-farming rule reused from `rounds/grant.ts`) and `GET /me/referrals`. Also the crowd-history hint on `GET /rounds/today` (W3-Z carry-over).

## Starting point
- Base: tag `wave-7`. Branch: `w8-b-stats`. Worktree: `../flocked-w8-b`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w8-b -b w8-b-stats wave-7
  cd ../flocked-w8-b && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/stats/**`, `src/boards/**`, `src/referrals/**`, `src/settlement/hooks.ts` (new; you own it this wave), `src/routes/{boards,users}.ts`, migration `apps/api/migrations/0018_*.sql` (with `test/migrations.test.ts`), `apps/api/test/{stats,boards,referrals}/**`;
  - in `src/routes/me.ts`, only the `GET /me/referrals` handler (W7-F1 edits other handlers there);
  - `src/settlement/apply/free.ts`, only the `onModeFinal` call when a Free mode settles or refunds;
  - `src/read/rounds.ts`, only the crowd-history hint on `GET /rounds/today`;
  - `packages/shared/src/api/{boards,me,rounds}.ts` where the pinned shapes need a field, with fixtures (an interface change for Z: name it in the handoff).
- Must not touch: W8-A's `src/{questions,moderation}/**`, `routes/questions.ts`; W8-C's `apps/web/**`, `e2e/**`; W7-F1's files (`wave-7.md` "W7-F1" "Owns"), including `src/indexer/handlers/stakes.ts`: the Stakes `onModeFinal` call at `RoundFinalized` goes in at W8-D, so describe it in "Notes for D"; the registry files (`src/{app,env,index}.ts`, `routes/index.ts`, `wrangler.jsonc`, workflows, root `package.json`); `contracts/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- `wave-8.md` "Pinned interfaces": you create `apps/api/src/settlement/hooks.ts` with `onModeFinal(handler)`. It is called by Free apply when a mode settles or refunds, and by the Stakes indexer handler at `RoundFinalized` (wired by W8-D). W8-A registers its creator handler through it (W8-D applies the registration). Handlers must be idempotent: a retried settlement or a re-processed chain event calls them again.
- The board, profile and referral shapes in `packages/shared/src/api/`.
- Only final daily-round outcomes move stats. Room rounds never touch global stats or referrals (W8-D builds rooms).

## Tasks
1. Create the worktree (above). Confirm `pnpm check` is green before you change anything.
2. `settlement/hooks.ts` with `onModeFinal`, and the Free call in `apply/free.ts`.
3. `user_stats` from final outcomes, with the streak rules across refunded, voided and no-round days and DST weeks. The CHECK `best_stray_streak >= stray_streak` means both columns change in one `UPDATE`.
4. Boards: Strays, Streaks (ranks the best stray streak, all time, with the current streak shown; ties go to the current streak, then rounds played; the accent pill marks the board's top live streak and wraps its current streak), Weekly, Creators (W8-A's split quality); mode filter; verified only; merged and deleted accounts excluded.
5. `GET /users/:handle` (private Stakes net unless `prefs.showStakesNet`; deleted and merged accounts are not found).
6. Referrals: attribution, qualification, the cap and the farming rule; `GET /me/referrals`. The crowd-history hint on `GET /rounds/today` (the category's average winning-side share over its last 30 settled daily rounds, hidden below 5).

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required: streak rules across refunded, voided and no-round days and DST weeks; tie-breaks on every board; verified-only boards that exclude merged and deleted accounts; the referral cap and qualification; hook idempotency.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- The routes answer per their schemas, the required tests pass, and the handoff names the Stakes `onModeFinal` call and any registrations for W8-D.

## Constraints
- Never commit secrets. Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6.

## End of session
1. Commit, then `git push -u origin w8-b-stats`.
2. Write `docs/sessions/W8-B.md` from plan.md 3.2, then commit and push it.
3. End with your status and: "When W8-A, W8-B, W8-C and W7-F1 all report complete, start W8-D from `docs/prompts/W8-D.md`."
