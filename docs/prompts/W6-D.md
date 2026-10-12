# Session W6-D: Read APIs, claims, reveal gating

**Role:** integrate. **Size:** M (split into `W6-D.2` if needed: the three merges, the registrations, rule 4's `refund` rows and `GET /rounds/today`, `/rounds/:id` and `/rounds` first; `/rounds/:id/me`, `/verify`, the claims, the gating sweep and the stack tests second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template), 3.4 (Z checklist) and 4 (Global conventions); 3.1 (Session prompt template) when you draft the Z prompt. Read nothing else in `plan.md`.
- `docs/plan/wave-6.md`: the intro, "Pinned interfaces", "W6-D", "W6-Z checklist", and the W6-D and "All" items of every "Carry-over" section (W2-Z, W3-Z, W4-Z, W5-Z).
- `docs/sessions/W5-Z.md` (wave-5 summary). The handoffs `docs/sessions/W6-A.md`, `W6-B.md` and `W6-C.md`. Then `docs/bundle-format.md` and `e2e/stack/README.md`.
- Code:
  - `apps/api/src/routes/{rounds,claims,entries}.ts` (stubs; `GET /rounds/:id/me` is in the `entries` module) and `packages/shared/src/api/{rounds,claims,entries,index}.ts`;
  - `apps/api/src/settlement/apply/{free,stakes}.ts` and `settlement/types.ts`;
  - `apps/api/src/lifecycle/void.ts` (`applyVoid`) and `apps/api/src/rounds/grant.ts` (`recordPriorTransactions`, `applyDailyGrant`);
  - `apps/api/src/local/seam.ts` (W6-A's Stakes additions) and `.github/workflows/stack.yml`;
  - the registry files.
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "API"                                                # the rows for the endpoints in the Objective
  pnpm spec "API" --sub "Reveal gating"
  pnpm spec "Identity and personhood" --sub "Account deletion"   # only the bullet on GET /claims?wallet=
  ```
  Changed in wave 5 (Decision log, Oct 12, 2026): "Round lifecycle" (`revealed_at` is set for every reveal, refunds by rules 1–3 included), "Settlement and payout math" (Refund rules; Settlement output), "Data model" (`settlements`, `payouts`; Archival: modes refunded before the reveal publish no bundle), "Identity and personhood" (Merging accounts) and "Client app" (the Round detail, Archive and Verify rows). Read the Oct 12 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 12'`.

## Objective
Merge W6-A, W6-B and W6-C, then build the read endpoints:
- `GET /rounds/today`: the full locked config, the Stakes `RoundConfig`, the author's handle and payout address, the beacon round and time, counts; edge cache 5 s;
- `GET /rounds/:id`, with each mode's settlement once revealed, and `GET /rounds?before=&limit=`;
- `GET /rounds/:id/me`: entries, receipts, inclusion proofs, result, payout, claim proof;
- `GET /rounds/:id/verify`;
- `GET /claims` (merged accounts included) and `GET /claims?wallet=` (from public bundle data, no sign-in).

Enforce reveal gating everywhere: no per-option data before `revealed_at`, and room rounds for members only. Make rule 4's Free refunds write `refund`-kind `payouts` rows (owner decision, Oct 12).

## Starting point
- Check first (plan.md 2.6): all three handoffs (W6-A, B and C) must be `complete`. If any isn't, stop and emit its continuation prompt plus a fresh W6-D prompt.
- Create `w6-integration` from `main` (which equals tag `wave-5`), and merge with `--no-ff`:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w6-d -b w6-integration main
  cd ../flocked-w6-d && nvm use
  git merge --no-ff origin/w6-a-stakes-settlement && git merge --no-ff origin/w6-b-signer \
    && git merge --no-ff origin/w6-c-design
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
  Expect a trivial conflict in `apps/api/test/migrations.test.ts`, where `0011` and `0012` each add tables; keep every side.

## Scope and file ownership
- May create or edit:
  - the registry files: `apps/api/src/{app,env,index}.ts`, `apps/api/src/routes/index.ts`, `apps/api/wrangler.jsonc`, `.github/workflows/*`, root `package.json`, `e2e/package.json`, `pnpm-lock.yaml`, and `e2e/stack/**`;
  - `apps/api/src/indexer/handlers.ts` (W6-A's registrations), `packages/shared/src/index.ts` (W6-C's export), and in `packages/shared/src/api/index.ts` only the `ENDPOINTS` auth of the room-round routes;
  - `apps/api/src/routes/{rounds,claims}.ts`, the `GET /rounds/:id/me` handler in `routes/entries.ts`, and `apps/api/src/read/**`;
  - the read models `packages/shared/src/api/{rounds,claims}.ts` and `RoundMeResponseSchema`, only where a field is missing (a note for Z);
  - `apps/api/src/lifecycle/void.ts` (`applyVoid`, and any change W6-A left in "Notes for D");
  - migration `apps/api/migrations/0013_*.sql`, `apps/api/test/{gating,read}/**`, `apps/api/test/lifecycle/void.test.ts`, `apps/api/test/migrations.test.ts`, and `e2e/tests/claims-*.test.ts`;
  - integration fixes in A, B and C files where a merge needs them;
  - `docs/sessions/W6-D.md` and `docs/prompts/W6-Z.md`.
- Must not touch: `contracts/**` (the audit candidate), the Paper pages, `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- `wave-6.md` "Pinned interfaces": responses conform to `packages/shared/src/api/{rounds,claims}.ts` (and `RoundMeResponseSchema` in `entries.ts`); the signer boundary (`signTicket` through `SIGNER`); the safe-head input.
- The bundle format (`docs/bundle-format.md`, `bundleFormat` 1, `closeBlock` for Stakes). `registerHandler(event, name, fn, opts?)`: register W6-A's handlers under their names unchanged.
- `stakesEligibility(env, user, request, opts?)`; `MeResponse.stakes.reasons` uses the widened `INELIGIBLE_REASONS` (W5-B).

## Tasks
1. Merge (above), and apply every handoff's "Notes for D":
   - the `SIGNER` service binding in `apps/api/wrangler.jsonc` and `env.ts`, replacing W6-B's local type, and any new vars;
   - the signer on the stack beside the API, loading `e2e/stack/.run/ticket-signer.dev.vars` (the escrow's ticket-signer key; never the API's `.dev.vars`), and a `stack:status` row;
   - W6-A's Stakes handlers, registered in `indexer/handlers.ts`; W6-C's copy module, exported from `packages/shared/src/index.ts`;
   - `stakes-settle` (W6-A) and `stakes-ticket` (W6-B) as their own steps in `.github/workflows/stack.yml`; the seam rows in `e2e/stack/README.md`.
2. `applyVoid` writes `refund`-kind `payouts` rows for rule 4's Free refunds, idempotently, so `/rounds/:id/me` reads one shape. Rules 7 and 8 already do (`refundFree`).
3. The read endpoints in `apps/api/src/read/**`, per the Objective. Free settlement data:
   - `settlements.tally_json` is the API's `TallySchema`, `winners_json` holds `{winner, refundReason, voidCount, voidStake, total, creatorAward, awardRecipient}`, and `tx_hash` is the manifest anchor;
   - bundles are at `bundles/{roundId}/{mode}/`, and modes refunded before the reveal (rules 4, 7, 8) have none.
4. First visit: `GET /rounds/today` with a session calls `recordPriorTransactions`, then `applyDailyGrant` (`apps/api/src/rounds/grant.ts`), never `dailyGrantMovement` directly, so a skipped grant isn't credited later that day.
5. Reveal gating. In `ENDPOINTS`, make `GET /rounds/:id`, `/rounds/:id/verify`, `/rounds/:id/ws` and `/rounds/:id/card` `optional`, gate room rounds on membership, and keep room-round responses out of the unauthenticated edge cache.
6. Claims: `GET /claims` across merged accounts, and `GET /claims?wallet=` from public bundle data. Then the anvil claim-proof test as a stack test (`e2e/tests/claims-*.test.ts`, its own Stack step), building on `stakes-settle`'s round.

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green (Node 22). `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green.
- `pnpm stack:up`, then `pnpm --filter @flocked/e2e exec vitest run` (every stack file, one at a time), then `pnpm stack:down`.
- Required:
  - PIPE-1 (API and bundle halves) in `apps/api/test/gating/*.test.ts`;
  - AC-2 (API part): a test walks every GET route before and after the reveal and asserts no option-level data leaks before it;
  - claim proofs from `/claims?wallet=` verify against the onchain root, on anvil;
  - room rounds are members-only on every gated route;
  - rule 4's `refund` rows are written once, however often `applyVoid` runs (`apps/api/test/lifecycle/void.test.ts`).
- Push, and confirm CI (check, contracts, properties, static-analysis) and Stack are green on `w6-integration` (`gh run list --branch w6-integration`).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Wave 6 is merged on `w6-integration`; the read endpoints and claims answer per their schemas with reveal gating; the signer runs on the stack; and the Stakes stack tests are Stack steps.
- The listed tests pass, and the handoff names PIPE-1 (API, bundles) and AC-2 (API part) with their tests. The W6-Z prompt is written.

## Constraints
- Never commit secrets (`e2e/stack/.dev.vars` is gitignored). Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W6-D.2`).

## End of session
1. Commit, then `git push -u origin w6-integration`.
2. Write `docs/sessions/W6-D.md` from plan.md 3.2. Commit and push.
3. Draft the W6-Z prompt from plan.md 3.1 and `docs/plan/wave-6.md` "W6-Z checklist", in the shape of `docs/prompts/W5-Z.md`. It must also:
   - prove ID-5, SET-1b (5, 6), PIPE-1 (API, bundles), ALERT-3 and AC-4 (API half), plus NFR-6 (Stakes), NFR-7 and ALERT-1 (Stakes), each by a named test;
   - check that `audit-candidate-1` still matches `contracts/src` (`git diff audit-candidate-1 HEAD -- contracts/src` is empty), and record the audit status (OA-20);
   - ask the owner to review Cards and notifications in Paper, with the new copy lines W6-C listed (OA-D4, before W10);
   - reserve the wave-7 migrations: W7-A `0014`, W7-B `0015`, W7-D `0016`.

   Save it to `docs/prompts/W6-Z.md`, commit, push, and print it in a fenced block.
