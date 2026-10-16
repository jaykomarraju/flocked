# Session W9-A: Notifications

**Role:** build. **Size:** M (split into `W9-A.2` if needed: the consumer, dedupe, prefs, the exclusion filter and web push first; Farcaster, email, the RoundDO alarms and the daily cast second). Subagents' tokens count toward the size. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-9.md`: the intro, "Pinned interfaces", "W9-A", and the W9-A and "All" items of every "Carry-over" section (W2-Z, W3-Z, W4-Z, W5-Z, W6-Z, W7-Z, W8-Z).
- `docs/sessions/W8-Z.md` (wave-8 summary). W9-B, W9-C and W8-F1 run alongside you; their paths are in `wave-9.md` and `docs/plan/wave-8.md` "W8-F1". Don't edit them.
- Code you build on:
  - `packages/shared/src/copy/notifications.ts` (every event's copy and channels; `question_rejected` is owner-approved, Oct 16), `packages/shared/src/{queues,enums}.ts` (the notify queue messages, `NOTIFICATION_EVENTS`, `SECURITY_NOTICE_KINDS`), `packages/shared/src/api/me.ts` (`notification_prefs`, channels);
  - where events are enqueued today: `apps/api/src/questions/{notify,final}.ts` (`question_used`, `question_edited`, `question_rejected`), `src/identity/**` (`security_notice`), `src/rounds/notifications.ts` (the RoundDO alarm hooks), `src/settlement/apply/free.ts` and `src/lifecycle/void.ts` (where Free outcomes and voids become durable), `src/indexer/handlers/stakes.ts` (Stakes outcomes);
  - `apps/api/migrations/` (`push_subscriptions`, `notification_prefs`, `farcaster_notification_tokens` if present), `apps/api/wrangler.jsonc` (the `notify` queue).
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Notifications"
  pnpm spec "Share cards and distribution" --sub "Distribution hooks"   # the daily cast bullet
  pnpm spec "Compliance and responsible play" --sub "Responsible play"  # self-exclusion
  pnpm spec "Data model"                                                # push_subscriptions, notification_prefs
  ```
  Changed in wave 8 (Decision log, Oct 16, 2026, W8-Z): "Notifications" (the `question_rejected` row: the approved copy, push only; `question_rejected`, `question_edited` and `question_used` are game notifications), "Question pipeline" (steps 1–5: rejection and the reason), "API" (Rate limits; Reveal gating: the Stakes `revealed` follows the D1 commit), "Identity and personhood" (Merging accounts; Account deletion), "Profiles, leaderboards and rooms" (Rooms; room rounds send no notifications). Read the rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'W8-Z'`.

## Objective
Build `wave-9.md` "W9-A": the `notify` queue consumer for every event in the spec's table (defaults, timing, channels), Farcaster mini app notifications, web push (VAPID, `POST /push/subscribe`), email (Cloudflare Email Service binding), `notification_prefs`, the dedupe keys, no game notifications for self-excluded users, `security_notice` on every available channel, the RoundDO alarm bodies (`question_live` only to users with no entry in the round that just closed, `closing_soon`, `streak_at_risk`), and the daily official cast at `opensAt` (mocked locally). Also the carry-over items: Stakes notifications, `refundReason` on `outcome`, void and refund notices, `identity_unlinked`, and the `question_rejected` consumer.

## Starting point
- Base: tag `wave-8`. Branch: `w9-a-notify`. Worktree: `../flocked-w9-a`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w9-a -b w9-a-notify wave-8
  cd ../flocked-w9-a && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/notify/**`, `src/routes/push.ts`, the alarm-handler bodies in `src/rounds/notifications.ts`, migration `apps/api/migrations/0021_*.sql` (with `test/migrations.test.ts`), `apps/api/test/notify/**`, `e2e/mocks/{farcaster-notify,push,email}/**`, `scripts/gen-vapid.mjs`;
  - the enqueue points only, with no other change: `src/settlement/apply/free.ts`, `src/lifecycle/void.ts`, `src/indexer/handlers/stakes.ts` (the outcome handlers: the Stakes reveal is the confirmed `OutcomeProposed`; finals and refunds at `RoundFinalized` / `RoundRefunded`, after their D1 commit), or one `onModeFinal` registration in `src/settlement/hooks.ts` where a post-final hook fits (Free apply and refund call it last; the indexer calls it after the outcome commit; room rounds send nothing);
  - `packages/shared/src/{queues,enums}.ts` and `copy/notifications.ts` for `identity_unlinked` (its copy is approved in principle, `wave-9.md` "Carry-over from W7-Z") and the `refundReason` field, with fixtures: interface changes for Z, named in the handoff.
- Must not touch: W8-F1's paths (`wave-8.md` "W8-F1" "Owns": the scheduler, `src/rooms/**`, `src/questions/{admin,submit}.ts`, boards, stats, `read/rounds.ts`, `stakes/prepare.ts`); W9-B's `packages/verify/**`; W9-C's `apps/web/**`; the registry files (`src/{app,env,index}.ts`, `routes/index.ts`, `wrangler.jsonc`, workflows, root `package.json`, `pnpm-lock.yaml`: new bindings, vars and the route registration go in "Notes for D"); `contracts/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- `wave-9.md` "Pinned interfaces": `apps/api/src/notify/channels/{farcaster,webpush,email}.ts` implement `Channel.send(batch)`; the consumer applies the spec's dedupe keys; copy only from `packages/shared/src/copy/notifications.ts`.
- The notify queue message shapes in `packages/shared/src/queues.ts` (add fields; don't rename).
- `question_rejected`: Farcaster and web push only; title "Your question was rejected", body the admin's reason, cut to 128 characters with "…" by the consumer (owner, Oct 16). `question_rejected`, `question_edited` and `question_used` are game notifications.

## Tasks
1. Create the worktree (above). Confirm `pnpm check` is green before you change anything.
2. The consumer, channels, prefs, dedupe keys and the exclusion filter; `POST /push/subscribe` (upsert on the unique endpoint; open to suspended accounts, decision B7); `identity_unlinked` in `SECURITY_NOTICE_KINDS`.
3. The outcome notices: Free (`applyFree`, `refundFree`, `applyVoid` for rule 4), Stakes (settlements, every refund reason, `claim_ready` / `payout_claimable` once claims open), the combined `outcome` at the user's first mode outcome, `refunded` only for later events.
4. The RoundDO alarm bodies with idempotency keys (they can fire twice after an eviction), and the daily cast (Farcaster signer, mocked).
5. The email mock lets a test read what was sent (W9-D's E2E-8 needs it; W8-C asked for a keyed seam route such as `GET /__test/email/last?to=`: name what you build in "Notes for D").

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required: dedupe per key; the combined `outcome` message at the user's first mode outcome; `refunded` only for later events; the exclusion filter; rate-limit batching; `question_rejected` cuts a long reason.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Every event in the spec's table is sent on its channels from the consumer, the required tests pass, and the handoff names every binding, var, route and migration W9-D must apply.

## Constraints
- Never commit secrets (VAPID keys come from `scripts/gen-vapid.mjs` into `.dev.vars`). Don't edit the spec; record spec problems in the handoff. Don't fake owner actions (OA-11 Farcaster, OA-12 VAPID, OA-07 email domain are the owner's).
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6.

## End of session
1. Commit, then `git push -u origin w9-a-notify`.
2. Write `docs/sessions/W9-A.md` from plan.md 3.2, then commit and push it.
3. End with your status and: "When W9-A, W9-B, W9-C and W8-F1 all report complete, start W9-D from `docs/prompts/W9-D.md`."
