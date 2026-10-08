# Session W2-Z: Consolidate wave 2

**Role:** consolidate. **Size:** M (four handoffs carry about 30 spec issues). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.3 (Wave summary template), 3.4 (Z checklist), 4 (Global conventions) and 6 (Owner actions and launch gates, only the OA rows named below). Read nothing else in `plan.md` until a step needs it.
- `docs/plan/wave-2.md`: "Pinned interfaces" (P2.1–P2.4) and the "W2-Z checklist".
- The four handoffs on `w2-integration`: `docs/sessions/W2-A.md`, `W2-B.md`, `W2-C.md`, `W2-D.md`.
- `docs/plan/traceability.md` (rows TL-1..4, CON-7, CON-9, SET-4).
- `docs/plan/wave-3.md`, to draft the next prompts.
- Spec sections only when an owner decision needs editing, loaded with `pnpm spec "<heading>"` (Node 22: `nvm use` first).

## Objective
Review wave 2 on `w2-integration`, get the owner's decisions on the open spec issues, merge into `main`, update the plan files, write the wave summary, emit the wave-3 prompts, and tag `wave-2`. No features.

## Starting point
- Base: `w2-integration` (pushed; CI run 37732324653 green on W2-D's code head `635ac34`).
- Worktree: `git fetch origin --tags && git worktree add ../flocked-w2-z w2-integration && cd ../flocked-w2-z && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)`.
- If you make fixes, commit them on `w2-integration`.

## Scope and file ownership
- May create or edit: `Product_Spec.md` and `Design_Language.md` (only sections the owner's decisions change, plus the Decision log), `plan.md` (Status, 4.2, 4.3, 4.6 and anything a decision changes), `docs/plan/*`, `docs/sessions/W2-Z.md`, `docs/prompts/W3-*.md`, and small (< 50 lines, no new behaviour) fixes anywhere needed to get green.
- Must not: add features, or change pinned interfaces without an owner decision. Larger fixes become `W2-F{k}` (plan.md 2.6). Colour changes go to a design session, not code.

## Pinned interfaces
- P2.1–P2.4 in `docs/plan/wave-2.md`, compared against what was built: W2-A's "Deviations" (vector format, `TargetRoundError` members), W2-B's "Notes for D and Z" (escrow amendments, anchor API), W2-C's tokens, and W2-D's "Deviations" (`EndpointDef` extras, `Schema`-suffixed wire names, `raiseAlert(env, …)`, lowercase addresses, `winLine(count, total)`).

## Tasks
1. plan.md 3.4 steps 1–3: all four handoffs `complete`; `git diff --stat main...w2-integration`; read full diffs only where flagged (W2-A: `packages/tlock/src/{header,seal}.ts`; W2-B: `FlockedEscrow._setGuardian` and the role overrides, `FlockedAnchor._lock`/`_commit`, `packages/abi/scripts/gen.mjs`; W2-D: `apps/api/migrations/0001_init.sql`, `apps/api/src/points/index.ts`, `packages/shared/src/config.ts`, `packages/shared/src/api/index.ts`, `apps/api/wrangler.jsonc`). Run `pnpm install --frozen-lockfile && pnpm check` and `(cd contracts && FOUNDRY_PROFILE=ci forge test)`; confirm `gh run list --branch w2-integration` is green.
2. W2-Z checklist: W2-B applied the escrow decisions (CON-7 green, ABI includes them); W2-D added the `Mode` test, the share-percentage rule and the CI hardening; CON-9 and TL-1 (Workers half), TL-2..4 proven. Update `docs/plan/traceability.md` (TL-4 ✅; TL-1 stays 🟡 until W9-C's browser half; SET-4 classification part).
3. Spec issues: collect them from all four handoffs (A: 4, B: 3, C: 11, D: 11). Raise them with the owner via AskUserQuestion, recommendation first, batched by area (contracts and hashes; API and data model; design and copy; ops: alerts, queues, crons). The checklist requires: receipt domain version, `questionHash` encoding, `freeConfigHash`, dark `accentInk`, muted contrast (C 3), scrim token (C 9), navigation (C 11), voice lines (C 10), and tlock's VOID order and canonical-header rules. Apply decisions to the spec and Decision log. Anything that changes code beyond a small fix goes into wave 3 (or a `W2-F{k}`); colour changes go to a design session.
4. Plan fixes from the handoffs: §4.2 Node 22.23 and `@cloudflare/vitest-plugin` (replacing `vitest-pool-workers`); §4.3 `contracts:build` (done); §4.6 the new CI steps (tlock vectors, tokens schema, ABI freshness, tlock properties); the W1-Z "watch" item (Vitest 5 is no longer blocked by Node). W2-D's open issue: wave 5's `routes/personhood.ts` and wave 7's `routes/identity.ts` aren't among the 15 route modules; decide where they mount and update those wave files.
5. Merge (plan.md 3.4 step 6): `main` ← `w2-integration` `--no-ff` and push; delete `w2-a-tlock`, `w2-b-anchor`, `w2-c-design`, `w2-integration` (local and remote) and the worktrees `../flocked-w2-{a,b,c,d}`. Tag `wave-2` on `main` only after the summary and the wave-3 prompts are committed (steps 6 and 8).
6. Update `plan.md` Status, `docs/plan/traceability.md`, and any later wave file whose plan changed. Write `docs/sessions/W2-Z.md` from plan.md 3.3.
7. Owner actions: ask the owner to review Foundations and Components in Paper (OA-D1, any time before W8); remind them of OA-01 (OrbStack, needed by W3), OA-20, OA-21 and OA-22, and any OA due in waves 3–4. Note the owner-supplied staging/production IDs in `apps/api/wrangler.jsonc`.
8. Emit the wave-3 prompts from `docs/plan/wave-3.md` and plan.md 3.1, pointing at `docs/sessions/W2-Z.md` and the P2.4 files as built. Migration numbers: W3-A `0002`, W3-B `0003`, W3-D `0004`. Name any spec sections changed this wave.

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check` green on `w2-integration` before merging and on `main` after.
- `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green; CI green on `w2-integration` and on `main` after the push.
- No test is skipped, deleted or weakened without a line in `W2-Z.md` with the reason.

## Definition of done
- `main` contains wave 2, tagged `wave-2`, CI green; wave branches and worktrees removed.
- Traceability rows for wave 2 updated; owner decisions applied to the spec with Decision log rows; plan files updated.
- `docs/sessions/W2-Z.md` written; wave-3 prompts saved, committed and printed.

## Constraints
- Never merge a red wave (plan.md 2.6). Fixes over ~50 lines or with new behaviour go to a `W2-F{k}` session, with a `W2-Z.2` prompt to run after it.
- Never commit secrets. Don't fake owner actions or launch gates.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, follow plan.md 2.6.

## End of session
1. Commit and push `main`.
2. Write `docs/sessions/W2-Z.md` (plan.md 3.3); commit and push.
3. Save every wave-3 prompt to `docs/prompts/W3-{X}.md`, commit, push, then tag `wave-2` on `main` and push the tag. Print each prompt in its own fenced block. Say which run in parallel, and that the owner starts each in a fresh session.
