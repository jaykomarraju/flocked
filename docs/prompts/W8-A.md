# Session W8-A: Question pipeline

**Role:** build. **Size:** M (split into `W8-A.2` if needed: submit, moderation, duplicates and the limits first; votes, the queue, split quality, the creator hook, lock and the notices second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-8.md`: the intro, "Pinned interfaces", "W8-A", and the W8-A and "All" items of every "Carry-over" section (W7-Z's especially).
- `docs/sessions/W7-Z.md` (wave-7 summary). W8-B, W8-C and W7-F1 run alongside you; their paths are in `wave-8.md` and `docs/plan/wave-7.md` "W7-F1". Don't edit them.
- Code you build on:
  - `apps/api/src/routes/questions.ts` (stubs) and the question rows of `ENDPOINTS` in `packages/shared/src/api/`; `packages/shared/src/api/questions.ts` (or wherever `ENDPOINTS` points), `admin.ts` (the queue shapes);
  - `apps/api/migrations/` (`questions`, `votes` and the moderation columns); `apps/api/src/scheduler/lock.ts` (question lock, house-question gap-fill, `config_json.stakes.payoutAddress` frozen at lock by W6-F1 O4);
  - `apps/api/src/lib/turnstile.ts` (`siteverifyUrl`; the stack's mock on `:8792`), `src/lib/rate-limit.ts` (or the auth buckets), `src/points/index.ts` (creator award), `src/settlement/` (where `onModeFinal` will be called; W8-B creates `settlement/hooks.ts`);
  - `packages/shared/src/queues.ts` and `copy/notifications.ts` (`question_used`, `question_edited`; the copy is frozen with OA-D4).
- Load the `claude-api` skill before writing the SDK call.
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Question pipeline"
  pnpm spec "Core game rules" --sub "Question format"
  pnpm spec "Anti-abuse"                        # the spam bullet
  pnpm spec "Settlement and payout math"        # creator fee; creator and payoutAddress at lock
  pnpm spec "Notifications"                     # question_used, question_edited, question_rejected rows
  pnpm spec "Admin console"                     # the question queue
  pnpm spec "Data model"                        # questions, votes, moderation_json
  ```
  Changed in wave 7 (Decision log, Oct 12, 2026, W7-Z): "Question pipeline" (step 4 Approve: `submitted → queued`, Assign schedules; House questions: alert below 14, and a game day with nothing to lock has no daily round, alerts and is neutral for streaks), "Notifications" (new `question_rejected` row with the reason; `security_notice` `identity_unlinked`), "Settlement and payout math" (the creator and `payoutAddress` are set together at lock, with the author-wallet checks), "Admin console" (question queue), "Identity and personhood" (suspended accounts read-only), plus the other W7-Z rows listed in `docs/sessions/W7-Z.md` "Decisions". Read the Oct 12 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'W7-Z'`.

## Objective
Build the question pipeline of `wave-8.md` "W8-A": `POST /questions` with format validation and synchronous moderation (Claude Sonnet 5.5, `claude-sonnet-5-5`, through the Anthropic TypeScript SDK: a cached system prompt for the rubric, low effort, structured outputs with `output_config.format`); duplicate detection with Workers AI embeddings and Vectorize (≥ 0.9 over 365 days); a refusal or a failed call goes to admin review; votes with a 3-day half-life; `GET /questions?status=queued&sort=top` (top 50); the 3/day limit and the 5-rejections-in-7-days block; split quality and the creator award/creator fee hook; `question_used`, `question_edited` and `question_rejected` enqueues; Turnstile on submit. Also the W7-Z carry-over: the creator and `payoutAddress` at lock, the approve/reject/backlog rules, the empty-backlog day, a check on `questions.category`, and `account_suspended` on question and vote writes.

## Starting point
- Base: tag `wave-7`. Branch: `w8-a-questions`. Worktree: `../flocked-w8-a`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w8-a -b w8-a-questions wave-7
  cd ../flocked-w8-a && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/questions/**`, `apps/api/src/moderation/**`, `apps/api/src/routes/questions.ts`, migration `apps/api/migrations/0017_*.sql` (with `test/migrations.test.ts`), `apps/api/test/questions/**`, `e2e/mocks/anthropic/**`;
  - `apps/api/src/scheduler/lock.ts`, only for the creator/`payoutAddress` resolution at lock and the no-question day (W7-Z carry-over), with its tests;
  - `packages/shared/src/api/questions.ts` (or the file holding the question schemas) where the pinned shapes need it, with fixtures;
  - `packages/shared/src/queues.ts` and `copy/notifications.ts`, only to add the `question_rejected` event: draft its copy (push and email, carrying the reason) and put the draft in your handoff for W8-Z to approve. W9-A owns the rest of the notification work;
  - `apps/api/package.json` for the Anthropic SDK (note the lockfile change for D).
- Must not touch: W8-B's `src/{stats,boards,referrals}/**`, `src/settlement/hooks.ts`, `routes/{boards,users}.ts`; W8-C's `apps/web/**`, `e2e/{ui,fixtures}/**`, `e2e/playwright.config.ts`; W7-F1's files (`wave-7.md` "W7-F1" "Owns": `src/ws/**`, `src/identity/**`, `src/limits/**`, `src/indexer/**`, `src/chain/operator.ts`, `src/stakes/**`, `src/personhood/verify.ts`, `read/{proofs,claims,me}.ts`, …); the registry files (`src/{app,env,index}.ts`, `routes/index.ts`, `wrangler.jsonc`, workflows, root `package.json`): put registrations (the Vectorize index, an AI binding, `ANTHROPIC_API_KEY` as a secret name, new vars) in "Notes for D"; `contracts/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- `wave-8.md` "Pinned interfaces": register your post-final handler through `onModeFinal(handler)` in `apps/api/src/settlement/hooks.ts`, which W8-B creates. Don't create that file: write your handler in `src/questions/` and name it in "Notes for D" so W8-D registers it.
- The question and admin queue shapes in `packages/shared/src/api/`. A shape change is an interface change for Z: name it in the handoff.
- `ANTHROPIC_API_KEY` is a Workers secret (`.dev.vars` locally); tests mock the SDK, and the stack uses `e2e/mocks/anthropic`. Production code never falls back to the mock.

## Tasks
1. Create the worktree (above). Confirm `pnpm check` is green before you change anything.
2. Load the `claude-api` skill. Build moderation in `src/moderation/` with the SDK: the rubric as a cached system prompt, structured output with the spec's fields, low effort. A refusal (`stop_reason: refusal`) or a failure sends the question to admin review; store the full JSON in `moderation_json`.
3. Duplicate detection: Workers AI embeddings and a Vectorize query (≥ 0.9 within 365 days), behind an interface the tests mock.
4. `POST /questions`: format validation, Turnstile, the 3/day limit, the 5-rejections-in-7-days block, `account_suspended`. Votes (`account_suspended` too), the decayed score (3-day half-life) and `GET /questions?status=queued&sort=top` (top 50).
5. Approve moves `submitted → queued`; Assign schedules; a rejection enqueues `question_rejected` with the reason; `question_used` at lock and `question_edited` on an edit. The house backlog alerts below 14; with nothing to lock, the day has no daily round and alerts (`scheduler/lock.ts`).
6. At lock, resolve the creator and set `creator` and `payoutAddress` together, with the author-wallet checks (verified, linked, attestations) (spec "Settlement and payout math"). Split quality after the round and the creator award/fee handler for `onModeFinal`.
7. A CHECK on `questions.category` in `0017` (or parse with the shared schema where rows are read): the seam once wrote `'test'` and `GET /rounds/:id` broke for clients only (W7-D).

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22). The stack tests if you touch `scheduler/lock.ts`: `pnpm stack:up`, `pnpm --filter @flocked/e2e exec vitest run`, `pnpm stack:down` (about 10 min). Don't edit `apps/api/src` while it runs.
- Required: the moderation decision table (mocked SDK, including refusal and error → admin review); duplicate detection with a Vectorize mock; decay scoring; the 7-day block (API part of E2E-13); creator and `payoutAddress` at lock; the empty-backlog day; `account_suspended` on submit and vote.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Every endpoint above answers per its schema, the required tests pass, the handoff is written with the `question_rejected` copy draft and the `onModeFinal` handler named for D.

## Constraints
- Never commit secrets (`ANTHROPIC_API_KEY` only in `.dev.vars`); tests never call the real API.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions (OA-10 is the staging key).
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6.

## End of session
1. Commit, then `git push -u origin w8-a-questions`.
2. Write `docs/sessions/W8-A.md` from plan.md 3.2, then commit and push it.
3. End with your status and: "When W8-A, W8-B, W8-C and W7-F1 all report complete, start W8-D from `docs/prompts/W8-D.md`."
