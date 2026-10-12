# Session W7-D: e2e harness and backend lifecycle e2e

**Role:** integrate. **Size:** M (split into `W7-D.2` if needed: the four merges, the registrations, the harness, fixtures and `e2e.yml` with `lifecycle.spec.ts` first; the Stakes claims, veto, copy, drand-outage and timeout specs second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template), 3.4 (Z checklist) and 4 (Global conventions; 4.3 and 4.6 in particular); 3.1 (Session prompt template) when you draft the Z prompt. Read nothing else in `plan.md`.
- `docs/plan/wave-7.md`: the intro, "Pinned interfaces", "W7-D", "W7-Z checklist", and the W7-D and "All" items of every "Carry-over" section (W3-Z, W6-Z). `docs/plan/wave-6.md` "W6-F1".
- `docs/sessions/W6-Z.md` (wave-6 summary). The handoffs `docs/sessions/W7-A.md`, `W7-B.md`, `W7-C.md` and `W6-F1.md`. Then `e2e/stack/README.md`, `e2e/vitest.config.ts` (the sequencer) and `.github/workflows/stack.yml`.
- Code:
  - `apps/api/src/local/seam.ts` (the seam, W6-F1's hold-release route, the 404 body) and `apps/api/src/lib/errors.ts`;
  - `apps/api/src/lib/turnstile.ts` (`SITEVERIFY_URL`) and `e2e/mocks/**` (the Farcaster, Coinbase and EAS mocks);
  - `e2e/stack/{env,up,cron}.mjs`, and as patterns `e2e/tests/{stack-smoke,free-settle,stakes-ticket,stakes-settle,claims-wallet}.test.ts`;
  - the registry files.
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Testing and acceptance criteria" --sub "Required tests"       # only the "End to end (Playwright)" bullets
  pnpm spec "Testing and acceptance criteria" --sub "Acceptance criteria"  # AC-1 and AC-5 (docs/plan/traceability.md)
  ```
  Changed in wave 6 (Decision log, Oct 12, 2026): "Round lifecycle" (the Stakes rows: the coordinator calls `finalize`; refund_proposed → revealing opens a `refund_vetoed` hold), "Sealed picks (timelock encryption)" (Entry set: reconciliation), "Identity and personhood" (Entry tickets: `personTag`, the cap), "Compliance and responsible play" (Age and terms: `ageAttested: 18 | 21`) and "API" (the bundle route; Reveal gating). Read the Oct 12 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 12'`.

## Objective
Merge W7-A, W7-B, W7-C and W6-F1 (the wave-6 review fixes). Then build the Playwright harness (`pnpm e2e`) over the local stack, with fixtures for users, wallets (anvil accounts, and a Coinbase Smart Wallet stand-in where needed), the Coinbase mock, the test clock and anvil time warp. Write the API-level lifecycle e2e:
- full Free and Stakes daily-shaped rounds with no manual step (AC-1 local; E2E-1 and E2E-2 at the API level);
- Stakes claims after the challenge window (E2E-4 API);
- a vetoed refund proposal followed by a settlement (E2E-6);
- two identical Stakes ciphertexts both count (E2E-10);
- the drand-outage rule-8 refund with the simulated clock (E2E-14);
- the refund timeout when the operator never proposes (AC-5 part, `stakes-timeout.spec.ts`).

## Starting point
- Check first (plan.md 2.6 "D checks first"): all four handoffs (W7-A, W7-B, W7-C and W6-F1) must be `complete`. If any isn't, stop and emit its continuation prompt plus a fresh W7-D prompt.
- Before merging, `contracts/src` must be untouched on every branch. Create `w7-integration` from `main` (which equals tag `wave-6`), and merge with `--no-ff`:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w7-d -b w7-integration main
  cd ../flocked-w7-d && nvm use
  for b in w6-f1-review-fixes w7-a-ws w7-b-identity w7-c-admin-design; do
    git diff --quiet wave-6 origin/$b -- contracts/src || echo "contracts/src changed on $b"; done
  git merge --no-ff origin/w6-f1-review-fixes && git merge --no-ff origin/w7-a-ws \
    && git merge --no-ff origin/w7-b-identity && git merge --no-ff origin/w7-c-admin-design
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  git diff wave-6 HEAD -- contracts/src   # must be empty
  ```
  Expect a trivial conflict in `apps/api/test/migrations.test.ts` (`0014`, `0015` and W6-F1's `0016`); keep every side.

## Scope and file ownership
- May create or edit:
  - the registry files: `apps/api/src/{app,env,index}.ts`, `apps/api/src/routes/index.ts`, `apps/api/wrangler.jsonc`, `.github/workflows/*` (new `e2e.yml`), root `package.json` (`e2e`), `e2e/package.json` (Playwright), `pnpm-lock.yaml` and `packages/shared/src/index.ts`;
  - `e2e/**`: `e2e/playwright.config.ts`, `e2e/fixtures/**`, `e2e/tests/*.spec.ts` (all new), `e2e/stack/**`, and `e2e/mocks/**` (extend it; add the Turnstile siteverify mock);
  - `apps/api/src/local/seam.ts` (the 404 body, and any seam a spec needs), `apps/api/test/local-seam.test.ts`, and `apps/api/src/lib/turnstile.ts` (a siteverify URL var for the local mock; production keeps Cloudflare's URL);
  - the changes in every handoff's "Notes for D", including any `stakes/cap.ts` change W7-B left, applied on top of W6-F1's;
  - no migration number of your own (W6-Z gave `0016` to W6-F1): a schema change you need goes into W6-F1's `0016` before the merge to `main` (it is applied nowhere yet), noted in your handoff; `apps/api/test/migrations.test.ts`;
  - integration fixes in A, B, C and W6-F1 files where a merge needs them;
  - `docs/sessions/W7-D.md` and `docs/prompts/W7-Z.md`.
- Must not touch: `contracts/**` (the audit candidate), the Paper pages, `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- `wave-7.md` "Pinned interfaces", e2e harness: Playwright with two projects, `api` (this wave) and `ui` (W8-C on); shared fixtures in `e2e/fixtures/` (`stack`, `wallet`, `user`, `clock`). WS and Identity as W7-A and W7-B built them.
- Spec files as `docs/plan/traceability.md` names them, in `e2e/tests/`: `lifecycle.spec.ts` (E2E-1, E2E-2, AC-1), `stakes-claims.spec.ts` (E2E-4), `stakes-veto.spec.ts` (E2E-6), `stakes-copy.spec.ts` (E2E-10), `drand-outage.spec.ts` (E2E-14), `stakes-timeout.spec.ts` (AC-5). Vitest keeps `tests/**/*.test.ts`; Playwright matches `*.spec.ts`.
- `registerHandler(event, name, fn, opts?)` and the P2.4 DO signatures: register under the names the handoffs give, unchanged.

## Tasks
1. Merge (above), and apply every handoff's "Notes for D": W7-A's shard-count var, W7-B's export and any cap change, W6-F1's seam route (its row in `e2e/stack/README.md`), migration notes and vars.
2. W3-Z carry-over: reuse `e2e/stack/env.mjs` and the seam; run a local Turnstile siteverify mock on the stack (the smoke calls `challenges.cloudflare.com` today); make the seam's 404 body match the app's ("Not found", `lib/errors.ts`).
3. The harness: `e2e/playwright.config.ts` (projects `api` and `ui`, one worker, specs that move anvil's clock last), `pnpm e2e` at the root, and the fixtures. `user` signs in with SIWE, verifies through the Coinbase mock and accepts the Terms with the required `ageAttested`. `clock` pins the game clock (`POST /__test/clock`) and warps anvil, and mines before any step that depends on chain time (anvil trails wall time after `indexer-reorg`). The HTTP helper reports a non-JSON answer clearly and retries only idempotent requests: `wrangler dev` dropped one of `free-settle`'s entry POSTs on `main` ("Network connection lost"; `wave-7.md`, W6-Z carry-over).
4. `lifecycle.spec.ts`: a daily-shaped round with both modes, moved only by the cron driver and the DOs' alarms; no seam call after setup.
5. The Stakes specs: claims after the window; the veto (the guardian's anvil key vetoes the refund proposal, the spec releases the `refund_vetoed` hold through W6-F1's seam route, and the round settles); identical ciphertexts; the timeout (keep the coordinator from proposing, warp past closesAt + 72 h, and refund).
6. `drand-outage.spec.ts`: stop the drand containers and move the game clock past + 24 h; Free refunds by rule 8. drand itself is never warped.
7. `.github/workflows/e2e.yml`: the stack plus `pnpm e2e` on pushes to `w*-integration` and `main`, with a timeout and the Playwright report kept on failure. Keep rounds short with config.

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green (Node 22). `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green.
- `pnpm stack:up`, then `pnpm --filter @flocked/e2e exec vitest run`, then `pnpm stack:down`. Then on a fresh stack, `pnpm stack:up && pnpm e2e && pnpm stack:down` (`stakes-settle` moves anvil's clock for good).
- Required: `pnpm e2e` green locally and in CI; E2E-1 (API), E2E-2 (API), E2E-4 (API), E2E-6, E2E-10, E2E-14, AC-1 (local), AC-5 (timeout part), each in its named spec.
- Push, and confirm CI (check, contracts, properties, static-analysis), Stack and E2E are green on `w7-integration` (`gh run list --branch w7-integration`).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Wave 7 and W6-F1 are merged on `w7-integration` with `contracts/src` unchanged; `pnpm e2e` runs every listed spec green, locally and in `e2e.yml`.
- The handoff names each required row with its spec. The W7-Z prompt is written.

## Constraints
- Never commit secrets (`e2e/stack/.dev.vars` is gitignored). Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W7-D.2`).

## End of session
1. Commit, then `git push -u origin w7-integration`.
2. Write `docs/sessions/W7-D.md` from plan.md 3.2. Commit and push.
3. Draft the W7-Z prompt from plan.md 3.1 and `docs/plan/wave-7.md` "W7-Z checklist", in the shape of `docs/prompts/W6-Z.md`. It must also:
   - prove DO-5, ID-1, PIPE-1 (WS), E2E-1/2/4 (API), E2E-6, E2E-9 (API), E2E-10, E2E-14, AC-1 (local) and AC-5 (timeout part), each by a named test;
   - check W6-F1 is merged and each of R1–R13 and O1–O5 has a named, passing, mutation-checked test (W6-F1's table);
   - check that `git diff audit-candidate-1 HEAD -- contracts/src` is empty, and record the audit status (OA-20);
   - ask the owner to review Admin in Paper (OA-D5, before W12) and the Core flow after W7-C's header fix (OA-D2, before W9); confirm OA-D1 is frozen before W8-C starts (if it isn't, W8-C waits and wave 8 runs with A, B and D only);
   - bring W7-B's merge-notice copy report and W7-C's open questions to the owner;
   - reserve the wave-8 migrations: W8-A `0017`, W8-B `0018`, W8-D `0019`.

   Save it to `docs/prompts/W7-Z.md`, commit, push, and print it in a fenced block.
