# Session W1-Z: Consolidate wave 1

**Role:** consolidate. **Size:** S. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.3 (Wave summary template), 3.4 (Z checklist), 4 (Global conventions) and 6 (Owner actions and launch gates, the OA rows named below only). Read nothing else in `plan.md` until a step below needs it.
- `docs/plan/wave-1.md`: "Pinned interfaces" P1.3 and the "W1-Z checklist".
- The four handoffs on `w1-integration`: `docs/sessions/W1-A.md`, `W1-B.md`, `W1-C.md`, `W1-D.md`.
- `docs/plan/traceability.md` (rows CON-1..13, SET-1..6, PROP-1..5).
- `docs/plan/wave-2.md`, to draft the next prompts.
- Spec sections only when an owner decision needs editing, loaded with `pnpm spec "<heading>"`: "Smart contract", "Settlement and payout math" (and "Decision log" to add rows).

## Objective
Review wave 1 on `w1-integration`, get the owner's decisions on the open spec issues, merge into `main`, tag `wave-1`, update the plan files, write the wave summary, and emit the wave-2 prompts. No features.

## Starting point
- Base: `w1-integration` (pushed; CI green at the W1-D handoff commit).
- Worktree: `git fetch origin --tags && git worktree add ../flocked-w1-z w1-integration && cd ../flocked-w1-z && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)`.
- If you make fixes, commit them on `w1-integration`.

## Scope and file ownership
- May create or edit: `Product_Spec.md` (only sections the owner's decisions change, plus "Decision log"), `plan.md` (Status, 4.3, 4.6 and anything a decision changes), `docs/plan/*`, `docs/sessions/W1-Z.md`, `docs/prompts/W2-*.md`, and small (< 50 lines, no new behaviour) fixes anywhere needed to get green.
- Must not: add features, or change pinned interfaces without an owner decision. Larger fixes become `W1-F{k}` (plan.md 2.6).

## Pinned interfaces
- P1.3 `FlockedEscrow` as pinned in `docs/plan/wave-1.md`, compared against what B built (`contracts/src/interfaces/IFlockedEscrow.sol`; B's handoff "Notes for D and Z" lists every name and the additive extras).

## Tasks
1. plan.md 3.4 checklist steps 1–3: all four handoffs `complete`; `git diff --stat main...w1-integration`; read full diffs only where flagged (W1-B: `FlockedEscrow.claim`, `executeGuardianReplacement`; W1-C: `src/settle.ts`, `src/closed-form.ts`; W1-D: `eslint.config.js`, `.github/workflows/ci.yml`, `contracts/test/MerkleVectors.t.sol`). Run `pnpm install --frozen-lockfile && pnpm check` and `(cd contracts && FOUNDRY_PROFILE=ci forge test)`; confirm `gh run list --branch w1-integration` is green.
2. Traceability: CON-1..13, SET-1..6, PROP-1..5 each have a named passing test (names are in the B, C and D handoffs). Update their status in `docs/plan/traceability.md`.
3. Spec issues: collect them from all four handoffs (A: `Mode` defined twice, voice-line templates; B: 10 items, with 6 (pauser can `unpause`) and 8 (`withdrawTo`) needing owner decisions; C: refund-rule precedence 1 → 2 → 3, one entry per account per round, `capMultiple`/`minEntrants` bounds, "distinct people" qualification, Free creator award on refund). Raise them with the owner via AskUserQuestion, recommendation first, batched. Apply decisions to the spec and the Decision log. If a decision changes contract or settle behaviour beyond a small fix, plan it into wave 2 (or a `W1-F{k}`) rather than coding it here.
4. Fold W1-D's deviations into the plan: Foundry 1.7 has no `forge test --profile`; use `FOUNDRY_PROFILE=ci forge test` in plan.md 4.3/4.6 and wave-1 P1.4. Note that a fresh worktree needs `forge soldeer install` before `pnpm check`, so later prompts' setup lines include it.
5. Merge (plan.md 3.4 step 6): `main` ← `w1-integration` `--no-ff`, tag `wave-1`, push both; delete `w1-a-scaffold`, `w1-b-escrow`, `w1-c-settle`, `w1-integration` (local and remote) and the worktrees `../flocked-w1-{a,b,c,d}` (`git worktree remove`).
6. W1-Z checklist extras: confirm OA-03 (Actions are enabled, since CI runs; check whether branch protection on `main` is on with `gh api repos/{owner}/{repo}/branches/main/protection`); remind the owner of OA-01, OA-02, OA-20, OA-21, OA-22.
7. Update `plan.md` Status, `docs/plan/traceability.md`, and any later wave file whose plan changed. Write `docs/sessions/W1-Z.md` from plan.md 3.3.
8. Emit the wave-2 prompts from `docs/plan/wave-2.md` and plan.md 3.1, checking P1.3's pinned views against what B built (W2-B, W2-D and W6 depend on them); point them at `docs/sessions/W1-Z.md` rather than the four handoffs, and name any spec sections changed this wave.

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check` green on `w1-integration` before merging and on `main` after.
- `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green; CI green on `w1-integration` and on `main` after the push.
- No test is skipped, deleted or weakened without a line in `W1-Z.md` with the reason.

## Definition of done
- `main` contains wave 1, tagged `wave-1`, CI green; wave branches and worktrees removed.
- Traceability rows for wave 1 updated; owner decisions applied to the spec with Decision log rows; plan files updated.
- `docs/sessions/W1-Z.md` written; wave-2 prompts saved, committed and printed.

## Constraints
- Never merge a red wave (plan.md 2.6). Fixes over ~50 lines or with new behaviour go to a `W1-F{k}` session, with a `W1-Z.2` prompt to run after it.
- Never commit secrets. Don't fake owner actions or launch gates.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size S; if running low, follow plan.md 2.6.

## End of session
1. Commit and push `main` and the tag `wave-1`.
2. Write `docs/sessions/W1-Z.md` (plan.md 3.3); commit and push.
3. Save every wave-2 prompt to `docs/prompts/W2-{X}.md`, commit, push, and print each in its own fenced block. Say which run in parallel, and that the owner starts each in a fresh session.
