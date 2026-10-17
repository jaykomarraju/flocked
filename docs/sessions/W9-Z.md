# Wave 9 summary

## Status

Merged to `main` at `0ae6236`, a `--no-ff` merge of `w9-integration` @ `ac37c0e`. The tag `wave-9` is on `main`'s head: the commit that adds the wave-10 prompts after this summary, so wave-10 worktrees contain them and `main` equals the tag.

- All six handoffs were `complete`: W9-A (with W9-A.2), W9-B, W9-C (with W9-C.2), W8-F1 (the wave-8 review fixes, merged by W9-D), W9-D (`partial` by design, the up-front split) and W9-D.2 (the completing one).
- **CI was red on the integration head when W9-Z started:** E2E run 38917184972 (`01bba69`, a docs commit) failed both on-stack seal tests in the `ui` job (`free-round.spec.ts` › "each player picks and seals…", `today.spec.ts` › "a Free round in the browser on the stack"). The cause was an app bug, not the tests: when `GET /me` answered after `GET /rounds/today`, `TodayScreen` drew the round, flipped to the skeleton once the round-me query started, and remounted the open round with the pick dropped, so "Seal my pick" stayed disabled (the stack log shows four round sockets for three players). W9-Z fixed it (below); `0029bdd`'s green run had simply won the race.
- **Review findings on a green wave** (plan.md 2.6, Oct 11 option, owner decision Oct 16): W9-Z's review of the flagged diffs found five defects no test catches. Finding 1 (the verifier said `match` for an empty Free bundle against an anchor that committed entries) is fixed here; R2–R4 (notify) go to **W9-F1** alongside wave 10 with the guardian-void notice; R5 (the web WS reducer) goes to W10-C, which edits `ws/live.ts` next.
- `git diff audit-candidate-1 HEAD -- contracts/src` is empty on `w9-integration` and on `main` after the merge.
- **Session size:** past M. W9-Z's own context, plus a review subagent (about 0.25M tokens) and a design subagent in Paper (about 0.4M). The first session ended mid-run (the `pnpm e2e` run and the design pass were cut off); W9-Z resumed both.
- **Worktree:** W9-Z worked in W9-D's worktree `../flocked-w9-d` (the prompt allows it), as W8-Z did.

CI:

- `w9-integration` @ `ac37c0e`: CI run 38982618948 (check, contracts, properties, static-analysis), Stack run 38982618982 (eight steps) and E2E run 38982618895 (api, ui, screens) passed on the first attempt.
- `main` @ `0ae6236` (the merge; its tree equals `ac37c0e`'s): CI run 38992687371 (check, contracts, properties, static-analysis), Stack run 38992687352 and E2E run 38992687377 (api, ui, screens) passed. The summary and prompt commits after the merge are docs only.

Local checks on `w9-integration` (Node 22.23.1):

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 508, e2e phase check 4, web 336, signer 19, verify 47, api 1398, forge 202 |
| `pnpm format:check` | pass |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | 202 passed (569 s) |
| `pnpm stack:up` + `pnpm --filter @flocked/e2e exec vitest run` + `stack:down` | 8 files, 30 tests passed (569 s) |
| fresh stack: `pnpm stack:up && pnpm e2e && pnpm stack:down` | 34 passed (27.0 min; the first run was cut off at test 19 when the session ended, and a fresh run passed) |
| fresh stack: `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` | 106 passed (8.4 min) |
| `pnpm e2e:screens` (macOS) | 77 passed (43 s), against the 88 re-exported artboards |

- On `main` after the merge (its tree equals `ac37c0e`'s): `pnpm install --frozen-lockfile && pnpm check` passed on the second run (the same counts); the first run lost one wall-time web test under load (`Today.test.tsx` › "animates the bars over 3 s the first time…" still in `grow` when its wait ran out, beside the signer suite), which passed in every other run and in CI. `pnpm format:check` and `git diff audit-candidate-1 HEAD -- contracts/src` (empty) passed.
- Nothing was skipped or weakened. Tests W9-Z changed: `free-round.spec.ts` › `phasesSeen` no longer filters a blank at the close (stricter: a remount now fails it); `rooms/review-w8.test.ts` › "holds the cap under concurrent creates" forces the four pre-checks to overlap (stricter: it no longer passes by timing); `routes.test.ts` lists `POST /farcaster/webhook` as implemented.

## On main now

- **Notifications (W9-A, `apps/api/src/notify/`):** the `notify` consumer for every event (dedupe keys claimed in `notification_log` with a lease and per-channel bookkeeping; the combined `outcome` at the first mode outcome; `refunded` for later events; self-exclusion; security notices on every channel); web push (VAPID, aes128gcm), Farcaster mini app notifications (batches of 100 tokens, rate limits, the JFS webhook checked on a hub), email (`send_email`); the RoundDO alarm bodies (`question_live`, `closing_soon`, `streak_at_risk`); the daily cast through Neynar; `POST /push/subscribe` and `POST /farcaster/webhook`; migration `0021`.
- **Verify (W9-B, `packages/verify`):** `verifyRound`, `verifyEntry`, the `flocked-verify` CLI (exit 0/1/2, `--json`, `--account`), `@flocked/verify/browser`; Free and Stakes recompute from bundles and the chain.
- **Web play (W9-C, `apps/web`):** Today (presets and slider, the crowd hint, live counts, Turnstile, the Free entry flow with the target-round and lock-leaf checks, tlock in the browser, receipt checks kept as evidence), Sealed, and the Reveal (unsealing, counting, the 3 s bars, result card, mascot, reduced motion, once per round); the WS client with "Reconnecting…" polling; Stakes hidden behind `STAKES_UI_ENABLED`.
- **W8-F1:** H1 (the tick's room budget, 10 open rooms per owner), M1–M3, L1–L6 and the five Oct 16 decisions, each mutation-checked.
- **e2e (W9-D, W9-D.2):** the push, farcaster-notify and email mocks on the stack; `notifications.spec.ts` (E2E-8), `verify-cli.spec.ts` (PIPE-6), `free-round.spec.ts` (E2E-1 Free UI, E2E-2 UI), `e2e/fixtures/{notify,browser}.ts`.
- **W9-Z fixes:** Today stays mounted while `/me` loads and at the close (`features/today/Today.tsx`: `usePlayed` waits for the session and reads the stored pick in the same render; the previous round's `GET /rounds/:id` starts from the round on screen), with two `Today.test.tsx` tests; the verifier fails a null commitment against an anchor that holds one (`packages/verify/src/verify.ts`, a tamper test); the SQL room cap's test no longer depends on timing (killed 5 of 5); `sign-in.spec.ts` uses the fixture's `installWallet`; `POST /farcaster/webhook` is in `ENDPOINTS`.
- **Design (W9-Z):** a design subagent applied W8-Z's Core-flow leftovers and W9-C's design notes in Paper and re-exported 88 artboards: the mode-toggle check on the remaining 45 Core-flow toggles (Sealed, Reveal, Stakes entry, global states) and 27 Social toggles (Verify, Boards); the Free slider as the app draws it (fill by value, caption-role end labels) on 18 artboards; "Refunded" at 0 tracking; the refund notes band quoting the shipped rule-2 line; `question_rejected` on the Farcaster and web push all-events sheets; the feedback sheet's avatar ring at 1.5 px. Decided without a Paper change and written into `docs/design/README.md` ("Kit and screen conventions (W9-Z)"): the win motion (the sheep walks off, then fades back for the end state, which the artboards show), the note spacing under the CTA, the DST notice's clock, a disabled pick keeping its selected look, the compact question and phase-title type, and counter rows (40 in the kit, 28 in screens). `screens.md` has W9-Z subsections. The app's reveal sheet now quotes the same refund line (`sheets/core/reveal.sheet.tsx`).

## Interfaces changed or added

- Migration `0021` (`notification_log`, `farcaster_notification_tokens`); `0022` unused.
- `packages/shared`: `SECURITY_NOTICE_KINDS` gains `identity_unlinked` (with copy); the `outcome` payload gains `refundReason`; `api/push.ts` gains `FarcasterWebhookRequestSchema` and `FarcasterWebhookResponseSchema`, and `ENDPOINTS` the `POST /farcaster/webhook` row (module `push`, auth `none`); `ROOM_MAX_OWNED` (W8-F1).
- `apps/api/src/notify/types.ts`: `Channel` has `available(recipient)` beside the pinned `send(batch)`. `queue()` hands the `notify` batch to `notifyQueueBatch`.
- `apps/api/src/env.ts`: `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `NOTIFY_EMAIL_FROM`, `EMAIL_MOCK_URL` and `FARCASTER_CAST_API_URL` (local only); the secrets `NEYNAR_API_KEY`, `FARCASTER_CAST_SIGNER_UUID`.
- `@flocked/verify`: `verifyRound({ rpcUrl, chainId, roundId, mode, bundleBaseUrl, drand?, addresses?, source?, reader?, onProgress? })`, `verifyEntry({ …, account }) → { report, entries, payouts }`; `bundleBaseUrl` is the API origin.
- Web: `window.__FLOCKED_LOCAL_CHAIN__` (non-production only, with `skipDailyClose`); the route imports `Today` from `features/today/Today`.
- W8-F1: `refuseOverQuota` exported from `questions/submit.ts`; `ROOM_LOCKS_PER_TICK`, `ROOM_ROUNDS_PER_TICK`; `STATS_SIZES.stakesBatches`, `drainStakesStats`; `readRoomDetail` takes the session user.
- Stack: `STACK_PUSH_PORT` `:8794`, `STACK_FARCASTER_NOTIFY_PORT` `:8795`, `STACK_EMAIL_PORT` `:8796`; a fresh VAPID pair in `.dev.vars` per run. `docs/bundle-format.md` names the public bundle route and the null-commitment rule.

## Decisions

All are owner decisions from Oct 16, 2026; the owner took every recommendation. Five Decision log rows (W9-Z): notifications; verification; web play; rooms and the archive; API.

Sections edited in `Product_Spec.md`: "Notifications" (bullets under the table: Stakes refunds with and without a proposal, a Free 1–3 refund after the Stakes outcome, `identity_unlinked`'s email), "Share cards and distribution" (Distribution hooks: the daily cast's text), "Smart contract" (Stolen anchor key: disputed means exit 2; rotations), "Identity and personhood" (Account deletion: the successor), "Profiles, leaderboards and rooms" (Rooms: `memberCount`), "API" (`POST /farcaster/webhook`; `GET /rounds` `revealing`), "Real-time and the reveal" (Reveal choreography: the counting state's 1.5 s minimum), "Client app" (Sealed: "Remind me"; Reveal: the Free win amount). `Design_Language.md` is unchanged. `docs/bundle-format.md` is edited to apply the verification decision.

- **Guardian void:** a scheduler-tick sweep (option a), as W9-F1 alongside wave 10; the spec stays as written.
- **Counting the flock:** at least 1.5 s before the bars grow; W10-C builds it, then `free-round.spec.ts` drops its proxy.
- **API:** the webhook row added and wired in W9-Z.
- **Notifications:** the as-built rules confirmed (Stakes 1/6 first outcome → `outcome`, after → `refunded`; a Free 1–3 refund after the Stakes outcome is app-only; `identity_unlinked`'s email mirrors `identity_linked`; the cast is the question alone with the round as the embed; Neynar for the cast and a hub for app keys; "Got flocked again." is W10-A's share text). With review R2, a proposed Stakes refund is told as `refunded` when final.
- **Verify:** disputed = exit 2, routine rotations keep the old key (revoked only on compromise); the bundle route and the null-commitment rule in `docs/bundle-format.md`.
- **Rooms and the archive:** the successor is active, else suspended, never merged or deleted; `memberCount` is the cap's count; `GET /rounds` shows `revealing`. W9-F1 builds them.
- **Web:** the copy approved as drafted; "Remind me" opens Settings until W11/W12; the Free win amount waits for payouts; the win motion, slider, spacing, icon and type notes decided in the design pass.
- **Owner actions:** OA-20 still in talks, not booked; OA-D4 frozen with no changes.
- **Fixes:** finding 1 in W9-Z; R2–R4 in W9-F1; R5 in W10-C; merge the green wave. W10-D is split up front into W10-D and W10-D.2 (plan.md 2.8).

## Traceability

- **Closed (✅):** TL-1 (`e2e/ui/tlock-bundle.spec.ts`, `today.spec.ts`), PIPE-6 (`packages/verify/test/cli.test.ts`, `e2e/tests/verify-cli.spec.ts`), E2E-2 (`e2e/ui/free-round.spec.ts` "E2E-2 UI" ×3 with W7-D's API half), E2E-8 (`e2e/tests/notifications.spec.ts`).
- **Advanced (🟡):** E2E-1 (Free UI: `free-round.spec.ts`; Stakes UI with personhood is W10-D.2's), AC-3 (the CLI; the `npx` build and the Verify page are W11-C's), NFR-9 (reduced motion in `reveal.spec.ts` and `Today.test.tsx`, axe on every Free-flow screen; the audit is W14-B's).
- **The W9-Z checklist** (`wave-9.md`): TL-1, E2E-1 (Free UI), E2E-2, E2E-8 and PIPE-6 above; W8-F1's items each mutation-checked (`W8-F1.md` table; W9-D re-ran 18 on the merged tree, and W9-Z's forced-overlap test kills the SQL cap's removal 5 of 5); OA-D4 confirmed frozen; the design subagent (above); migrations for wave 10: W10-A `0023`, W10-B `watcher/0001`, W10-D `0024`.

## Carry-over

- **W9-F1** (`wave-9.md` "W9-F1"; alongside W10-A/B/C, merged by W10-D; no migration): the guardian-void sweep; R2 proposed Stakes refunds; R3 lease fencing and fetch timeouts; R4 merged accounts' outcomes (plus a spec issue: a merge doesn't move push subscriptions or prefs); the room successor; `memberCount`; the archive's `revealing`.
- **W10-A:** the reveal's Share links `/s/:shareId` from `GET /rounds/:id/me` `cards`; no card in the outcome email yet; "Got flocked again." is share text; `src/notify/**` is W9-F1's. **W10-B:** disputed = unverifiable; the null-commitment fix; the bundle route; long log scans. **W10-C:** flip `STAKES_UI_ENABLED`; the counting minimum; R5 in `ws/live.ts`; the re-exported toggles; keep W9-Z's two Today tests green; its paths extend to `features/{today,sealed,reveal}` and `ws/`. **W10-D:** merge W9-F1; `stakes-round.spec.ts` from `fixtures/browser.ts` (W10-D.2); the `api` job's time.
- **Later:** W11-C (`npx @flocked/verify` publishing; one-entry verification on the Verify page; long `getLogs` scans on Base), W11-D (the service worker with `VAPID_PUBLIC_KEY`; the mini app's `webhookUrl`), W12-B (the event defaults into `packages/shared`), W13-A (the daily cast's retry alert; `notification_log` pruning; the rate-limit wall-clock flake), W13-B (notification fan-out at ~50k users; the tick's new sweep; W8-F1's H1 residual), W14-A (`contracts/deployments/84532.json`), W14-B (bundle size: tlock in the Today chunk, 188 KB / 57 KB gzip; main 404 KB / 131 KB gzip), W16-A (`8453.json`).
- **W10-Z (a design subagent):** the all-events notification sheets show four `security_notice` kinds; `identity_unlinked` (decision B6) is missing (`screens.md` notes it).
- Each is written into the later wave file's "Carry-over from W9-Z" section.

## Owner actions

- **OA-20 (gate 3, audit):** still in talks with an auditor (Oct 16), not booked, no report date. It is the critical path: W15 needs the report. `contracts/src` is unchanged from `audit-candidate-1`.
- **OA-D4:** frozen, confirmed with no changes before W10-A. **OA-D3** (frozen Oct 16) and **OA-D5** (Admin): review OA-D5 before **W11**.
- **OA-04:** Workers Paid and the deploy token, start by W10 (now). **OA-17:** the admin and guardian multisigs, start by W10 (now).
- **OA-05, OA-18, OA-19:** the watcher's second Cloudflare account, the guardian paging channel and the dead-man's switch, start by **W11** (W10-B builds the watcher against mocks; W11-B wires paging). **OA-24:** the house question backlog (14 approved), by W11.
- **OA-09:** the Coinbase OAuth app (due). **OA-10:** the Anthropic key in staging and production secrets and the Vectorize indexes before the first deploy.
- **OA-11:** Farcaster app, account, the cast signer (Neynar: `NEYNAR_API_KEY`, `FARCASTER_CAST_SIGNER_UUID`), the manifest (its `webhookUrl` is `/api/v1/farcaster/webhook`) and the hub (`FARCASTER_HUB_URL`), by W11. **OA-12:** the VAPID pair for staging (`node scripts/gen-vapid.mjs <file>`; `VAPID_PRIVATE_KEY` secret, `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` vars), by W13.

## Next wave

The prompts are `docs/prompts/W10-A.md`, `W10-B.md`, `W10-C.md`, `W9-F1.md` and `W10-D.md`. W10-A, W10-B, W10-C and W9-F1 run in parallel from the tag `wave-9`; W10-D merges all four and emits `W10-D.2` (the Stakes UI e2e: E2E-1 Stakes UI, E2E-4 UI, E2E-5), which emits the W10-Z prompt.

Migrations are reserved: W10-A `0023`, W10-B `apps/watcher/migrations/0001`, W10-D `0024`. W9-F1 has none.

Changes from `wave-10.md` as first planned: W9-F1 runs alongside and W10-D merges it; W10-D is split into W10-D and W10-D.2; W10-C also owns `features/{today,sealed,reveal}` and `ws/` for the Stakes toggle, the counting minimum and R5; W10-B reads `packages/verify`'s sources (no README yet); the W10-Z checklist gains a design subagent for the `identity_unlinked` row on the all-events sheets.
