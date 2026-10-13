# Session W8-D: Rooms (integrate)

**Role:** integrate. **Size:** M (split into `W8-D.2` if needed: the four merges, the registrations, the hook wiring and a green tree first; rooms second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template), 3.4 (Z checklist, for what Z will check) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-8.md`: the intro, "Pinned interfaces", "W8-D", "W8-Z checklist", and the W8-D and "All" items of every "Carry-over" section (W3-Z, W4-Z, W5-Z, W7-Z).
- `docs/sessions/W7-Z.md` (wave-7 summary). The four handoffs: `docs/sessions/W8-A.md`, `W8-B.md`, `W8-C.md` and `W7-F1.md` ("Notes for D and Z" first). `docs/plan/wave-7.md` "W7-F1".
- `e2e/stack/README.md` ("The test seam", "Playwright specs") and `e2e/ui/README.md` (W8-C's phase rule).
- Code you build on: `apps/api/src/routes/rooms.ts` (stubs), `packages/shared/src/api/rooms.ts`, `src/scheduler/{lock,…}.ts` (it refuses to lock a room round without a question, W4-Z), `src/rounds/grant.ts` (grants and `daily_grant_skips`), `src/points/index.ts`, `src/settlement/reduce.ts` (counts every valid room entry today; `countQualifyingOnly` in `@flocked/settle`), `src/identity/delete.ts` (after the W7-F1 merge), `src/settlement/hooks.ts` (W8-B).
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Profiles, leaderboards and rooms" --sub "Rooms"
  pnpm spec "API"                                     # the room rows
  pnpm spec "Identity and personhood" --sub "Identities"   # Account deletion: a deleted owner's rooms; suspended accounts
  pnpm spec "Settlement and payout math"              # room minimum, qualifying entrants
  ```
  Changed in wave 7 (Decision log, Oct 12, 2026, W7-Z): "Profiles, leaderboards and rooms" (Rooms: a deleted owner's rooms pass to the oldest remaining member, a room with no other member closes; Game day and streaks; Leaderboards), "Identity and personhood" (suspended accounts, merges, deletion), and the rest listed in `docs/sessions/W7-Z.md` "Decisions". Read the rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'W7-Z'`.

## Objective
Merge W8-A, W8-B, W8-C and W7-F1 onto `w8-integration`, apply their registrations and wire the settlement hooks, then build rooms (`wave-8.md` "W8-D"): `POST /rooms`, `POST /rooms/join`, `GET /rooms/:id`, `POST /rooms/:id/questions` (moderated through W8-A); room rounds created by the scheduler (mirror or custom), one RoundDO each; room points (500 on join, +100 per room round below a balance of 1,000, ledger reason `room_grant`, a skip final for that round in `daily_grant_skips`); qualification (≥ 3 distinct qualifying entrants with accounts ≥ 24 h old at `closesAt`, recorded per entry in the members-only bundle); the room leaderboard; member picks after the reveal; no global stats or referrals; the Stakes-rooms flag (off), with tickets restricted when on. Also the W7-Z carry-over: a deleted owner's rooms, `account_suspended` on room writes, and the Stakes `onModeFinal` call.

## Starting point
- If any of the four handoffs isn't `complete`, stop and emit the continuation prompts to run first, plus a fresh W8-D prompt (plan.md 2.6).
- Base: `main` (equal to tag `wave-7`). Branch: `w8-integration`. Worktree: `../flocked-w8-d`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w8-d -b w8-integration wave-7
  cd ../flocked-w8-d && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  git merge --no-ff origin/w7-f1-review-fixes
  git merge --no-ff origin/w8-a-questions
  git merge --no-ff origin/w8-b-stats
  git merge --no-ff origin/w8-c-web-shell
  ```
  Expected conflicts: `pnpm-lock.yaml` (re-run `pnpm install` and keep both sides' deps), `apps/api/test/{routes,migrations}.test.ts` (keep every side), `routes/me.ts` (W7-F1's handlers and W8-B's referrals handler), `packages/shared/src/index.ts` exports.

## Scope and file ownership
- May create or edit: the registry files (`apps/api/src/{app,env,index}.ts`, `routes/index.ts`, `wrangler.jsonc`, `.github/workflows/*`, root and `e2e/` `package.json`, `pnpm-lock.yaml`, D1 migrations); `apps/api/src/rooms/**`, `routes/rooms.ts`, migration `0019`, `apps/api/test/rooms/**`, `e2e/tests/rooms.spec.ts`; the Stakes `onModeFinal` call in `src/indexer/handlers/stakes.ts`; `src/identity/delete.ts` for a deleted owner's rooms; scheduler files for room rounds; integration fixes in the merged branches' files (named in the handoff).
- Must not touch: `contracts/**` (`git diff audit-candidate-1 HEAD -- contracts/src` stays empty), `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`, Paper.

## Pinned interfaces
- `wave-8.md` "Pinned interfaces": `onModeFinal(handler)` in `src/settlement/hooks.ts` (W8-B), called by Free apply (W8-B wired it) and by the Stakes indexer handler at `RoundFinalized` (you wire it, idempotently: a re-processed event must not double-credit); register W8-A's creator handler. The web layout and screenshot rules (W8-C).
- Migrations in order: `0017` (W8-A), `0018` (W8-B), `0019` (yours), `0020` (W7-F1). Room rounds are members only on every route (anonymous 401, non-member 404) and never touch global stats or referrals.

## Tasks
1. Merge the four branches (above) and fix integration breaks; get `pnpm check` green.
2. Apply every "Notes for D": W8-A's bindings (Vectorize, AI), `ANTHROPIC_API_KEY` as a secret name (`.dev.vars` locally, the mock on the stack), its `onModeFinal` registration; W8-B's Stakes hook call; W7-F1's migration, config key and vars; W8-C's `pnpm e2e:ui` and CI wiring per its phase rule. Add any new mock (`e2e/mocks/anthropic`) to `stack:up` and `stack:status`.
3. Rooms, room rounds, room points and qualification, the room board, member picks, the Stakes-rooms flag; a deleted owner's rooms (decision B5); `account_suspended` on room writes.
4. `e2e/tests/rooms.spec.ts`: a room round settles on the local stack (two-phase rule if it warps).
5. Draft the W8-Z prompt from plan.md 3.1 and `wave-8.md` "W8-Z checklist".

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check`, `pnpm format:check`, `(cd contracts && FOUNDRY_PROFILE=ci forge test)`.
- `pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run && pnpm stack:down`, then on a fresh stack `pnpm stack:up && pnpm e2e && pnpm e2e:ui && pnpm stack:down` (or W8-C's documented order). Don't edit `apps/api/src` while they run. If another project holds port 8787 or 9229: `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239`.
- CI (check, contracts, properties, static-analysis), Stack and E2E green on `w8-integration`.
- Required: non-member entry and view rejected; the room minimum refund; room rounds never touch global stats; a room round settles on the stack; a deleted owner's rooms; the Stakes hook fires once per final mode.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- `w8-integration` holds the four branches and rooms, green locally and in CI; the handoff and the W8-Z prompt are written.

## Constraints
- Never commit secrets. Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6.

## End of session
1. Commit, then `git push -u origin w8-integration`.
2. Write `docs/sessions/W8-D.md` from plan.md 3.2, then commit and push it.
3. Draft the Z prompt from the template and `docs/plan/wave-8.md` "W8-Z checklist"; save it to `docs/prompts/W8-Z.md`, commit, push, and print it in a fenced block.
