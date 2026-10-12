# Session W6-B: Ticket signer and `/prepare`

**Role:** build. **Size:** M (split into `W6-B.2` if needed: the signer Worker and the ticket core (person tag, the conditional insert, signing) first; the eligibility branches, `geo.stakes.age21` and the concurrency tests second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-6.md`: the intro, "Pinned interfaces", "W6-B", and the W6-B and "All" items of every "Carry-over" section (W4-Z, W5-Z).
- `docs/sessions/W5-Z.md` (wave-5 summary).
- Code you build on:
  - `apps/api/src/routes/stakes.ts` (the stub you replace), its `ENDPOINTS` row in `packages/shared/src/api/index.ts`, and `StakesPrepareRequestSchema` / `StakesPrepareResponseSchema` in `packages/shared/src/api/entries.ts`;
  - `apps/api/src/personhood/{eligibility,config-store,geo,attestations}.ts` (`stakesEligibility`, `CONFIG_KEYS`, `readStakesConfig`);
  - `packages/shared/src/eip712.ts` (`TICKET_TYPES`, the `EntryTicket` domain);
  - `stakes_tickets` in `apps/api/migrations/0001_init.sql` (the unique index `stakes_tickets_round_person_used`);
  - read only: `apps/api/src/do/round-do.ts` (`getState().voidRequested`), `apps/api/src/indexer/entered.ts` (how an `Entered` matches its ticket), `contracts/src/FlockedEscrow.sol` (`enter` and the ticket check), and `apps/api/wrangler.jsonc` (the comment on `TICKET_SIGNER_KEY`).
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "Identity and personhood" --sub "Entry tickets (Stakes)"
  pnpm spec "Compliance and responsible play"
  pnpm spec "Modes: Free and Stakes"        # only the flags paragraph at the top
  ```
  Changed in wave 5 (Decision log, Oct 12, 2026): "Identity and personhood" (Merging accounts; Personhood), "Compliance and responsible play" (Geo-fencing: any linked wallet holding both attestations satisfies the country check; Age and terms: `geo.stakes.age21`) and "Data model" (`config`, `person_tombstones`). Read the Oct 12 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 12'`.

## Objective
Build the ticket signer and `POST /rounds/:id/entries/stakes/prepare`:
- `apps/signer` is a separate Worker that signs tickets and holds only `TICKET_SIGNER_KEY`.
- `/prepare` runs every eligibility check: mode open and flag on; verified; wallet linked; geo (country and request) plus proxy signals; age and ToS current; not suspended or excluded; the daily cap counting indexed stakes plus live tickets; no entry yet; room-round membership and account age.
- It computes `personTag` (HMAC with `PERSON_TAG_KEY`) and serialises issuance per person through a conditional D1 insert: one live ticket per person per game day, reissued only after expiry + 30 s.
- It commits the `stakes_tickets` row, then calls the signer.
- The kill switch `mode.stakes.enabled` stops tickets immediately.

## Starting point
- Base: tag `wave-5`. Branch: `w6-b-signer`. Worktree: `../flocked-w6-b`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w6-b -b w6-b-signer wave-5
  cd ../flocked-w6-b && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/signer/**`: a new workspace package with its own `package.json`, `wrangler.jsonc` and tests;
  - `pnpm-lock.yaml`, only the `apps/signer` importer that `pnpm install` adds;
  - `apps/api/src/stakes/**` and `apps/api/src/routes/stakes.ts`;
  - `apps/api/src/personhood/**` for `geo.stakes.age21` and the age check;
  - for the 21+ requirement only, if the client needs it: one field in `TosStateSchema` (`packages/shared/src/api/me.ts`), `tosView` in `apps/api/src/auth/profile.ts`, and the `POST /me/tos` handler in `apps/api/src/routes/me.ts` (a shape change needs a note for Z);
  - migration `apps/api/migrations/0012_*.sql`, `apps/api/test/{stakes,personhood}/**`, and `apps/api/test/migrations.test.ts` for your tables;
  - `e2e/tests/stakes-ticket.test.ts` (D adds it as a Stack step), and `docs/sessions/W6-B.md`.
- Must not touch:
  - W6-A's `apps/api/src/{settlement,chain,indexer}/**`, `lifecycle/handlers.ts`, `do/{anchor-do,round-do,settlement-do,types}.ts`, `local/seam.ts` and migration `0011`;
  - W6-C's design files and `packages/shared/src/copy/**`;
  - W6-D's `lifecycle/void.ts`, `routes/{rounds,claims,entries}.ts`, `read/**`, `packages/shared/src/api/index.ts`, migration `0013`, and the registry files: `apps/api/src/{app,env,index}.ts`, `routes/index.ts`, `apps/api/wrangler.jsonc`, `.github/workflows/*`, root and `e2e/` `package.json`, `e2e/stack/**`. The `SIGNER` service binding, its `env.ts` type, new secrets and the signer's stack wiring go in "Notes for D";
  - `contracts/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- `wave-6.md` "Pinned interfaces", signer boundary: `apps/signer` has one RPC entrypoint, `signTicket({ roundId, wallet, personTag, expiry, ticketHash }) → { signature }`, reachable only through the service binding `SIGNER` from `apps/api`. Before signing it checks that a `stakes_tickets` row with that `ticket_hash` exists (read-only D1 binding). It holds only `TICKET_SIGNER_KEY`.
- `stakesEligibility(env, user, request, { attestationMaxAgeMs: 0 })` in `apps/api/src/personhood/eligibility.ts` → `{ eligible, reasons: IneligibleReason[] }`.
- The `ENDPOINTS` row and the `StakesPrepare*` schemas pinned by W2-D, and `EntryTicket` in `packages/shared/src/eip712.ts`. Read models (`routes/{rounds,claims}.ts`) are W6-D's.

## Tasks
1. Create the worktree (above).
2. `apps/signer`: the `signTicket` entrypoint and no route that signs. It refuses a hash with no row. Say in the handoff how the D1 binding is kept read-only.
3. Until D adds `SIGNER` to `env.ts` and `wrangler.jsonc`, type it locally in `apps/api/src/stakes/` (`Env & { SIGNER }`) and use a fake in the api tests.
4. Eligibility: call `stakesEligibility(…, { attestationMaxAgeMs: 0 })` first, then add the per-round checks from the Objective. Any linked wallet holding both attestations satisfies them; the entering wallet need not (owner decision, Oct 12).
5. No ticket while the RoundDO has a void requested (`getState().voidRequested`) or the Stakes `round_modes.status` isn't `pending` (W4-Z carry-over); `round_modes` alone misses a pending void.
6. 21+: the config key `geo.stakes.age21` (country and region codes, `config` table from 0009) names the places that need 21+. The age check, and the checkbox copy the API reports, name 21 when the verified country or the request's region is listed. If an 18+ attestation can't be told from a 21+ one, store the attested age in `0012` and raise it as a spec issue.
7. Issuance per the Objective: `personTag`, the conditional insert, the row committed before the signer call. Check the daily-cap arithmetic across game days and a ticket that spans the game-day boundary.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required:
  - ID-5, every branch, in `apps/api/test/stakes/prepare.test.ts`: geo, age (21+ by country and by request region), ToS, self-exclusion, the cap with live tickets, the kill switch, one live ticket per person, a requested void, a mode not `pending`, and any linked wallet;
  - the signer refuses to sign a hash with no row;
  - concurrency: two simultaneous `/prepare` calls for one person issue one ticket;
  - AC-4 (API half): one person can't hold tickets for one round on two wallets;
  - NFR-7: a config test asserts `apps/api` has no access to `TICKET_SIGNER_KEY`, and the signer has no other secret;
  - NFR-8 (person tags, W5-Z traceability): no person tag or person ID reaches a log;
  - integration: a ticket signed by the signer verifies in `FlockedEscrow.enter` on anvil, in `e2e/tests/stakes-ticket.test.ts`.
- Stack: `pnpm stack:up`, `pnpm --filter @flocked/e2e exec vitest run tests/stakes-ticket.test.ts`, `pnpm stack:down`. The escrow's ticket-signer key is in `e2e/stack/.run/ticket-signer.dev.vars` (`TICKET_SIGNER_KEY`, written by `stack:up` since W5-Z; never in the API's `.dev.vars`). In the test, sign through the signer's own code with that key; `e2e/stack/**` is D's, so put the signer's stack wiring (running `apps/signer` beside the API with that file) in "Notes for D".
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- `/prepare` issues a signed ticket to an eligible user through `SIGNER`, and refuses every ineligible branch with its reason. The signer signs only hashes it finds in `stakes_tickets`.
- The listed tests pass, and ID-5, AC-4 (API half), NFR-7 and the NFR-8 part are named with their tests in the handoff. The handoff is written.

## Constraints
- Never commit secrets. `TICKET_SIGNER_KEY` lives only in `apps/signer` (a Workers secret); `PERSON_TAG_KEY` is an API secret. Tests generate throwaway keys.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions: `geo.stakes.allow` and `geo.stakes.age21` values are the owner's (OA-21).
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W6-B.2`).

## End of session
1. Commit, then `git push -u origin w6-b-signer`.
2. Write `docs/sessions/W6-B.md` from plan.md 3.2. Put the `SIGNER` binding, secrets, vars, the signer's stack wiring and the stack test under "Notes for D and Z". Commit and push.
3. End with your status and: "When W6-A, B and C all report complete, start W6-D from `docs/prompts/W6-D.md`."
