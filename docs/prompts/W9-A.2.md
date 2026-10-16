# Session W9-A.2: Notifications (continued)

**Role:** build. **Size:** M. Continues `W9-A` on its branch (plan.md 2.6). Subagents' tokens count toward the size. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/sessions/W9-A.md` (what W9-A built, its open issues and Notes for D). `docs/prompts/W9-A.md` stays the scope: everything there applies here, including "Must not touch".
- `docs/plan/wave-9.md`: "Pinned interfaces", "W9-A", and the W9-A items of "Carry-over from W3-Z", "W7-Z" and "W8-Z".
- Code you build on: `apps/api/src/notify/**` (the consumer, `Channel` in `types.ts`, `recipient.ts`, `render.ts`, `channels/webpush.ts` as the pattern), `apps/api/src/rounds/hooks.ts` (`notificationsFor`: the RoundDO alarm seam; the W9-A prompt calls it `src/rounds/notifications.ts`), `apps/api/src/auth/email.ts` (how sign-in codes use the `EMAIL` binding), `apps/api/src/stats/**` and migration `0018` (stray streaks), `apps/api/src/local/seam.ts` (read only: the seam is D's to register), `e2e/mocks/push/server.mjs` (the mock pattern).
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Notifications"
  pnpm spec "Share cards and distribution" --sub "Distribution hooks"   # the daily cast bullet
  ```

## Objective
Finish `wave-9.md` "W9-A": the Farcaster channel (mini app notifications: token storage from the mini app's webhook events, rate limits, batching), the email channel (Cloudflare Email Service binding), the RoundDO alarm bodies (`question_live` only to users with no entry in the daily round that just closed, `closing_soon` to users not yet entered, `streak_at_risk` to users with a stray streak ≥ 3 not yet entered; daily rounds only), and the daily official cast at `opensAt` (Farcaster signer, mocked locally), with the email and Farcaster mocks.

## Starting point
- Branch `w9-a-notify` (pushed by W9-A), worktree `../flocked-w9-a` (create it from `origin/w9-a-notify` if it is gone).
  ```bash
  cd ../flocked-w9-a && git pull && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- Same as `docs/prompts/W9-A.md`. In particular: `apps/api/src/notify/**`, the `notificationsFor` body in `src/rounds/hooks.ts`, migration `0021` (still unmerged: add to it, don't add `0022`, which is W9-D's), `apps/api/test/notify/**`, `e2e/mocks/{farcaster-notify,email}/**`.
- Registry files stay D's: the webhook route, the seam route, new vars and bindings go in "Notes for D".

## Pinned interfaces
- `channels/farcaster.ts` and `channels/email.ts` implement `Channel` (`apps/api/src/notify/types.ts`) and are added in `channels/index.ts` (`channelsFor`). Copy only from `packages/shared/src/copy/notifications.ts`.
- The notify message shapes in `packages/shared/src/queues.ts` (add fields; don't rename).

## Tasks
1. Confirm `pnpm check` is green on the branch before changing anything.
2. Farcaster: `channels/farcaster.ts` (POST to each token's `url` with `notificationId` = the dedupe key, title, body, `targetUrl`, up to 100 tokens per request; `invalidTokens` disable their row, `rateLimitedTokens` retry). Batch across the queue batch: today `src/queues/index.ts` calls the handler per message; add a batch entry point in `notify/` that groups identical sends, and name the one-line change to `HANDLERS` (or the `queue()` hook) for D. The webhook handler (`notify/farcaster-webhook.ts`): verify the JSON Farcaster Signature against the user's app key, then upsert or disable `farcaster_notification_tokens`; its route and `ENDPOINTS` row go in "Notes for D". `e2e/mocks/farcaster-notify/` records sends and can answer invalid or rate-limited tokens.
3. Email: `channels/email.ts` through the `EMAIL` binding (as `auth/email.ts` does): subject, preheader, heading, body, CTA, the `OUTCOME_NEXT_LIVE` paragraph and `EMAIL_NEXT_LINK` when `nextLive`, `EMAIL_CHROME` footer (security notices say they are always on), no card image; the sender var is for D. `e2e/mocks/email/` plus a keyed seam route such as `GET /__test/email/last?to=` (W8-C, for W9-D's E2E-8), named in "Notes for D".
4. `notificationsFor` in `src/rounds/hooks.ts`: recipients as in the Objective, keys `{event}:{roundId}:{userId}` (the consumer drops a second alarm's repeat), only users with a reachable channel, room rounds none. The daily cast at `opensAt`, idempotent through `notification_log` (`user_id` NULL), Farcaster signer mocked; the signer's vars for D. Don't fake OA-11.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required (the W9-A list's remainder): rate-limit batching (100 tokens per request; rate-limited tokens retried, invalid ones disabled); the alarm bodies' recipient rules and their idempotency keys; the email body (the next-question paragraph, the footer); the daily cast sent once per round.

## Definition of done
- Every event in the spec's table is sent on all its channels from the consumer, and the handoff names every binding, var, route and migration W9-D must apply.

## Constraints
- As in `docs/prompts/W9-A.md`. Never commit secrets; stage files by name; commits end with the attribution line from your system reminder.

## End of session
1. Commit, then `git push`.
2. Update `docs/sessions/W9-A.md` (status, summary, files, tests, Notes for D) from plan.md 3.2, then commit and push it.
3. End with your status and: "When W9-A, W9-B, W9-C and W8-F1 all report complete, start W9-D from `docs/prompts/W9-D.md`."
