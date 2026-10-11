# Session W5-B: Personhood

**Role:** build. **Size:** M (split into `W5-B.2` if needed: Coinbase sign-in, the callback and the person ID first; attestations, geo and eligibility second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-5.md`: the intro, "Pinned interfaces", "W5-B", and the W5-B and "All" items of every "Carry-over" section (W2-Z, W3-Z, W4-Z).
- `docs/sessions/W4-Z.md` (wave-4 summary).
- Code you build on:
  - `apps/api/src/routes/me.ts` (its personhood rows in `ENDPOINTS` are stubs you replace) and `apps/api/src/routes/index.ts` (read only);
  - `apps/api/src/auth/**`: sessions, `findAccount` in `accounts.ts`, and `AuthDO`, which holds single-use OAuth state;
  - `apps/api/src/do/auth-do.ts`;
  - `packages/shared/src/api/me.ts`;
  - the `users` and `identities` tables in `apps/api/migrations/0001_*.sql` and `0002_auth.sql`;
  - `e2e/mocks/farcaster/`, as the pattern for a mock server.
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "Identity and personhood" --sub "Personhood (verified Coinbase sign-in)"
  pnpm spec "Identity and personhood"                     # also the "Account deletion" tombstone bullet
  pnpm spec "Compliance and responsible play" --sub "Geo-fencing"
  pnpm spec "Compliance and responsible play" --sub "Age and terms"
  ```
  Changed in wave 4 (Decision log, Oct 11, 2026): "Identity and personhood" › Entry tickets (no ticket while a void is requested; the settlement-hold release), not your sub-blocks. Read the Oct 11 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 11'`.

## Objective
Build Coinbase sign-in for personhood:
- `POST /me/personhood` returns an authorize URL, with PKCE where Coinbase supports it, and single-use state bound to the user in `AuthDO`.
- `GET /me/personhood/callback` attributes the result only to the state's user. It reads `/v2/user` and `/v2/user/personal-details`, and stores only:
  - `person_id`, an HMAC with `PERSON_ID_KEY`;
  - the country and region;
  - `kyc_status`.

  If the person ID is already bound to another account, the callback creates a pending merge.

Also build:
- the Verified Account and Verified Country attestation lookup (an EAS indexer client);
- the geo rules (`geo.stakes.allow`, `request.cf`, proxy signals);
- the person tombstone check on verification;
- Stakes eligibility in `GET /me`, through `stakesEligibility`.

Add a Coinbase mock server in `e2e/mocks/coinbase/` and an EAS indexer mock in `e2e/mocks/eas/`. Build to the documented API shape. OA-22 confirmed that personal details come back only for ID-verified accounts.

## Starting point
- Base: tag `wave-4`. Branch: `w5-b-personhood`. Worktree: `../flocked-w5-b`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w5-b -b w5-b-personhood wave-4
  cd ../flocked-w5-b && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/personhood/**`;
  - the personhood handlers in `apps/api/src/routes/me.ts`: replace their stubs and delegate to `src/personhood/**`;
  - `packages/shared/src/api/me.ts`, including the `IneligibleReason` enum;
  - in `apps/api/src/auth/accounts.ts`, only the fix for unverified identity rows (W3-Z carry-over), with its test;
  - migration `apps/api/migrations/0009_*.sql`, `apps/api/test/personhood/**`, and `apps/api/test/migrations.test.ts` for your tables;
  - `e2e/mocks/{coinbase,eas}/**`;
  - `docs/sessions/W5-B.md`.
- Must not touch:
  - W5-A's `apps/api/src/{settlement,queues}/**` and `do/settlement-do.ts`;
  - W4-F1's `apps/api/src/{chain,scheduler,indexer,lifecycle}/**` and `do/{anchor-do,indexer-do,round-do}.ts`;
  - the registry files: `apps/api/src/{app,env,index}.ts`, `routes/index.ts`, `wrangler.jsonc`, `.github/workflows/*`, root and `e2e/` `package.json`, and `e2e/stack/**`. New secrets, vars and the mock servers' stack wiring go in "Notes for D";
  - `contracts/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- `wave-5.md` "Pinned interfaces": `stakesEligibility(env, user, request) → { eligible, reasons: IneligibleReason[] }` in `apps/api/src/personhood/eligibility.ts`; the reasons enum in `packages/shared/src/api/me.ts`, which you own this wave.
- The `ENDPOINTS` rows and response schemas pinned by W2-D. Changing a response shape needs a note for Z.

## Tasks
1. Create the worktree (above).
2. W3-Z carry-over first: a Coinbase identity must not block sign-in. Today `findAccount` ignores unverified identity rows, so a create can hit the unique index and answer 500. Fix that, with a test.
3. Coinbase sign-in: authorize URL, state and callback per the Objective, using the mock in tests.
4. Attestations (EAS indexer client and mock), geo rules, the tombstone check, and `stakesEligibility` in `GET /me`.
5. Pending merge when the person ID is bound to another account. Create the pending row only; W7-B builds the merge flow.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required:
  - ID-2;
  - ID-3 (login CSRF): a callback carrying another user's cookie attributes only to the state's user, and a replayed state fails;
  - no raw Coinbase ID, name or address is stored (part of NFR-8, asserted by a DB scan);
  - a country mismatch makes the user ineligible;
  - missing personal details mean not verified;
  - an unverified identity row doesn't block sign-in.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- A user can verify through the mock Coinbase flow, and `GET /me` reports Stakes eligibility with reasons.
- The listed tests pass, and ID-2, ID-3 and the NFR-8 part are named with their tests in the handoff. The handoff is written.

## Constraints
- Never commit secrets. `PERSON_ID_KEY` is a Workers secret; tests use a throwaway key. Never log Coinbase payloads.
- Don't edit the spec; record spec problems in the handoff, especially anything about the Coinbase API you can't verify (gate 2). Don't fake owner actions: the real OAuth app is OA-09, for W14.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W5-B.2`).

## End of session
1. Commit, then `git push -u origin w5-b-personhood`.
2. Write `docs/sessions/W5-B.md` from plan.md 3.2. Put secrets, vars and the mock servers' stack wiring for D under "Notes for D and Z". Commit and push.
3. End with your status and: "When W5-A, B, C and W4-F1 all report complete, start W5-D from `docs/prompts/W5-D.md`."
