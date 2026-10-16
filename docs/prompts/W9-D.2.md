# Session W9-D.2: Browser Free-round e2e; the W9-Z prompt

**Role:** integrate. **Size:** M (plan.md 2.8: the second half of W9-D, split up front; subagents' tokens count toward the size). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.1 (Session prompt template), 3.4 (Z checklist) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-9.md`: "W9-D.2", the "W9-Z checklist" and the W9-D and "All" items of every "Carry-over" section.
- `docs/sessions/W9-D.md` (what W9-D merged, registered, proved and left), and `docs/sessions/W9-C.md` (the browser Free flow, its fixtures and Notes for D).
- `e2e/stack/README.md` ("The test seam", "Playwright specs") and `e2e/ui/README.md` (the phase rule). `e2e/ui/world.ts` and `e2e/ui/today.spec.ts` › "a Free round in the browser on the stack".
- Spec sections (Node 22: `nvm use` first), only where the spec needs them:
  ```bash
  pnpm spec "Testing and acceptance criteria"     # E2E-1, E2E-2
  pnpm spec "Client app" --sub "Entry flow (Free)"
  ```

## Objective
On `w9-integration`, write the browser e2e for a full Free round (E2E-1 Free UI, E2E-2 UI) in `e2e/ui/free-round.spec.ts`: sign in, pick, seal (tlock in the browser, receipt checked), close, beacon, the reveal and the result, on the stack, with axe on each screen. Then draft the W9-Z prompt from the template and `wave-9.md` "W9-Z checklist", naming everything W9-D and W9-D.2 left.

## Starting point
- Base and branch: `w9-integration` (W9-D's head; `git log -1 origin/w9-integration`). Worktree: reuse `../flocked-w9-d` if it is clean and on that branch, else `git worktree add ../flocked-w9-d2 w9-integration`.
  ```bash
  cd ../flocked-w9-d && git fetch origin && git status && git pull --ff-only
  nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit: `e2e/ui/free-round.spec.ts`; `e2e/fixtures/**` and `e2e/ui/world.ts` only to share a helper with `today.spec.ts` (say which in the handoff); the registry files only for a fix the spec needs; `docs/sessions/W9-D.2.md`, `docs/prompts/W9-Z.md`.
- Must not touch: `contracts/**` (`git diff audit-candidate-1 HEAD -- contracts/src` stays empty), `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`, Paper and `docs/design/`.

## Pinned interfaces
- `wave-9.md` "Pinned interfaces"; `wave-8.md` "Pinned interfaces" (the web layout). The browser reads the stack's trusted chain from `window.__FLOCKED_LOCAL_CHAIN__` (with `skipDailyClose`), set by the spec from the stack state, as `today.spec.ts` does (W9-C, Deviations).

## Tasks
1. Check `docs/sessions/W9-D.md` and that CI, Stack and E2E are green on `w9-integration` (`gh run list --branch w9-integration`); if not, fix that first. Then harden W9-C's `e2e/ui/reveal.spec.ts` (W9-D Open issue 2): two tests failed on CI's first attempt ("Unsealing in 10:00") and passed on the re-run; make them deterministic (likely the socket `state`'s `serverTime` versus `setPageTime`'s jump) and say what it was in the handoff.
2. `e2e/ui/free-round.spec.ts` (project `ui`, no warp): at least three browser players sign in (the email or wallet path the `ui` suite already uses), each picks and seals in the browser on a daily-shaped round scheduled through the seam; the round closes and reveals with no manual step after setup (the cron driver and the DOs' alarms); each browser shows Sealed, the unsealing countdown, "Counting the flock…", the reveal with the right winner and share, and its own result (win or loss) matching `GET /rounds/:id/me`; axe on Today, Sealed and Reveal. Reuse or move into a fixture W9-C's "a Free round in the browser on the stack" rather than copying it.
3. Add the new spec to `e2e/ui/README.md` if it lists the ui specs.
4. Draft `docs/prompts/W9-Z.md` from plan.md 3.1 and 3.4 and `wave-9.md` "W9-Z checklist". It must carry W9-D's open issues and spec issues (`docs/sessions/W9-D.md`), in particular: the guardian-void notification left unwired because of the indexer poll budget, the `POST /farcaster/webhook` row missing from the spec's API table, the timing-dependent kill of W8-F1's owned-rooms SQL cap, and the W9-A, W9-B, W9-C and W8-F1 spec issues.

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green (Node 22).
- `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` on a fresh stack (the new spec included), and `pnpm stack:up && pnpm e2e && pnpm stack:down` on another; `pnpm e2e:screens` (macOS). If port 9229 is taken: `STACK_API_PORT=8797 STACK_INSPECTOR_PORT=19239`.
- CI, Stack and E2E (`api`, `ui`, `screens`) green on the pushed `w9-integration`.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- `e2e/ui/free-round.spec.ts` passes on a fresh stack and in CI's `ui` job; E2E-1 (Free UI) and E2E-2 (UI) have named, passing tests; `docs/sessions/W9-D.2.md` is written; `docs/prompts/W9-Z.md` is saved.

## Constraints
- Never commit secrets (VAPID keys, the mocks' values and the Anthropic placeholder stay in gitignored files). Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, stop at a green commit and emit `W9-D.3`.

## End of session
1. Commit, then `git push origin w9-integration`.
2. Write `docs/sessions/W9-D.2.md` from plan.md 3.2, then commit and push it.
3. Save `docs/prompts/W9-Z.md`, commit, push, and print it in a fenced block. Tell the owner to start W9-Z in a fresh session.
