# W8-A handoff: Question pipeline

## Status
complete — submit with synchronous moderation and duplicate detection, the vote queue with a 3-day half-life, the limits and the 7-day block, the admin queue actions, creator and `payoutAddress` at lock, the no-round day, and the post-final creator handler.

## Summary
- **Moderation** (`src/moderation/`): Claude Sonnet 5.5 (`claude-sonnet-5-5`) through `@anthropic-ai/sdk` 0.135.0. The fixed rubric (~900 tokens) is a cached system prompt, effort is `low`, and the output comes through `output_config.format` (json_schema). zod then checks `predictedSplit` ∈ [0.5, 1], since structured outputs drop numeric bounds. Duplicates use Workers AI `@cf/baai/bge-base-en-v1.5` (cls pooling) over the prompt and both labels (labels sorted, emoji left out). Vectorize returns hits ≥ 0.9 created in the last 365 days, and each is confirmed in D1 (not `rejected`). The model call and the lookup run concurrently, and `decide.ts` is the decision table. A refusal, a failed call or invalid output goes to `review`, even when a duplicate was found; a failed lookup with a passing verdict also goes to `review`. The full `ModerationJson` is stored. Fakes are registered per env object (`withModerationDeps`). With `ENVIRONMENT=local` only, an exact-match D1 stand-in replaces Vectorize, which has no local simulator.
- **Routes** (`routes/questions.ts`, `src/questions/{submit,votes,list,rows,format,cursor}.ts`):
  - `POST /questions` (201) checks, in order: `account_suspended`, format, the 7-day block (`submission_blocked`), 3 per game day (`rate_limited` with Retry-After to 21:00 New York), Turnstile, then moderation.
  - The insert is conditional on the count and the block, so concurrent submits can't exceed either. A rejection runs `blockAfterRejection` in the same batch.
  - `POST /questions/:id/vote` checks `account_suspended`, the 60/min bucket, own question → 403, and anything outside the vote queue → 409. The score is recomputed from the votes in the same batch.
  - `GET /questions`: `top` serves at most 50 in one page; `new` pages by keyset. Every row is parsed with the shared schemas before it is served.
- **Score** (`questions/score.ts`): each vote decays from when it was cast. The value stored is Σ value·2^((castAt − 2026-10-01)/3 d), so `ORDER BY score` gives the decayed order; the served value is the decayed score, rounded.
- **Admin queue actions** (`questions/admin.ts`; W11-A mounts them on `routes/admin.ts`): approve (`submitted → queued`), reject with a reason (block counting, `question_rejected`), assign (`queued → scheduled`, before the lock time only), edit (`question_edited`, re-indexed) and add a house question. Each writes its change and one `audit_log` row in a single guarded batch.
- **Lock** (`scheduler/lock.ts`, `questions/{creator,backlog}.ts`):
  - **Stakes creator (C5):** `creator` and `payoutAddress` are set together. They are the author's payout wallet only when every check passes: verified, active, not self-excluded, the location pass, the wallet linked and verified, attestations re-read and unrevoked, the country matching and allowed. Otherwise the draft's creator (the treasury) and `null`. The decision goes in a `stakes_creator` audit row.
  - **No-round day (E4):** with no question and no house question, the daily round is closed while unlocked, and that is final. The alert is `no_daily_round`.
  - **Backlog:** below 14 house questions it alerts, at most once a day.
  - **Notification:** an authored daily lock sends `question_used` (`scheduled`).
- **Post-final handler** (`questions/final.ts`): `onQuestionModeFinal` writes `question_splits` (split quality per settled mode, idempotent) and sends `question_used` (`settled`). It credits nothing. The Free award is credited once by `settlement/apply/free.ts:310-319`, ledger `ON CONFLICT DO NOTHING`; the Stakes fee goes onchain to the locked `creator` (`FlockedEscrow.sol:647-652`).
- **`question_rejected`** event: enums, queue schema, channels and a copy draft (below).

## Branch and head commit
`w8-a-questions` @ `bede1f4` (code; scaffolding `3d76b63`; this handoff is the next commit)

## Files touched
- New:
  - `apps/api/migrations/0017_question_pipeline.sql`
  - `apps/api/src/moderation/{types,index,deps,claude,decide,duplicates}.ts`
  - `apps/api/src/questions/{score,quota,rows,format,cursor,submit,votes,list,admin,final,notify,creator,backlog}.ts`
  - `apps/api/test/questions/*` (14 test files + `moderation-fakes.ts`, `routes-helpers.ts`)
  - `e2e/mocks/anthropic/{server.mjs,README.md}`
- Edited:
  - `apps/api/src/routes/questions.ts` (was the stub), `apps/api/src/scheduler/lock.ts`
  - `apps/api/test/scheduler/{helpers,lock,lock-payout}.ts`, `apps/api/test/migrations.test.ts`, `apps/api/test/routes.test.ts` (`IMPLEMENTED`)
  - `packages/shared/src/api/questions.ts` (limits, `QuestionQuotaSchema`, `quota`), `api/admin.ts` (one doc comment), `enums.ts`, `queues.ts`, `copy/notifications.ts`, and their tests and fixtures
  - `apps/api/package.json` and `pnpm-lock.yaml` (`@anthropic-ai/sdk` 0.135.0, exact)

## Tests run
| Command | Result |
| --- | --- |
| `pnpm check` (Node 22.23.1), before any change | pass: api 950, shared 468, forge 202 |
| `pnpm check` at `bede1f4` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 473, signer 19, api 1152 (102 files), forge 202 |
| `pnpm format:check` | pass |
| stack at `bede1f4`: `pnpm stack:up`, `pnpm --filter @flocked/e2e exec vitest run`, `pnpm stack:down` | pass: 8 files, 30 tests (574 s) |
| CI on `bede1f4` (run 38830330747: check, contracts, properties, static-analysis) | pass |

Two other sessions' stacks were up, so this one ran isolated: `COMPOSE_PROJECT_NAME=flocked-stack-w8a` (it takes precedence over the compose file's `name:`) with every `STACK_*_PORT` moved (api 8807, inspector 19249, anvil 18565, drand 18100, mocks 8809–8812). Without a separate project name, a second `stack:up` or a `stack:down` takes over or stops the other stack's drand containers.

api gained 202 tests: 196 in `test/questions/` (moderation 61, routes 67, lock-time 28, admin, final and notify 40) and 6 in `test/migrations.test.ts`; the `test/scheduler` changes net to zero. Shared gained 5. Four builder subagents each mutation-checked their own guards: 99 mutations, 96 caught. Each of the three misses is covered by a second guard: B's `parseOptions` check is re-checked by `QuestionSchema`, C1's first wallet-link check is repeated inside `userWalletAttestations`, and C2's `assign` locked pre-check is backed by the batch's round guard.

## Traceability rows covered
- **E2E-13 (API part):** `test/questions/quota.test.ts` :: "the 7-day block after 5 rejections (E2E-13)" › "the 5th rejection within 7 days blocks submission until 7 days after it; play and votes are unaffected; then it ends", "4 rejections within 7 days leave submission open", "rejections older than 7 days don't count". The block from admin rejections is covered by `test/questions/admin.test.ts`. The UI half stays with W12-D.
- **ALERT-6 (schedule gap):**
  - `test/questions/lock-day.test.ts` (the no-round day).
  - `test/questions/backlog.test.ts` (the backlog below 14).
  - `test/scheduler/lock.test.ts` :: "a gap that persists alerts again after an hour, even when it is seen every minute". This is the `recordGap` fix under Deviations.
- **AC-9 / E2E-7 (W12-D), API pieces:**
  - moderation: `moderation-{decide,claude,duplicates}.test.ts`
  - voting and the queue: `votes.test.ts`, `list.test.ts`, `score.test.ts`
  - approval and scheduling: `admin.test.ts`
  - creator and `payoutAddress` at lock: `creator.test.ts`, `scheduler/lock-payout.test.ts`
  - creator credit: `final.test.ts`

## Deviations
- **Files outside the scope list**, each needed by the work:
  - `packages/shared/src/enums.ts` (the `question_rejected` event in `NOTIFICATION_EVENTS`);
  - `apps/api/test/routes.test.ts` (the three question routes added to `IMPLEMENTED`; W8-B adds its routes on the same list);
  - one comment in `packages/shared/src/api/admin.ts`: `predictedSplit` is the larger option's share, 0.5–1, not "option 0 share".
- **Existing tests changed:**
  - `lock.test.ts` "with no house question left it refuses, alerting at most once an hour" is replaced by "…the game day has no daily round: closed once, alerting once" (E4 changed the behaviour). The hourly repeat is now tested on a room round.
  - "fills a gap with the top house question…" filters alerts by reason, since the backlog alert fires too.
  - Both `lock-payout.test.ts` tests are rewritten for C5.
  - `test/scheduler/helpers.ts`: category `'animals'` → `'other'`, because 0017's CHECK rejects it.
  - Nothing was skipped.
- **`recordGap` bug fix** (`lock.ts`): its hourly dedupe matched any `schedule_gap` row, and the tick writes one every minute, so a persisting gap paged once, ever. Now only rows marked `alerted: true` count.
- **The 3/day limit** is a D1 count per game day, not the RateLimitDO `questions` bucket (rolling 24 h, now unused), so "the next game day is fresh" and "N of 3 left today" hold.
- **No server-side `fallbacks`** on the Sonnet 5.5 call, though the SDK guidance enables them by default: the spec sends a refusal to admin review.
- **SDK client settings:**
  - `max_tokens` is 2048: Sonnet 5.5 thinks adaptively and those tokens count against the cap.
  - Timeout 15 s, one retry, so a submit can wait about 31 s at worst.
  - `baseURL` is always passed (the mock's only when `ENVIRONMENT=local`), so a `process.env.ANTHROPIC_BASE_URL` from `nodejs_compat` can't redirect staging.
- **`question_used` (`scheduled`) is sent at lock, not at Assign,** so a reassignment never sends a false notice.

## Spec issues
1. **The vote queue after E4** ("Question pipeline" steps 3–4, "API" `GET /questions?status=queued`). A question that passes moderation stays `submitted`, and Approve moves it to `queued`, so "Questions in the voting queue" isn't a single D1 status.
   - Built: `?status=queued` lists `status IN ('submitted','queued') AND needs_review = 0`, and votes keep counting until Assign.
   - Built: `?status=scheduled` lists only the caller's own questions; anything else would show upcoming questions before lock.
   - Recommend: say so in steps 3–4 and in the API row.
2. **"Data model"** lacks 0017: `questions.needs_review`, `rejection_reason`, `rejected_at`, the category CHECK, `question_votes.weight` (and `score`'s epoch-scaled form), and `question_splits`. Recommend: add them.
3. **"Settlement and payout math", creator at lock:**
   - Nothing stores the payout wallet's location pass. The lock requires `prefs_json.creator_payout_location_ok_at`, so until `PATCH /me` stores it, every authored Stakes question pays the treasury. Recommend: `PATCH /me` stores it when the request location passes `geo.stakes.allow` while setting the wallet, and clears it on a wallet change (W12-B, or whoever owns `PATCH /me`).
   - The API doesn't know the treasury address; the draft's `stakes.creator` is trusted as the treasury. Recommend: a config key, or reading the escrow's treasury.
   - "Not suspended" is implemented as `status = 'active'`, so merged and deleted authors fail too.
4. **"Question pipeline" step 2:**
   - `duplicateOf` is computed by the pipeline, not the model.
   - The spec doesn't say what is embedded. Built: the prompt plus both labels; the prompt alone made every "Which would you rather…?" a duplicate.
   - Output that fails to parse or validate, and a failed duplicate lookup, both go to review.
   - A refusal goes to review, not to a fallback model. Recommend: write these down.
5. **Split quality** is recorded only for settled modes; refunded and voided modes, one-sided ones included, record nothing. Recommend: confirm, or count rule-2 refunds (everyone on one side) as 0.
6. **"API" › Rate limits** says question submissions are 3/day. It is now a D1 count per game day. Recommend: say "per game day".
7. **`question_rejected` channels:** the session prompt said push and email; the spec row says Farcaster and web push. The table follows the spec, and an email draft is below. Self-excluded users get no game notifications, and `question_rejected`, `question_edited` and `question_used` all count as game notifications. Recommend: confirm.
8. **`Question.score`** is `z.int()`, so the decayed score is rounded (one upvote shows 1 until about 3 days, then 0). Recommend: keep it, or make it a number and let clients round.
9. **The request schema** neither trims nor checks "single emoji". The server's `cleanQuestionInput` does both. Recommend: move `isSingleEmoji` to shared for the client.

## Open issues
- **W11-A:**
  - Mount the `admin.ts` actions on `routes/admin.ts`; `adminQuestionView` serves the list page.
  - There is no unassign action: a scheduled question must have another assigned to its day before it can be rejected.
  - A no-round day can't be rescued after its lock time; adding house questions only fills later days.
- **W8-D:**
  - Room questions must never be stored as `submitted` or `queued`, or they appear in the public vote queue. Rooms call `moderateQuestion`; decide whether they also call `indexQuestion`.
- **W8-Z / W9-A:**
  - Approve the `question_rejected` copy.
  - The Paper page "Cards and notifications" and `screens.md` lack `question_rejected`.
  - `identity_unlinked` is missing from `SECURITY_NOTICE_KINDS`.
- **W13:**
  - `question_used` is at most once: it is sent after the lock commits, so a crash in between loses it.
  - Check prompt-cache hits in staging (`usage.cache_read_input_tokens`; usage isn't logged yet).
  - Rebase the score epoch before about 2035.
  - Consider an index on `rounds.question_id`; `GET /questions?status=used` scans for it.

## Notes for D and Z
- **`src/env.ts`:** add `ANTHROPIC_BASE_URL?: string` (honoured only when `ENVIRONMENT=local`). `ANTHROPIC_API_KEY` is already declared.
- **Secret** `ANTHROPIC_API_KEY`: `wrangler secret put ANTHROPIC_API_KEY --env staging` and `--env production` (OA-10 is the staging key). Locally it lives in `.dev.vars`; without a key every submission goes to review.
- **Stack** (`e2e/stack`):
  - Start `e2e/mocks/anthropic/server.mjs` on `STACK_ANTHROPIC_PORT` (8793), as the turnstile mock is started.
  - Write `ANTHROPIC_BASE_URL=http://127.0.0.1:8793` and `ANTHROPIC_API_KEY=mock-anthropic-key` to the API's `.dev.vars`.
  - Add an `anthropic` row to `stack:status` (`GET /health`).
  - The mock's markers are in its README.
- **Vectorize:** the bindings exist. Before the first upsert, for `flocked-questions-staging` and `flocked-questions`: `npx wrangler vectorize create <index> --dimensions=768 --metric=cosine`, then `npx wrangler vectorize create-metadata-index <index> --propertyName=createdAt --type=number` (vectors written before the metadata index can't be filtered).
- **`onModeFinal` registration:** `onQuestionModeFinal(env, { roundId, mode })` from `src/questions/final.ts`. It is idempotent and needs `DB`, `QUEUE_NOTIFY`, `ENVIRONMENT` and `FLOCKED_TEST_CLOCK`.
  - Free: call it on both outcomes; a refund is a no-op.
  - Stakes: call it after `roundFinalizedHandler`'s `status !== SETTLED` early return, because `RoundFinalized` also fires for refunds. It accepts `settle_proposed`, since it runs before that batch commits.
- **For W8-B:**
  - "A game day with no daily round" is a daily round with `locked_at IS NULL AND status = 'closed'` (audit `schedule_gap`, reason `no_daily_round`).
  - The Creators board reads `question_splits` (per round and mode; join `questions.author_user_id`).
  - Author presentation: deleted and merged authors are served as an empty public user; match the boards' rule.
- **Interface changes:**
  - `SubmitQuestionResponse.quota` and `QuestionsListResponse.quota` (`QuestionQuotaSchema`).
  - `QUESTIONS_PER_DAY`, `QUESTION_REJECTION_LIMIT`, `QUESTION_REJECTION_WINDOW_MS`, `QUESTION_BLOCK_MS`, `QUEUE_TOP_LIMIT`.
  - The `question_rejected` notify message (`{questionId, reason}`).
  - `lockRound` takes the full `Env`.
  - `configToLock(r, q, creator)`.
  - `GapReason` `no_daily_round`.
- **`question_rejected` copy draft (W8-Z approves):**
  - Push (Farcaster and web push): title "Your question was rejected", body "{reason}". The reason is cut to 128 characters with "…"; W9-A's consumer does the cut.
  - Email, if wanted: subject "Your question was rejected", preheader "{reason}", heading "Question rejected", body "We turned down "{question}". {reason}", CTA "See your questions".
- **Risky diffs worth reading:** `scheduler/lock.ts` (creator resolution, closing the day, the `recordGap` fix) and `questions/submit.ts` (the conditional insert).
