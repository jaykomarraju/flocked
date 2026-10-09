# Session W3-Z: Consolidate wave 3

**Role:** consolidate. **Size:** M (about 20 spec issues across the handoffs, plus the core-flow copy). **Model:** Opus 5.5.

## Read first

- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.3 (Wave summary template), 3.4 (Z checklist), 4 (Global conventions) and 6 (Owner actions and launch gates, only OA-01, OA-D1, OA-D2, OA-20, OA-21, OA-22). Read nothing else in `plan.md` until a step needs it.
- `docs/plan/wave-3.md`: "Pinned interfaces", "Changes from W2-Z" and the "W3-Z checklist".
- The four handoffs on `w3-integration`: `docs/sessions/W3-A.md`, `W3-B.md`, `W3-C.md`, `W3-D.md`.
- `docs/plan/traceability.md` (rows ID-4, NFR-8, DO-1..5, TL-1, TL-3).
- `docs/plan/wave-4.md`, to draft the next prompts.
- `e2e/stack/README.md` (the local stack and the test seam).
- Spec sections only when an owner decision needs editing, loaded with `pnpm spec "<heading>"` (Node 22: `nvm use` first).

## Objective

Review wave 3 on `w3-integration`, get the owner's decisions on the open spec issues and the core-flow copy, merge into `main`, update the plan files, write the wave summary, emit the wave-4 prompts, and tag `wave-3`. No features.

## Starting point

- Base: `w3-integration` (pushed; W3-D's code head `b7ab1e2`, handoff and this prompt on top). CI and Stack runs are listed in `W3-D.md`.
- Worktree: `git fetch origin --tags && git worktree add ../flocked-w3-z w3-integration && cd ../flocked-w3-z && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)`.
- The local stack needs Docker (OrbStack running) and Foundry on `PATH`. If you make fixes, commit them on `w3-integration`.

## Scope and file ownership

- May create or edit: `Product_Spec.md` and `Design_Language.md` (only sections the owner's decisions change, plus the Decision log), `plan.md` (Status, 4.2, 4.3, 4.6 and anything a decision changes), `docs/plan/*`, `docs/sessions/W3-Z.md`, `docs/prompts/W4-*.md`, and small (< 50 lines, no new behaviour) fixes anywhere needed to get green.
- Must not: add features, or change pinned interfaces without an owner decision. Larger fixes become `W3-F{k}` (plan.md 2.6). Design changes go to a design session (Paper), not code.

## Pinned interfaces

- Wave 2's P2.4 as built and the wave-3 contracts in `docs/plan/wave-3.md` (session middleware, receipt signer key). Compare with what was built: W3-A's "Deviations" (`users.handle` nullable through a `0002` table rebuild; Stakes reasons beyond `not_verified`), W3-B's "Deviations" (`daily_grant_skips` in `0003`, `seq` allocated in SQL at commit, idempotent replay, `LOCAL_DEPLOYMENT`), W3-D's "Deviations" (test seam at `/__test/*`, clock pin by env mutation, `e2e/stack/.dev.vars`, `APP_ORIGIN`/`EMAIL_FROM` not in wrangler vars).

## Tasks

1. plan.md 3.4 steps 1–3: all four handoffs `complete`; `git diff --stat main...w3-integration`; read full diffs only where a handoff flags risk: W3-A `apps/api/migrations/0002_auth.sql`, `src/auth/session.ts`, `src/do/auth-do.ts`; W3-B `src/rounds/entry.ts` (`entryInsert`), `src/do/round-do.ts` (`commit`, `close`); W3-D `src/local/seam.ts`, `src/index.ts`, `wrangler.jsonc`. Run `pnpm install --frozen-lockfile && pnpm check`, `(cd contracts && FOUNDRY_PROFILE=ci forge test)`, and `pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/stack-smoke.test.ts && pnpm stack:down`. Confirm `gh run list --branch w3-integration` shows CI and Stack green.
2. W3-Z checklist: ID-4 (W3-A), DO-1..4 and DO-5 alarms (W3-B) proven by the tests named in their handoffs; the stack smoke green in CI. Update `docs/plan/traceability.md`: ID-4 ✅; NFR-8 🟡 (W3-A's IP part); DO-1..4 ✅; DO-5 🟡 (snapshot is W7-A); TL-3 gains W3-B's non-canonical `U` case; TL-1 notes the `wrangler dev` bundle check (stays 🟡 until W9-C).
3. Spec issues, raised with the owner via AskUserQuestion, recommendation first, batched by area:
   - **Identity and API (W3-A, 4):** nullable `users.handle` (plus a reserved-handle blocklist owner); the per-IP auth bucket (30/min, shared by `/auth/*`); suspended accounts can sign in (and later write routes refuse `account_suspended`); Turnstile optional on `/auth/email/start`.
   - **Rounds (W3-B, 4):** the `daily_grant_skips` table; Turnstile on the first Free entry of the day (unassigned: give it to W4-A or the anti-abuse session); an empty Free mode skips the commit and settles as refund rule 1; room-round grants.
   - **Design and copy (W3-C, 9):** numerals on the accent; `prefs.showStakesNet` controls only public display; the crowd-history hint; the unsealing m:ss exception; where 18+ and ToS are collected; the desktop avatar menu; the stale navigation-sheet note. Bring the copy not yet in Voice (issue 4) and the eight refund lines (issue 5, with the rule-2 wording) to the owner as one review.
   - **Testing (W3-D, 1):** the e2e bullet should name drand's local-network image and make the Base fork optional.
   Apply decisions to the spec and Decision log. Anything that changes code beyond a small fix goes into wave 4 (or a `W3-F{k}`); design changes go to a Paper session.
4. Plan fixes from the handoffs: §4.3 `pnpm stack:up` / `stack:down` / `stack:status` (built) and the smoke command; §4.6 the `Stack` workflow (`.github/workflows/stack.yml`, `smoke` job on `main` and `w*-integration`), the tlock classify property step; §4.1 `e2e/stack` and `e2e/mocks`. Record the open issues as carry-over in later wave files: W3-A's KV-consistency watch (W14 soak) and the expired-session sweep (W13 ops); W3-B's `applyDailyGrant` for first-visit grants (W4-A), `requestVoid`/`onModeResult` (W4-D), `ingestStakesEntry` (W6-A); W3-D's Turnstile siteverify dependency in CI (W7-D), the Ubuntu 26 switch on Oct 19 (pin `ubuntu-24.04` if the Stack job breaks), and reusing the seam and `e2e/stack/env.mjs` in W7-D. Wave 4's D should run its "daily round runs open → closed → committed" check on this stack.
5. Merge (plan.md 3.4 step 6): `main` ← `w3-integration` `--no-ff` and push; delete `w3-a-auth`, `w3-b-round-do`, `w3-c-design`, `w3-integration` (local and remote) and the worktrees `../flocked-w3-{a,b,c,d}`. Tag `wave-3` on `main` only after the summary and the wave-4 prompts are committed (steps 6 and 8).
6. Update `plan.md` Status, `docs/plan/traceability.md`, and any later wave file whose plan changed. Write `docs/sessions/W3-Z.md` from plan.md 3.3.
7. Owner actions: ask the owner to review the core flow in Paper (OA-D2, needed before W9; 37 states × 3 breakpoints, `docs/design/screens.md`); confirm the audit-prep slot (W4-C) and that an auditor is booked (OA-20); remind them of OA-D1, OA-21, OA-22 and any OA due in waves 4–5. OA-01 is done (OrbStack ran the stack on Oct 8).
8. Emit the wave-4 prompts from `docs/plan/wave-4.md` and plan.md 3.1, pointing at `docs/sessions/W3-Z.md`. Migrations reserved for wave 4: W4-A `0005`, W4-B `0006`, W4-D `0007`. Name any spec sections changed this wave.

## Tests and checks

- `pnpm install --frozen-lockfile && pnpm check` green on `w3-integration` before merging and on `main` after.
- `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green; the stack smoke green locally; CI and Stack green on `w3-integration` and on `main` after the push.
- No test is skipped, deleted or weakened without a line in `W3-Z.md` with the reason.

## Definition of done

- `main` contains wave 3, tagged `wave-3`, CI and Stack green; wave branches and worktrees removed.
- Traceability rows for wave 3 updated; owner decisions applied to the spec with Decision log rows; plan files updated.
- `docs/sessions/W3-Z.md` written; wave-4 prompts saved, committed and printed.

## Constraints

- Never merge a red wave (plan.md 2.6). Fixes over ~50 lines or with new behaviour go to a `W3-F{k}` session, with a `W3-Z.2` prompt to run after it.
- Never commit secrets (`e2e/stack/.dev.vars` and `.state.json` are gitignored). Don't fake owner actions or launch gates.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, follow plan.md 2.6.

## End of session

1. Commit and push `main`.
2. Write `docs/sessions/W3-Z.md` (plan.md 3.3); commit and push.
3. Save every wave-4 prompt to `docs/prompts/W4-{X}.md`, commit, push, then tag `wave-3` on `main` and push the tag. Print each prompt in its own fenced block. Say which run in parallel, and that the owner starts each in a fresh session.
