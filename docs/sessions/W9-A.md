# W9-A handoff: Notifications

## Status
partial — the consumer, dedupe, prefs, exclusion filter, web push, `POST /push/subscribe`, migration `0021` and every outcome enqueue point are done and green; Farcaster, email, the RoundDO alarm bodies and the daily cast continue in `docs/prompts/W9-A.2.md` (the split the prompt names).

## Summary
- `apps/api/src/notify/`: the `notify` queue consumer (`consumer.ts`), now wired in `src/queues/index.ts`. It claims each spec dedupe key in `notification_log` (a lease while it delivers, the channels reached, done), so a redelivery or a RoundDO alarm that fires twice sends once and a partial failure retries only the channels not reached.
- The day's `outcome` key belongs to the first mode outcome that claims it (the combined message, with "The next question is live." when the next daily round is open). A later mode's result is app-only, except a later-event refund (any rule 7/8; Stakes 1/6, final when they happen), which the consumer sends as `refunded` under `refunded:{roundId}:{mode}:{userId}`.
- Recipients (`recipient.ts`): a merged account notifies the account it joined, a deleted one nobody; self-excluded users get no game notification (every event but `security_notice`); prefs default on except `streak_at_risk`; security notices ignore prefs and go on every reachable channel (verified email included).
- Rendering (`render.ts`) uses only `copy/notifications.ts`: share from the tally (`formatShare`), "+86 pts" / "+16.00 USDC", refund lines, links on `APP_ORIGIN` (default `https://flocked.xyz`), every push line held to 32/128 characters with "…" (the `question_rejected` reason rule).
- Web push (`channels/webpush.ts`): VAPID (RFC 8292) and aes128gcm (RFC 8291) with WebCrypto, no new dependency; 404/410 drop the subscription; retried only if no device took it. `POST /push/subscribe` upserts on the endpoint, is open to suspended accounts (B7) and accepts only the browsers' push services (loopback too when `ENVIRONMENT=local`).
- Producers (`outcomes.ts`): Free outcomes from a post-final hook (registered in `settlement/hooks.ts`); the Stakes outcome after the confirmed `OutcomeProposed` commit (`indexer/handlers/stakes.ts`); `payout_claimable` at `RoundFinalized`; `refunded` at `RoundRefunded` 2, 3 and 5, `outcome` for 1 and 6; rule 4 in `applyVoid`. Daily rounds only.
- `identity_unlinked` is a `security_notice` kind with copy, and unlinking an identity enqueues it. The `outcome` payload has `refundReason`.

## Branch and head commit
`w9-a-notify` @ `a97fe39` (code; this handoff is the next commit)

## Files touched
- New: `apps/api/src/notify/{types,recipient,dedupe,render,consumer,outcomes}.ts`, `apps/api/src/notify/channels/{index,webpush}.ts`, `apps/api/migrations/0021_notifications.sql`, `apps/api/test/notify/{helpers,consumer,webpush,outcomes,push-route}.test.ts` (helpers is `.ts`), `e2e/mocks/push/server.mjs`, `scripts/gen-vapid.mjs`, `docs/prompts/W9-A.2.md`.
- Edited: `apps/api/src/routes/push.ts` (stub → route), `src/queues/index.ts` (the `notify` entry only), `src/settlement/hooks.ts` (one registration), `src/indexer/handlers/stakes.ts` (one enqueue), `src/lifecycle/void.ts` (one enqueue), `src/identity/link.ts` + `src/auth/accounts.ts` (`identity_unlinked`), `packages/shared/src/{queues.ts,copy/notifications.ts}`, `packages/shared/test/fixtures/queues/valid.json`, `apps/api/test/{migrations,routes}.test.ts`.

## Tests run
| Command | Result |
| --- | --- |
| `pnpm check` | pass (api 1349, shared 504, web 284, tlock 176, settle 66, signer 19, abi 13; contracts green) |
| `pnpm format:check` | pass |
| Mutation checks (consumer.test.ts) | each caught: `laterRefund` 7/8 off, Stakes 1/6 off, the exclusion filter off, a done key re-claimable, the second mode's outcome delivered |
| `vitest run test/notify` (apps/api) | pass (35) |

Required tests: dedupe per key (`consumer.test.ts` "dedupe" ×4); the combined `outcome` at the first mode outcome ("outcome: one combined message…" ×4); `refunded` only for later events ("refunded: only for later events" ×3); the exclusion filter ("exclusion filter" ×2); `question_rejected` cuts a long reason ("question_rejected" ×2). Rate-limit batching is Farcaster's: W9-A.2.

## Traceability rows covered
None closed. E2E-8 (W9-D) builds on `consumer.test.ts` "outcome: one combined message at the first mode outcome".

## Deviations
- Split into W9-A.2 (plan 2.6) as the prompt allows; the split puts the outcome enqueue points in this half because the required outcome tests are consumer logic.
- The prompt names `src/rounds/notifications.ts`; the alarm seam is `src/rounds/hooks.ts` (`notificationsFor`). W9-A.2 fills it.
- `src/identity/link.ts` and `src/auth/accounts.ts` are outside the listed paths: unlinking must enqueue `identity_unlinked`, and `SecurityNoticeKind` there lacked it (two lines; W8-F1 doesn't own them).
- `src/queues/index.ts` (not listed): its header assigns the `notify` entry of `HANDLERS` to W9-A; only that entry changed.
- `test/routes.test.ts`: `POST /push/subscribe` moved to `IMPLEMENTED` (the stub test would fail on a real route).
- A Stakes `outcome` at the proposal carries no amount (`win_no_amount`): the payout is in the payout tree, not D1, until `RoundFinalized`.
- No test skipped, deleted or weakened.

## Spec issues
- "Notifications" › `refunded`: "a Stakes refund becoming final" doesn't say whether a `refundTooFew` (1) or `refundTimeout` (6) refund that is the user's first outcome of the day is an `outcome` or a `refunded`. Built: the first outcome is `outcome`; after another mode's outcome it is `refunded`. Recommend the spec say so.
- "Notifications" › `outcome`: a Free rule 1–3 refund after the Stakes outcome is app-only (not in `refunded`'s list). Built as written; confirm.
- `identity_unlinked` email subject, preheader, heading and CTA ("Sign-in method removed", "Open Settings") were not in the Oct 12 approval; they follow `identity_linked`. Z to confirm with the owner.
- W6-Z's "Got flocked again." is share text (`docs/design/screens.md` Share text), not notification copy: W10's.

## Open issues
- W9-A.2: Farcaster channel, webhook token storage and batching; email channel and its seam route; `notificationsFor`; the daily cast.
- The guardian void of Stakes (`src/lifecycle/handlers.ts` `stakesVoidHandler`, not W9-A's) enqueues nothing: D should call `enqueueVoidOutcomes(env, roundId)` after its D1 commit (W4-Z: its entrants are told their stake is refunded).
- Fan-out size: outcome producers send one message per entrant in 100-message `sendBatch` calls from the settlement or indexer invocation. Fine at launch scale; at ~50k entrants per mode move the fan-out to chunked queue jobs (W13 load test).
- `notification_log` grows by one row per send and has no pruning; add a cron deletion of done rows older than ~30 days (W12/W13).
- Event defaults (`streak_at_risk` off) live in `notify/recipient.ts`; the web Settings toggles will need them too, so Z may move them to `packages/shared`.
- The web app's service worker must show `{ title, body, url, tag }` and call `POST /push/subscribe` with `VAPID_PUBLIC_KEY` as `applicationServerKey` (W9-C / later web session).

## Notes for D and Z
- Migration `0021_notifications.sql` (`notification_log`, `farcaster_notification_tokens`). W9-A.2 may still add to it.
- Vars: `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` (e.g. `mailto:ops@flocked.xyz`) as plain vars in `wrangler.jsonc` per env; `VAPID_PRIVATE_KEY` is already a secret in `Env`. Add `VAPID_PUBLIC_KEY?` and `VAPID_SUBJECT?` to `src/env.ts` (today `notify/channels/index.ts` types them as `NotifyVars`). OA-12 for staging/production keys; locally `node scripts/gen-vapid.mjs e2e/stack/.dev.vars` (never printed except the public key). Without all three, web push is off (logged), never mocked.
- The stack: run `e2e/mocks/push/server.mjs` (`:8794`, `MOCK_PUSH_PORT`); a test subscribes with `http://127.0.0.1:8794/push/<id>` and reads `GET /sent?id=<id>`.
- `POST /push/subscribe` is already registered (route module `push`).
- `src/lifecycle/handlers.ts` `stakesVoidHandler`: add `await enqueueVoidOutcomes(env, roundId)` (`src/notify/outcomes.js`) after its statements commit.
- Interface changes for Z: `SECURITY_NOTICE_KINDS` gains `identity_unlinked` (with copy); the `outcome` payload gains `refundReason: RefundReasonCodeSchema.nullable()`.
