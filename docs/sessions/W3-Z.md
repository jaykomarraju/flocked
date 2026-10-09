# Wave 3 summary

## Status

Merged to `main` at `edb3059` (a `--no-ff` merge of `w3-integration` @ `a1a7299`). The tag `wave-3` sits on `main`'s head, the commit that adds this summary and the wave-4 prompts, so wave-4 worktrees contain them and `main` equals the tag.

CI on `w3-integration` @ `a1a7299`: CI run 37896244133 passed (check, contracts, properties), and Stack run 37896244154 passed (`smoke`). Both workflows also passed on W3-D's head (37884178893, 37884178920). On `main` @ `edb3059`, CI run 37896614331 and Stack run 37896614332 passed.

Local checks before the merge and on `main` after it (Node 22.23.1):

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` | node:test 20, abi 13, settle 66, tlock 176, shared 438, api 427, forge 199 |
| `pnpm format:check` | pass |
| `FOUNDRY_PROFILE=ci forge test` | 199 |
| `pnpm stack:up` + `stack-smoke.test.ts` | 6 passed; stack up in 17.8 s |

- All four handoffs were `complete` (W3-C finished through W3-C.2).
- Nothing was skipped or weakened.
- The first local `pnpm check` failed once on DO-3's timing precondition (see Carry-over). It passed on the eight reruns, including two full `pnpm test` runs under load.

## On main now

- **Auth (W3-A):**
  - Sign-in: SIWE (EOA, ERC-1271, ERC-6492 through an injectable RPC client), Farcaster Quick Auth, and 8-digit email codes. Email signs in only.
  - Account creation: only SIWE or Farcaster, behind Turnstile, with the 500-point signup grant and pending referrals.
  - Sessions: an HttpOnly cookie or a Bearer token, hashed in D1, lasting 30 days.
  - `AuthDO` holds nonces, email codes and OAuth state. `RateLimitDO` holds token buckets.
  - `/me`: `GET`, `PATCH` and `POST /me/tos`. Email sign-ins send security notices.
  - `0002_auth` rebuilds `users` to make `handle` nullable.
- **RoundDO Free path (W3-B):**
  - `init`, `enterFree` and `getState`.
  - Gap-free `seq`, allocated in SQL at commit. An identical retry replays the original receipt.
  - EIP-712 receipts built with the shared builder.
  - The alarm chain: open → streak_at_risk → closing_soon → close → settle → rule 8.
  - Close: drain, D1 seal, reconcile, root from `freeCommitmentTree`, then hand-off to AnchorDO (still a stub).
  - `POST /rounds/:id/entries`, with the daily grant on first entry. `0003_round_do` adds `daily_grant_skips`.
- **`@flocked/tlock` (W3-B):**
  - A non-canonical G2 `U` is `decrypt_failed`.
  - Environment errors are rethrown instead of becoming VOIDs.
  - A once-per-isolate self-test runs before the first `classify`.
- **Local stack (W3-D):**
  - `pnpm stack:up` / `stack:down` / `stack:status`.
  - Three drand nodes (`go-drand-local`), anvil 31337, the CREATE2 deploy, D1 migrations, `wrangler dev --local` and the Farcaster mock.
  - The `/__test/*` seam: local only, behind a per-run key.
  - The stack smoke test: a real Free round from SIWE to reveal, including tlock in the `wrangler dev` bundle.
  - `.github/workflows/stack.yml`.
- **Design (W3-C):**
  - Colour decisions in the tokens and schema (`muted`, `scrim`, `accentInk`).
  - The core round flow in Paper: 37 states × 3 breakpoints, exported to `docs/design/exports/core/`. The inventory and decisions are in `docs/design/screens.md`.

## Interfaces changed or added

- `apps/api/src/auth/**`:
  - `sessionMiddleware` follows the wave-3 contract;
  - `RATE_LIMITS`, `enforce`, `limitAuthIp`, `limitUser`;
  - `issueEmailCode`/`checkEmailCode`/`normalizeEmail`, `findAccount`, `enqueueSecurityNotice`, `authDOFor(env, kind, hash)`.
  - Test helper: `realSession` in `test/helpers/auth.ts`.
- `apps/api/src/rounds/{entry,grant,schedule,close,hooks}.ts`. `applyDailyGrant` is the only correct path for a daily grant (never `grantMovement`). `apps/api/src/crypto/receipt.ts`.
- `apps/api/src/local/seam.ts`: clock, round create/lock/read, reveal. `env.ts` gains `LOCAL_DEPLOYMENT` and `FLOCKED_TEST_SEAM_KEY`. `wrangler.jsonc` gains `TOS_VERSION` (placeholder `2026-10-01`), and its `run_worker_first` includes `/__test/*`.
- Migrations: `0002_auth`, `0003_round_do`. `0004` was reserved but not used.
- `packages/shared`: the tokens gain `scrim` (`HexAlpha`). `packages/abi`: the receipt fixture uses settle's `userIdHash`.
- `e2e/` is now a workspace package (`@flocked/e2e`) with `e2e/stack/*`, `e2e/mocks/farcaster/*` and `e2e/tests/stack-smoke.test.ts`.
- CI: tlock's `classify.properties.test.ts` joins the properties job. A new Stack workflow runs on `main` and `w*-integration`.

## Decisions

The owner made 18 decisions on Oct 9, 2026, all on the recommended option, and approved the copy. Seven Decision log rows are dated Oct 9.

- **Identity and auth:**
  - `users.handle` is null until the user picks one, with a reserved-handle blocklist (W7-B).
  - The `/auth/*` endpoints share one per-IP bucket of 30 a minute, keyed by a hash of the IP.
  - Suspended accounts can sign in to read and claim; write routes refuse `account_suspended`.
  - Turnstile is optional on `/auth/email/start`.
- **Rounds:**
  - `daily_grant_skips` is adopted as built.
  - Room rounds grant +100 below 1,000, and a skip is final for that round (W8-D).
  - An empty Free mode anchors nothing and refunds under rule 1.
  - Turnstile on the first Free entry and the grant anti-farming rule go to W4-A; first-visit grants go to W6-D.
- **Design:**
  - Numerals on the accent are allowed at 24px or larger.
  - `prefs.showStakesNet` controls public display only.
  - The crowd-history hint shows the category's average winning share over its last 30 settled daily rounds, once there are 5.
  - The unsealing countdown is m:ss.
  - 18+ and ToS are collected in the Stakes verification sheet.
  - On tablet and desktop, Submit, Queue, Claims and Settings sit in the header avatar menu.
  - The stale navigation-sheet note goes to W5-C.
- **Copy:** the eight refund lines are approved, with rule 2 ending "Everyone gets their stake back.", along with the part-2 core-flow copy. Part-1 copy is reviewed in Paper with OA-D2.
- **Testing:** the e2e wording names `go-drand-local`, and the Base fork is optional.
- **Code review (owner's call):** the email-enumeration leak goes to W7-B, not a fix session.
- **Z's own calls:**
  - first-visit grants go to W6-D rather than W4-A (W6-D builds `GET /rounds/today`, which is the visit);
  - W4-A owns `routes/entries.ts` and `rounds/grant.ts` this wave, and W4-D owns `round-do.ts`;
  - the checkbox names 21 where a region requires it;
  - the acceptance criterion now requires a Free commitment only when the mode has entries.
- **Spec sections edited:** "Sealed picks (timelock encryption)", "Settlement and payout math", "Modes: Free and Stakes", "Identity and personhood", "Data model", "API", "Real-time and the reveal", "Client app", "Compliance and responsible play", "Testing and acceptance criteria", and the Decision log. In Design_Language.md: "Typography" and "Voice".

## Traceability

- Closed (✅): ID-4, DO-1, DO-2, DO-3 and DO-4. TL-3 now also names W3-B's `U`, environment and property tests.
- Partly proven (🟡):
  - NFR-8: the IP part only. Person tags are W5-B; the log and storage scan is W13-C.
  - DO-5: the alarms only. The snapshot is W7-A.
  - TL-1: now also checked in the `wrangler dev` bundle. The browser half is W9-C.
- No row due this wave is still open.

## Carry-over

The details are in each later wave file's "Carry-over from W3-Z".

- **W4-A:** Turnstile on the first Free entry of the day; the daily-grant anti-farming rule.
- **W4-D:**
  - RoundDO hardening: re-`init` calls `advance()`, event backoff and alert throttling, an identical replay after close, and the root-write check;
  - `requestVoid`, `onModeResult` and the `ingestStakesEntry` counters;
  - make the DO-3 in-flight precondition deterministic;
  - the open → closed → committed check on this stack;
  - pin `ubuntu-24.04` if Ubuntu 26 breaks the Stack job after Oct 19.
- **W5-C:** the Paper navigation-sheet note and the countdown exception. **W5-B / W7-B:** unverified identity rows must not block sign-in.
- **W6-D:** first-visit daily grants through `applyDailyGrant`. **W6-A:** the rest of Stakes ingestion.
- **W7-B:**
  - reserved handles;
  - the email-enumeration fix;
  - email codes written through the AuthDO (stale KV);
  - AuthDO KV error handling;
  - a `users` migration-equivalence test;
  - `account_suspended` on every write route.
- **W7-D:** a Turnstile siteverify mock; reuse the seam and `e2e/stack/env.mjs`; make the seam's 404 body match the app's.
- **W8-D:** room-round grants. **W8-B:** the crowd-history hint.
- **W9-A:** idempotency keys for RoundDO notifications. **W9-C:** the copy table keyed by `RefundReasonName`, the avatar menu, the m:ss countdown.
- **W13-A:** a cron sweep for expired sessions. **W13-C:** review the sticky tlock self-test.
- **W14-D:** watch KV consistency in the soak.
- **Reviews:** two adversarial reviews (auth; round and seam) found no blockers. The seam can't run outside `ENVIRONMENT=local` with a key, and every acknowledged entry is in the root.

## Owner actions

- **OA-20 (book an auditor now):** not booked yet. W4-C still prepares the package, W4-Z tags `audit-candidate-1` and hands you `docs/audit/package.md`, and the report is needed by W15.
- **OA-D2 (needed by W9):** review the core flow in Paper: 37 states × 3 breakpoints, inventory in `docs/design/screens.md`, part-1 copy on the artboards. The reveal PNGs include a notes band, and dark-mode screens aren't drawn.
- **OA-21 (in progress):** ToS and privacy text by W12. `TOS_VERSION` is a placeholder until then.
- **Done:** OA-01 (OrbStack), OA-D1 (foundations frozen; the one stale note goes to W5-C), OA-22 (Coinbase personhood confirmed).
- Nothing else is due in waves 4–5. OA-D3 follows W5-C, and OA-04 starts by W10.

## Next wave

- Prompts:
  - `docs/prompts/W4-A.md` (scheduler, lock, AnchorDO, plus Free-entry anti-abuse), `W4-B.md` (chain indexer) and `W4-C.md` (contracts audit prep) run in parallel;
  - `W4-D.md` (lifecycle wiring) starts after all three report complete.
- Changes from the wave file:
  - W4-A's and W4-D's extra scope as above;
  - anvil-backed tests go in `e2e/tests/{anchor,indexer}-*.test.ts` against the stack, and D adds them to the Stack job;
  - W4-C also owns the generated `packages/abi/src/**` and the `gen.mjs` hash fix.
- Migrations: W4-A `0005`, W4-B `0006`, W4-D `0007`.
