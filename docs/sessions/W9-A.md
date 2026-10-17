# W9-A handoff: Notifications

## Status
complete — W9-A (consumer, dedupe, prefs, exclusion filter, web push, outcome notices) and W9-A.2 (Farcaster, email, the RoundDO alarm bodies, the daily cast) are on `w9-a-notify` and green. Every event in the spec's table is sent on its channels once W9-D applies the registrations below.

## Summary
- `apps/api/src/notify/`: the `notify` queue consumer (`consumer.ts`). It claims each spec dedupe key in `notification_log`: a lease while delivering, the channels reached, then done. A redelivery or an alarm that fires twice sends once, and a partial failure retries only the channels not reached. `notifyBatch` claims and renders every message in a queue batch, then calls each channel's `send` once for the whole batch, then records each message.
- The day's `outcome` key belongs to the first mode outcome that claims it. That is the combined message, ending "The next question is live." when the next daily round is open. A later mode's result is app-only, except a later-event refund (any rule 7/8, or Stakes 1/6, which are final when they happen); that one goes out as `refunded` under `refunded:{roundId}:{mode}:{userId}`.
- Recipients (`recipient.ts`):
  - a merged account notifies the account it joined, a deleted one nobody;
  - self-excluded users get no game notification;
  - prefs default on, except `streak_at_risk`;
  - security notices ignore prefs and go on every reachable channel.
- Rendering (`render.ts`) uses only `copy/notifications.ts`. The share comes from the tally, with links on `APP_ORIGIN` (default `https://flocked.xyz`). Push lines are cut to 32/128 characters with "…".
- Channels (`channels/`):
  - web push: VAPID plus aes128gcm on WebCrypto;
  - Farcaster: identical notifications batch into one POST of ≤ 100 tokens. Rate-limited tokens retry and invalid ones are disabled; per-user keys drop the user from the notification ID;
  - email: the `send_email` binding, with HTML and text, the next-question paragraph and link, and the footer. No card image.
- `POST /push/subscribe` upserts on the endpoint. It is open to suspended accounts (B7) and accepts only push-service endpoints.
- The Farcaster webhook (`farcaster-webhook.ts`) verifies the JSON Farcaster Signature (Ed25519) and checks the app key on a hub (`/v1/onChainSignersByFid`). The SignedKeyRequest metadata gives the client's FID. Tokens are then stored, re-enabled or disabled per (fid, app_fid).
- Producers (`outcomes.ts`), daily rounds only:
  - Free outcomes come from a post-final hook;
  - the Stakes outcome follows the confirmed `OutcomeProposed`;
  - `payout_claimable` at `RoundFinalized`;
  - `refunded` for `RoundRefunded` 2/3/5, `outcome` for 1/6;
  - rule 4 from `applyVoid`.
- RoundDO alarm bodies (`alarms.ts`, via `rounds/hooks.ts` `notificationsFor`) go only to reachable, non-excluded users in daily rounds:
  - `question_live`: no entry in the daily round that just closed;
  - `closing_soon`: not yet entered;
  - `streak_at_risk`: not entered, a stray streak ≥ 3 in either mode, and the event on.
- The daily cast (`cast.ts`) goes out at `opensAt`: the question, with `/r/{roundId}` as the embed. It goes through Neynar's cast API, once per round (`daily_cast:{roundId}` in `notification_log` and as Neynar's `idem`), and is mocked locally.
- `identity_unlinked` is a `security_notice` kind with copy, and unlinking enqueues it. The `outcome` payload has `refundReason`.

## Branch and head commit
`w9-a-notify` @ see `git log -1` (W9-A code `a97fe39`; W9-A.2 code in the commit before this handoff's)

## Files touched
- New:
  - `apps/api/src/notify/{types,recipient,dedupe,render,consumer,outcomes,alarms,cast,farcaster-webhook}.ts`
  - `apps/api/src/notify/channels/{index,webpush,farcaster,email}.ts`
  - `apps/api/migrations/0021_notifications.sql`
  - `apps/api/test/notify/{helpers.ts, consumer,webpush,outcomes,push-route,farcaster,webhook,email,alarms}.test.ts`
  - `e2e/mocks/{push,farcaster-notify,email}/server.mjs`, `scripts/gen-vapid.mjs`, `docs/prompts/W9-A.2.md`
- Edited:
  - `apps/api/src/routes/push.ts` (the stub becomes the route)
  - `src/rounds/hooks.ts` (`notificationsFor`, plus the cast after `question_live`)
  - `src/queues/index.ts` (the `notify` entry only)
  - `src/settlement/hooks.ts` (one registration)
  - `src/indexer/handlers/stakes.ts` and `src/lifecycle/void.ts` (one enqueue each)
  - `src/identity/link.ts` and `src/auth/accounts.ts` (`identity_unlinked`)
  - `packages/shared/src/{queues.ts,copy/notifications.ts}`, `packages/shared/test/fixtures/queues/valid.json`
  - `apps/api/test/{migrations,routes}.test.ts`

## Tests run
| Command | Result |
| --- | --- |
| `pnpm check` | pass (api 1371, shared 504, web 284, tlock 176, settle 66, signer 19, abi 13; contracts green) |
| `pnpm format:check` | pass |
| `vitest run test/notify` (apps/api) | pass (57) |
| Mutation checks | each caught: `laterRefund` 7/8 off; Stakes 1/6 off; the exclusion filter off; a done key re-claimable; the second mode's outcome delivered; 1000 tokens per request; rate-limited counted as sent; `question_live` ignoring yesterday's entrants; the cast posting twice |

Required tests:

| Requirement | Tests |
| --- | --- |
| Dedupe per key | `consumer.test.ts` "dedupe" ×4, `alarms.test.ts` "an alarm that fires twice" |
| The combined `outcome` | `consumer.test.ts` "outcome: one combined message…" ×4 |
| `refunded` only for later events | ×3 |
| The exclusion filter | ×2 |
| Rate-limit batching | `farcaster.test.ts` "rate-limit batching" ×4 and "notifyBatch with Farcaster tokens in D1" |
| `question_rejected` cuts a long reason | ×2 |

## Traceability rows covered
None closed. E2E-8 (W9-D) builds on `consumer.test.ts` "outcome: one combined message at the first mode outcome" and `alarms.test.ts` "question_live: …".

## Deviations
- Ran as W9-A then W9-A.2 in one session, on one branch.
- The prompt names `src/rounds/notifications.ts`; the alarm seam is `src/rounds/hooks.ts`.
- `src/identity/link.ts` and `src/auth/accounts.ts` are outside the listed paths, edited for `identity_unlinked` (two lines; not W8-F1's).
- `src/queues/index.ts`: only its `notify` entry changed. The batch entry point needs a change in `queue()` (Notes for D).
- `test/routes.test.ts`: `POST /push/subscribe` moved to `IMPLEMENTED`.
- A Stakes `outcome` at the proposal has no amount (`win_no_amount`): the payout isn't in D1 until `RoundFinalized`.
- The email mock's `GET /last?to=` stands in for the seam route W8-C asked for. W9-D may proxy it as `GET /__test/email/last?to=` if it wants a seam route.
- No test skipped, deleted or weakened.

## Spec issues
- "Notifications" › `refunded`: the spec doesn't say what a Stakes 1/6 refund is when it is the user's first outcome of the day. Built: `outcome` when first, `refunded` after another mode's outcome. Recommend the spec say so.
- "Notifications" › `outcome`: a Free rule 1–3 refund after the Stakes outcome is app-only (not in `refunded`'s list). Built as written; confirm.
- `identity_unlinked` email subject, preheader, heading and CTA follow `identity_linked`; they weren't in the Oct 12 approval. Z to confirm.
- The daily cast's text is the question alone, with the round as the embed; the spec gives no cast copy. Z to confirm, or add a line to the copy.
- OA-11: the cast uses Neynar (API key plus managed signer UUID), and app keys are checked on `FARCASTER_HUB_URL`. The owner chooses both providers with OA-11; another provider means replacing `neynarPoster` / `hubAppKeyVerifier`.
- W6-Z's "Got flocked again." is share text (`docs/design/screens.md`), not notification copy: W10's.

## Open issues
- Guardian void: `src/lifecycle/handlers.ts` `stakesVoidHandler` (not W9-A's) enqueues nothing. D should call `enqueueVoidOutcomes(env, roundId)` after its D1 commit.
- Fan-out size, for the W13 load test:
  - outcome producers and the alarm bodies enqueue one message per user in 100-message batches from one invocation;
  - `question_live` reaches every reachable non-entrant;
  - at ~50k users, page them through chunked jobs.
- A failed daily cast is logged (`daily_cast_failed`) and not retried until the `open` event re-runs. Add an alert code with W13-A if wanted.
- `notification_log` has no pruning. Add a cron deletion of done rows older than ~30 days (W12/W13).
- Event defaults (`streak_at_risk` off) live in `notify/recipient.ts`. The web Settings needs them too: a candidate for `packages/shared`.
- Web (W9-C or later):
  - the service worker shows `{ title, body, url, tag }` and subscribes with `VAPID_PUBLIC_KEY`;
  - the mini app manifest's `webhookUrl` is the API's `/farcaster/webhook`.

## Notes for D and Z
- Migration `0021_notifications.sql`: `notification_log` and `farcaster_notification_tokens`.
- `queue()` in `src/queues/index.ts`: route the notify queue to the batch entry point, so a batch's Farcaster sends group. Before the per-message loop, add `if (name === 'notify') return notifyQueueBatch(batch, env);` (from `src/notify/consumer.js`). Until then, notify runs per message, still correct but one request per message.
- Route: mount `farcasterWebhook` (`src/notify/farcaster-webhook.ts`, `POST /farcaster/webhook`, no session) in the route table. Add its `ENDPOINTS` row (`auth: 'none'`; request = the JFS `{header, payload, signature}`, response `{ok, result}`). `POST /push/subscribe` is already registered.
- Vars and secrets: add to `src/env.ts` the names `notify/channels/index.ts` (`NotifyVars`) and `notify/cast.ts` (`CastVars`) declare.

  | Name | Kind | Notes |
  | --- | --- | --- |
  | `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | vars | `VAPID_PRIVATE_KEY` is already a secret (OA-12) |
  | `NOTIFY_EMAIL_FROM` | var | defaults to `EMAIL_FROM` (OA-07) |
  | `NEYNAR_API_KEY`, `FARCASTER_CAST_SIGNER_UUID` | secrets | OA-11 |
  | `FARCASTER_HUB_URL` | var | already declared; the webhook answers 503 without it |
  | `EMAIL_MOCK_URL`, `FARCASTER_CAST_API_URL` | local only | honoured only when `ENVIRONMENT=local` |

  A channel or the cast whose configuration is missing is off (logged), never mocked.
- The stack: run the three mocks and point `.dev.vars` at them.
  - Keys: `node scripts/gen-vapid.mjs e2e/stack/.dev.vars` (prints only the public key).
  - `e2e/mocks/push/server.mjs` on `:8794`: subscribe with `http://127.0.0.1:8794/push/<id>`, read `GET /sent?id=`.
  - `e2e/mocks/farcaster-notify/server.mjs` on `:8795`:
    - `FARCASTER_HUB_URL` and `FARCASTER_CAST_API_URL` point there, with `NEYNAR_API_KEY=mock-neynar-key` and `FARCASTER_CAST_SIGNER_UUID=mock-signer`;
    - `POST /jfs` builds a signed webhook event whose `notificationDetails.url` is `http://127.0.0.1:8795/notify/<client>`;
    - `GET /sent?token=` and `GET /casts` read back what was sent.
  - `e2e/mocks/email/server.mjs` on `:8796`: `EMAIL_MOCK_URL`; `GET /last?to=` and `GET /sent?to=`.
  - Each mock has `GET /health` and `DELETE /sent`; add `stack:status` rows.
- `src/lifecycle/handlers.ts` `stakesVoidHandler`: `await enqueueVoidOutcomes(env, roundId)` after its statements commit.
- Interface changes for Z:
  - `SECURITY_NOTICE_KINDS` gains `identity_unlinked` (with copy);
  - the `outcome` payload gains `refundReason: RefundReasonCodeSchema.nullable()`;
  - `Channel` (`notify/types.ts`) has `available(recipient)` beside the pinned `send(batch)`.
