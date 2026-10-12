# Session W7-B: Identities, merges, deletion, limits

**Role:** build. **Size:** M (split into `W7-B.2` if needed: linking, unlinking, merges, the cap across merges and `ageAttested` first; deletion, limits, self-exclusion and the W3-Z auth carry-over second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-7.md`: the intro, "Pinned interfaces", "W7-B", and the W7-B and "All" items of every "Carry-over" section (W2-Z, W3-Z, W5-Z, W6-Z).
- `docs/sessions/W6-Z.md` (wave-6 summary). W6-F1 runs alongside you; its files are listed under "Owns" in `docs/plan/wave-6.md` "W6-F1". Don't edit them.
- Code you build on:
  - `apps/api/src/routes/me.ts` (the identity, merge, email, deletion and referral stubs; `PATCH /me`; `POST /me/tos`; `meView`) and `routes/limits.ts` (stub); `packages/shared/src/api/{me,limits,index}.ts` (the `ENDPOINTS` rows, `TosState`, `AcceptTosRequest`);
  - `apps/api/src/auth/**` (`accounts.ts` `findAccount`, `email.ts`, `siwe.ts`, `farcaster.ts`, `profile.ts` `buildMe` and `stakesReasons`), `do/auth-do.ts` and `routes/auth.ts` (`/auth/email/verify`);
  - `apps/api/src/personhood/{flow,verify,eligibility}.ts`: W5-B's Coinbase flow, the pending merges its callback creates, `person_tombstones`, `stakesAgeRequirement`;
  - read only (W6-F1 owns them): `apps/api/src/stakes/cap.ts` (`effectiveDailyCap`, `DEFAULT_DAILY_STAKE_CAP`, `stakedOnGameDay`), `stakes/prepare.ts` and `personhood/age.ts`;
  - `apps/api/src/points/index.ts` (ledger reasons, `merge` movements), `security_notice` in `packages/shared/src/queues.ts`, and the merge notices in `packages/shared/src/copy/notifications.ts` (read only; frozen with OA-D4).
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Identity and personhood" --sub "Identities"            # with Suspended accounts
  pnpm spec "Identity and personhood" --sub "Account deletion"
  pnpm spec "Identity and personhood" --sub "Merging accounts"
  pnpm spec "Identity and personhood" --sub "Entry tickets (Stakes)"  # the cap per person
  pnpm spec "Compliance and responsible play" --sub "Responsible play"
  pnpm spec "Compliance and responsible play" --sub "Age and terms"
  pnpm spec "Data model"     # rows identities, merges, limits, users, person_tombstones, audit_log
  ```
  Changed in wave 6 (Decision log, Oct 12, 2026): "Identity and personhood" (Account deletion: `GET /claims?wallet=` serves the wallet's own room-round payouts; Entry tickets: `personTag` uses the round ULID, and the cap counts an unused ticket until the indexer passes its expiry), "Compliance and responsible play" (Age and terms: `ageAttested: 18 | 21`; the `geo.stakes.age21` region rules and the unknown-region rule), "Data model" (`users.age_attested_min`, `stakes_tickets.game_day`) and "API" (`/claims` with room-round items). Read the Oct 12 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 12'`.

## Objective
Implement the identity and responsible-play rules of `wave-7.md` "W7-B": linking with proof (SIWE, Farcaster, email code, Coinbase through W5-B's flow) with auto-offered Farcaster-verified wallets; the unlink limits; pending merges and their confirmation with every refusal rule, the kept-account transfers (paired `merge` ledger rows per scope) and the 30-day limit; account deletion; limits (decrease now, increase after 24 h); self-exclusion; `security_notice` enqueues; `audit_log` rows. Also:
- the carry-over: W3-Z (reserved handles, email enumeration, email codes through `AuthDO`, AuthDO KV errors, the `users` migration test, unverified identity rows, suspended accounts), W5-Z (tombstones at deletion, the callback's pending merges, no unlinking the coinbase identity, `stakesReasons`) and W6-Z (below);
- `ageAttested: 18 | 21` on `POST /me/tos`, refused below the age the request requires;
- the daily cap and the one-live-ticket rule per person across merges, and across deletion and re-verification on the same game day.

## Starting point
- Base: tag `wave-6`. Branch: `w7-b-identity`. Worktree: `../flocked-w7-b`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w7-b -b w7-b-identity wave-6
  cd ../flocked-w7-b && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/identity/**` and `apps/api/src/limits/**` (new);
  - `apps/api/src/routes/me.ts` (the identity, merge, email, deletion and referral handlers delegating to `src/identity/**`; `PATCH /me`; `POST /me/tos`), `routes/limits.ts`, and in `routes/auth.ts` only the email-verify fix;
  - `apps/api/src/auth/**` and `do/auth-do.ts`; `apps/api/src/personhood/{flow,verify}.ts` only for the merge and tombstone rules;
  - `packages/shared/src/api/me.ts` and `packages/shared/test/fixtures/api/me.json`; `packages/shared/src/api/limits.ts` and its fixture only where a field is missing (a note for Z); a reserved-handles module in `packages/shared/src/` with its test, and its one export line in `packages/shared/src/index.ts`;
  - migration `apps/api/migrations/0015_*.sql`, and `apps/api/test/migrations.test.ts` (your tables and the W3-Z `users` test);
  - `apps/api/test/{identity,limits,me,auth}/**`, and `docs/sessions/W7-B.md`.
- Must not touch:
  - W6-F1's files (`wave-6.md` "W6-F1", "Owns"), in particular `stakes/{cap,prepare}.ts`, `personhood/age.ts`, `rounds/entry.ts`, `routes/entries.ts` and `read/**`. If the cap query must change (to count a merged or tombstoned account's stakes and tickets), write the exact change under "Notes for D"; W7-D applies it on top of W6-F1;
  - W7-A's `apps/api/src/ws/**`, `do/round-viewer-do.ts`, `do/round-do.ts`, `rounds/hooks.ts`, `routes/rounds.ts` and `packages/shared/src/ws.ts`; W7-C's design files; `packages/shared/src/copy/**` (report a copy change for W7-Z instead);
  - the registry files (`apps/api/src/{app,env,index}.ts`, `routes/index.ts`, `wrangler.jsonc`, `.github/workflows/*`, root and `e2e/` `package.json`, `pnpm-lock.yaml`) and `e2e/**`;
  - `contracts/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- `wave-7.md` "Pinned interfaces", Identity: the nine endpoints. They are `me`-module rows in `ENDPOINTS`, so their handlers sit in `routes/me.ts` and delegate to `src/identity/**` (W2-Z); `PUT /me/limits` and the exclusion lift are `limits`-module rows in `routes/limits.ts`. `GET /me/referrals` returns an empty list until W8-B.
- Responses conform to `packages/shared/src/api/{me,limits}.ts`. Change only `AcceptTosRequest.ageAttested` (to `18 | 21`) and `TosState.ageRequired` (to required); anything else is a note for Z.
- Balances move through `src/points/index.ts`: paired `merge` rows per scope, idempotent under the ledger's unique key. `security_notice` goes through the `notify` queue (`NotifyMessageSchema`).
- Reuse `effectiveDailyCap(row, t)` and `DEFAULT_DAILY_STAKE_CAP` from `src/stakes/cap.ts`; import them, don't edit the file.

## Tasks
1. Create the worktree (above).
2. Linking and unlinking (incl. the coinbase identity, and a wallet with non-final Stakes entries or unclaimed payouts); unverified wallet and Farcaster rows never block sign-in (`findAccount`).
3. Merges: creation never inside an OAuth callback, confirmation by signing in to the other account (incl. the callback's pending merges, 7-day TTL), every refusal, and the kept-account transfers in one atomic batch. Carry both accounts' game-day stakes and live tickets to the kept account, so the cap and the one-live-ticket rule hold.
4. Deletion: anonymize, tombstone with the cap state (`person_tombstones`), expire merges, enqueue the card re-render, and refuse during exclusion, suspension or non-final rounds. A person who deletes and verifies again the same game day must not start the cap at zero.
5. Limits and self-exclusion per the spec; `audit_log` rows and `security_notice` enqueues where it says.
6. `POST /me/tos` takes `ageAttested: 18 | 21`, records it, and refuses one below `stakesAgeRequirement`. `TosState.ageRequired` becomes required, in the schema and `me.json`.
7. The W3-Z and W5-Z carry-over items, each with a test. Suspended accounts: every write route you own refuses `account_suspended` (entries and `/prepare` already do); list any other write route in Open issues.
8. Check the merge notices ("Account merge pending", "Accounts merged") against the confirmation flow, and report any copy change for W7-Z.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required: ID-1 (all) in `apps/api/test/identity/*.test.ts`; E2E-9 at the API level with the test clock (a timed exclusion can't be shortened; a permanent one lifts only 7 days after a request made 6 months in); deletion anonymizes and keeps ledger rows; a merge moves balances atomically with paired ledger rows; `ageAttested` below the required age is refused; the cap per person after a merge and after deletion and re-verification; each carry-over item with a test that fails without it.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Every endpoint in the Identity pin answers per its schema with the spec's rules, and the carry-over items are closed.
- The listed tests pass, and ID-1 and E2E-9 (API) are named with their tests in the handoff. The handoff is written.

## Constraints
- Never commit secrets; tests generate keys.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W7-B.2`).

## End of session
1. Commit, then `git push -u origin w7-b-identity`.
2. Write `docs/sessions/W7-B.md` from plan.md 3.2. Put any `cap.ts` change, the `index.ts` export, schema changes and the merge-notice copy report under "Notes for D and Z". Commit and push.
3. End with your status and: "When W7-A, W7-B, W7-C and W6-F1 all report complete, start W7-D from `docs/prompts/W7-D.md`."
