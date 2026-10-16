# Session W9-D: Merge wave 9 and W8-F1; notification and verify e2e

**Role:** integrate. **Size:** M, split up front (owner, Oct 16, 2026: W8-D used about 0.6M tokens of its own plus about 1.5M across six subagents). W9-D merges, registers and runs the API-level e2e, then emits `W9-D.2` for the browser Free-round e2e and the W9-Z prompt. Subagents' tokens count toward the size. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template), 3.4 (Z checklist) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-9.md`: the intro, "Pinned interfaces", "W9-D", "W9-D.2", the "W9-Z checklist" and the W9-D and "All" items of every "Carry-over" section. `docs/plan/wave-8.md` "W8-F1".
- `docs/sessions/W8-Z.md` (wave-8 summary). The four handoffs: `docs/sessions/W9-A.md`, `W9-B.md`, `W9-C.md` and `W8-F1.md`. Each must be `complete` before you merge (plan.md 2.6, "D checks first").
- `e2e/stack/README.md` ("The test seam", "Playwright specs") and `e2e/ui/README.md` (the phase rule).
- Spec sections (Node 22: `nvm use` first), only where a merge or a spec needs them:
  ```bash
  pnpm spec "Notifications"                                 # E2E-8
  pnpm spec "Testing and acceptance criteria"               # E2E-8, PIPE-6
  ```
  Changed in wave 8 (Decision log, Oct 16, 2026, W8-Z): see `docs/sessions/W8-Z.md` "Decisions".

## Objective
Merge W9-A, W9-B, W9-C and W8-F1 onto `w9-integration`, apply their registrations (routes, bindings, vars, queue settings, the web routes in `apps/web/src/routes.tsx`), and fix integration breaks. Then write the API-level e2e: E2E-8 (exactly one outcome notification per entrant per game day, and `question_live` only to non-entrants) and PIPE-6 e2e (the verify CLI against the stack's bundles). Re-run a sample of W8-F1's mutations on the merged tree. Emit `W9-D.2` for the rest.

## Starting point
- Base: `main` (equals the tag `wave-8`). Branch: `w9-integration`. Worktree: `../flocked-w9-d`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w9-d -b w9-integration main
  cd ../flocked-w9-d && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  git merge --no-ff origin/w9-a-notify && git merge --no-ff origin/w9-b-verify && git merge --no-ff origin/w9-c-today && git merge --no-ff origin/w8-f1-review-fixes
  ```
  Re-resolve `pnpm-lock.yaml` with `pnpm install` on a conflict and keep every side's packages.

## Scope and file ownership
- May create or edit: the registry files (`apps/api/src/{app,env,index}.ts`, `routes/index.ts`, `wrangler.jsonc`, `apps/web/src/routes.tsx`, root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.github/workflows/*`, D1 migrations' order); integration fixes anywhere, each named in the handoff; `e2e/tests/{notifications,verify-cli}.spec.ts`, `e2e/fixtures/**` and the stack (`e2e/stack/**`) for what they need; `docs/sessions/W9-D.md`, `docs/prompts/W9-D.2.md`.
- Must not touch: `contracts/**` (`git diff audit-candidate-1 HEAD -- contracts/src` stays empty), `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`, Paper and `docs/design/`.

## Pinned interfaces
- `wave-9.md` "Pinned interfaces" (the channel senders, the verify exports and CLI), `wave-8.md` "Pinned interfaces" (the settlement hooks; the web layout). Migrations: W9-A `0021`, W9-D `0022` if you need one. W8-F1 has none.

## Tasks
1. Check the four handoffs (all `complete`), create the worktree and merge in the order above. Apply every "Notes for D" item. Run `pnpm check` after each merge.
2. Re-run a sample of W8-F1's mutations on the merged tree from its handoff table (at least H1, M1, M3 and one W7-F1 guard), and every W9 handoff's flagged risk.
3. E2E-8 (`e2e/tests/notifications.spec.ts`, through W9-A's mocks) and PIPE-6 e2e (`e2e/tests/verify-cli.spec.ts`: `flocked-verify` exits 0 on a settled Free round and a settled Stakes round from the stack, and 1 on a tampered chunk).
4. Write `docs/prompts/W9-D.2.md` from plan.md 3.1 and `wave-9.md` "W9-D.2" (the browser Free round, E2E-1 Free UI and E2E-2, `e2e/ui/free-round.spec.ts`; then the W9-Z prompt), naming what this session left.

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green (Node 22).
- The stack tests in CI order (`pnpm stack:up`, `pnpm --filter @flocked/e2e exec vitest run`, `pnpm stack:down`), `pnpm stack:up && pnpm e2e && pnpm stack:down` on a fresh stack, `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` on another, and `pnpm e2e:screens` (macOS). If port 9229 is taken: `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239`.
- CI, Stack and E2E (`api`, `ui`, `screens`) green on the pushed `w9-integration` (`gh run list --branch w9-integration`).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- The four branches are merged and green; E2E-8 and PIPE-6 e2e pass; W8-F1's sampled mutations are caught on the merged tree; `docs/sessions/W9-D.md` is written (status `partial` is right if W9-D.2 carries the rest: say so) and `docs/prompts/W9-D.2.md` is saved.

## Constraints
- Never commit secrets (VAPID keys, the email mock's values and the Anthropic placeholder stay in gitignored files). Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, stop at a green commit and put the rest in `W9-D.2`.

## End of session
1. Commit, then `git push -u origin w9-integration`.
2. Write `docs/sessions/W9-D.md` from plan.md 3.2, then commit and push it.
3. Save `docs/prompts/W9-D.2.md`, commit, push, and print it in a fenced block. Tell the owner to start W9-D.2 in a fresh session.
