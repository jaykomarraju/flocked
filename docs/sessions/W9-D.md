# W9-D handoff: Merge wave 9 and W8-F1; notification and verify e2e

## Status
partial — by design (plan.md 2.8, split up front): W9-A, W9-B, W9-C and W8-F1 are merged, registered and green, and
E2E-8 and PIPE-6 e2e pass. W9-D.2 carries the browser Free round (E2E-1 Free UI, E2E-2 UI) and the W9-Z prompt
(`docs/prompts/W9-D.2.md`).

## Summary
- **Merges** (`--no-ff`, in the prompt's order): `w9-a-notify`, `w9-b-verify`, `w9-c-today`, `w8-f1-review-fixes`. No
  textual conflicts; the lockfile needed no re-resolution. `pnpm check` on the merged tree before any registration:
  pass (api 1394, shared 504, web 334, verify 46, tlock 176, settle 66, signer 19, abi 13, forge).
- **Registrations** (W9-A's and W9-C's Notes for D):
  - `queue()` hands the `notify` queue's whole batch to `notifyQueueBatch` (one Farcaster request per batch);
    a caller that swaps `HANDLERS.notify` (tests) keeps the per-message path;
  - `POST /farcaster/webhook` mounted beside `push` in `routes/index.ts`, **outside `ENDPOINTS`** (see Deviations);
  - `Env` gains `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `NOTIFY_EMAIL_FROM`, `EMAIL_MOCK_URL`, `FARCASTER_CAST_API_URL`
    and the secrets `NEYNAR_API_KEY`, `FARCASTER_CAST_SIGNER_UUID`; `wrangler.jsonc`'s header documents them;
  - the web route imports `Today` from `features/today/Today`; `screens/Today.tsx` is deleted.
- **Stack:** `stack:up` runs the push (`:8794`), farcaster-notify (`:8795`) and email (`:8796`) mocks
  (`STACK_PUSH_PORT`, `STACK_FARCASTER_NOTIFY_PORT`, `STACK_EMAIL_PORT`), points `.dev.vars` at them
  (`EMAIL_MOCK_URL`, `FARCASTER_HUB_URL`, `FARCASTER_CAST_API_URL`, placeholder Neynar values) and appends a fresh
  VAPID pair (`scripts/gen-vapid.mjs`); `stack:status` has their rows. Wallet offers now see the mock hub (nothing to
  offer). The daily cast posts to the mock for every daily round.
- **E2E-8** (`e2e/tests/notifications.spec.ts`) and **PIPE-6 e2e** (`e2e/tests/verify-cli.spec.ts`), with the
  `e2e/fixtures/notify.ts` helpers (push subscribe and RFC 8291 decrypt, Farcaster link plus webhook, email verify).

## Branch and head commit
`w9-integration` @ `e7756ab` (code); this handoff and `docs/prompts/W9-D.2.md` follow.

## Files touched
- Registry: `apps/api/src/{env.ts,queues/index.ts,routes/index.ts}`, `apps/api/wrangler.jsonc`, `apps/web/src/routes.tsx`
  (edited); `apps/web/src/screens/Today.tsx` (deleted).
- Tests: `apps/api/test/notify/registrations.test.ts` (new), `apps/api/test/routes.test.ts` (comment only).
- Stack and e2e: `e2e/stack/{env,up,status}.mjs`, `e2e/stack/README.md`, `e2e/fixtures/stack.ts` (edited);
  `e2e/fixtures/notify.ts`, `e2e/tests/{notifications,verify-cli}.spec.ts` (new).
- Docs: `docs/sessions/W9-D.md`, `docs/prompts/W9-D.2.md`. `git diff audit-candidate-1 HEAD -- contracts/src` is empty.

## Tests run
| Command | Result |
| --- | --- |
| `pnpm check` on the merged tree, before registrations | pass (api 1394) |
| `pnpm check` at `e7756ab` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 504, e2e phase check, web 334, signer 19, verify 46, api 1397, forge 202 |
| `pnpm format:check` | pass |
| `notifications.spec.ts` alone on a stack | 5 passed (3.1 min) |
| `verify-cli.spec.ts` alone on the same stack | 4 passed (2.6 min) |
| E2E-8 mutants on the stack: a done outcome key re-claimable by another mode (`dedupe.ts` `taken` → `claimed`) | killed: "P1" received `outcome:<day>:<user>` twice |
| E2E-8 mutant: the outcome key per mode | killed (P1's outcome push never matched) |
| Registration mutants (`registrations.test.ts`): the batch routing removed | killed |
| W8-F1 and W9-A mutants re-run on the merged tree (below) | 17 of 18 killed on the first pass; the 18th killed 4 of 4 alone |
| Stack tests in CI order (`pnpm --filter @flocked/e2e exec vitest run`), fresh stack | 8 files, 30 tests passed (9.9 min) |
| `pnpm stack:up && pnpm e2e && pnpm stack:down` (fresh stack) | 34 passed (26.5 min; 25 before plus the 9 new) |
| `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` (another fresh stack) | 101 passed (4.0 min) |
| `pnpm e2e:screens` (macOS) | 77 passed |
| CI on `e7756ab`: CI, Stack, E2E | CI pass, Stack pass; E2E `api` 34 passed (26.9 min of the 40-min budget), `screens` pass, `ui` 2 failed on the first attempt (`reveal.spec.ts`, see Open issues) and passed on a re-run of the failed job: run 38891294967 `success` |

### Mutations re-run on the merged tree
One string replacement each (W8-F1's table, same files, replacements and `-t` patterns), file restored after; the full
suite passed unmutated at `e7756ab`.

| Item | Test file › `-t` | Result |
| --- | --- | --- |
| H1 lock bound; H1 live page bound | `scheduler/tick-budget.test.ts` › H1 | killed, killed |
| H1 owned-rooms cap in SQL (`< ?7` → `< ?7 + 100`) | `rooms/review-w8.test.ts` › concurrent creates | **survived once, then killed 4 of 4** (see Open issues) |
| M1 closeRoomRound guard; M1 lock UPDATE `question_id` guard | `scheduler/lock-races.test.ts` | killed, killed |
| M2 `limitUser` on room questions; M3 visit grant active only; L3 member insert | `rooms/review-w8.test.ts` | killed ×3 |
| L5 Stakes batches per call; L5 the tick drains the rest | `indexer/budget.test.ts`, `stats/hooks.test.ts` | killed, killed |
| L6 profiles settled only | `stats/profile.test.ts` | killed |
| `/prepare` room kill switch; `GET /rounds/:id` `revealing` | `stakes/prepare.test.ts`, `read/rounds.test.ts` | killed, killed |
| W7-F1 guards R16 (payout root), R13 (unsupersede vetoed) | `settlement/stakes-review-w7.test.ts` | killed, killed |
| W9-A: exclusion filter off; `laterRefund` 7/8 off; `question_live` ignoring yesterday's entrants | `notify/{consumer,alarms}.test.ts` | killed ×3 |

W9 flagged risks: W8-F1's note to re-run `indexer/budget.test.ts` after W9-A's Stakes-final enqueue passes on the
merged tree (and is what refused the guardian-void handler); W9-B's live-chain reader ran for the first time in
`verify-cli.spec.ts` (pass); W9-C's `ui/` edits are covered by `pnpm e2e:ui` and `pnpm e2e:screens` (below).

## Traceability rows covered
- **E2E-8:** `e2e/tests/notifications.spec.ts` › "round 1 reveals both modes; each entrant gets exactly one outcome
  for the game day", "round 2 opens at round 1's close: question_live reaches P5 alone", "round 2's question_live
  never reached round 1's entrants" (plus "round 1 opens and its question_live reaches every player once").
- **PIPE-6** (e2e half): `e2e/tests/verify-cli.spec.ts` › "Free: settled and anchored, the CLI reproduces it (exit
  0)", "Stakes: proposed, the CLI reproduces it against the proposal (exit 0)", "a tampered chunk: the copy matches
  until one hex digit changes, then exit 1". With W9-B's `packages/verify/test/cli.test.ts`, the row is complete.

## Deviations
- **`pnpm check` after each merge:** run once on the merged tree (the four merges had no conflicts and touch disjoint
  paths); it passed before any registration.
- **The guardian-void notification is not wired** (W9-A's Notes for D: `enqueueVoidOutcomes` after
  `stakesVoidHandler` commits). As a `RoundRefunded` handler (`stakes-void-notify`, after `stakes-void`) it broke
  W8-F1's guard `test/indexer/budget.test.ts` › "a whole poll stays inside POLL_BUDGET": **619 > 500**. The dispatch
  call of 25 foreign voids costs 308 calls without it and the poll's worst case sits at exactly 500, so any handler on
  that event (each costs at least its handled-mark batch per event) breaks it. Reverted; no test was changed. See Open
  issues.
- **`POST /farcaster/webhook` is not in `ENDPOINTS`:** `packages/shared/test/api.test.ts` › "has no entry outside the
  table" checks every row against the spec's "API" table, which has no webhook row, and the spec is not mine to edit.
  The route is mounted beside `push`; `registrations.test.ts` proves it answers through the Worker (503 without
  `FARCASTER_HUB_URL`). W9-A's JFS schema stays in `notify/farcaster-webhook.ts`.
- `e2e/fixtures/notify.ts` reads sign-in codes from wrangler's log (as `e2e/ui/sign-in.spec.ts` does): sign-in codes
  go through the `send_email` binding, not the email mock (only notification emails do).
- No test was skipped, deleted or weakened.

## Spec issues
- **"API":** the table has no `POST /farcaster/webhook` row (auth none; request the JFS `{header, payload,
  signature}`; response `{ok, result}`). Recommend adding it; then the `ENDPOINTS` row and shared schemas follow.
- **"Notifications" › `refunded` / rule 4:** with a guardian void unwired, a Stakes-only void tells nobody until
  Open issue 1 lands. Recommend no spec change; the code follows.
- W9-A's, W9-B's, W9-C's and W8-F1's spec issues stand as written in their handoffs (none resolved here).

## Open issues
1. **Guardian void notifications (W9-Z to schedule):** options, cheapest first: (a) the scheduler tick sweeps daily
   rounds whose Stakes mode was voided since the last pass and calls `enqueueVoidOutcomes` (the consumer's dedupe
   drops repeats; one query a tick; W8-F1's tick budget test applies); (b) re-balance the indexer budget (lower
   `DISPATCH_LIMIT` for voids, or measure a realistic void batch: one void per round); (c) a dispatcher post-commit
   hook. Test: a guardian `RoundRefunded(4)` tells each Stakes entrant once.
2. **Flaky in CI: W9-C's `e2e/ui/reveal.spec.ts`** › "reduced motion: …" and "the bars grow over 3 s …" failed on
   CI's first attempt ("Unsealing in 10:00" where `/1:4\d/` was expected, so the page's server clock was 10+ minutes
   behind) and passed on the re-run; they pass locally. The first CI run they ever had (E2E runs only on `main` and
   integration branches). Likely a socket `state` whose `serverTime` predates `setPageTime`'s jump (`skewMs` in
   `ws/live.ts`). Owner: W9-D.2 (it owns the `ui` job's green).
3. CI timing: the `api` e2e job is now 26.9 min of Playwright's 40-min `globalTimeout` (45-min job).
4. **A timing-dependent kill:** `rooms/review-w8.test.ts` › "holds the cap under concurrent creates" catches the
   SQL cap's removal only when the four creates' pre-checks overlap; the app-level pre-check hides it when they
   serialize (one survival in five runs here). Recommend forcing the order (pre-check stubbed, or the count read
   bypassed) so the SQL guard alone is tested. Owner: W9-Z (small) or W13-B.
5. W9-A's open issues stand (fan-out size, cast retry alert, `notification_log` pruning, event defaults shared with
   web, the web service worker and `webhookUrl`). W9-B's: `npx` publishing, long `getLogs` scans on Base.

## Notes for D.2 and Z
- The stack now sends real notifications through the mocks: a ui spec that signs in with a channel sees security
  notices on the push mock. `e2e/fixtures/notify.ts` is reusable.
- `today.spec.ts` › "a Free round in the browser on the stack" is W9-C's base for `free-round.spec.ts`.
- W9-D used no subagents. Size: well past M (about 0.45M tokens in its own context), mostly waiting on stack runs and
  reading the four handoffs; the split held (no browser e2e here).
