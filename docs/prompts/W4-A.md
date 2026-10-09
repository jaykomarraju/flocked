# Session W4-A: Scheduler, question lock, AnchorDO

**Role:** build. **Size:** M (split into `W4-A.2` if needed: the scheduler, lock and `chain/*` first; AnchorDO batching and the anti-abuse items second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-4.md`: the intro, "Pinned interfaces", "W4-A", and the W4-A and "All" items of "Carry-over from W2-Z" and "Carry-over from W3-Z".
- `docs/sessions/W3-Z.md` (wave-3 summary). Then `e2e/stack/README.md` (the local stack and the `/__test/*` seam).
- Code you build on: `apps/api/src/do/{types,anchor-do,round-do}.ts` (P2.4 signatures; RoundDO's close already hands the root to `AnchorDO.submitCommit`), `apps/api/src/lib/**`, `apps/api/src/rounds/{grant,schedule}.ts`, `apps/api/src/routes/entries.ts`, `apps/api/src/lib/turnstile.ts`, `packages/shared/src/{config,time,eip712}.ts`, `packages/tlock/src/rounds.ts` (`checkTargetRound`), `packages/abi` (`FlockedAnchor`, `FlockedEscrow`, `addressesFor`), `contracts/src/FlockedAnchor.sol` (read only).
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "Round lifecycle"
  pnpm spec "Architecture"                      # rows AnchorDO and Scheduler only
  pnpm spec "Smart contract" --sub "Contract: \`FlockedAnchor\`"
  pnpm spec "Sealed picks (timelock encryption)" --sub "Round config check (Stakes)"
  pnpm spec "Sealed picks (timelock encryption)" --sub "Free mode specifics"
  pnpm spec "Question pipeline" --sub "House questions"
  pnpm spec "Anti-abuse"                        # Turnstile and Points farming bullets only
  ```
  Changed in wave 3 (Decision log, Oct 9, 2026): "Sealed picks" (an empty Free mode anchors no commitment and refunds under rule 1), "Modes: Free and Stakes" (`daily_grant_skips`, room-round grants), "Data model", "API", "Identity and personhood" (suspended accounts). Read the Oct 9 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 9'`.

## Objective
Rounds get created, locked and anchored without a manual step. Build the scheduler cron: create daily rounds 48 h ahead and lock them at `opensAt` − 6 h, which means freezing `config_json`, creating `round_modes`, calling Stakes `createRound` through `chain/operator.ts`, and adding the Free lock leaves through AnchorDO. If no question is ready, fill the gap with the top house question and raise an alert. Build AnchorDO, which owns the anchor key and nonce:
- batch by `beaconRound`, with per-key deadlines of min(close + 90 s, beaconTime − 30 s);
- check onchain state before building or retrying a batch;
- replace stuck transactions;
- record `anchors` rows.

Also add two Free-entry protections that wave 3 left unassigned: Turnstile on the first Free entry of each game day, and the daily-grant anti-farming rule.

## Starting point
- Base: tag `wave-3`. Branch: `w4-a-scheduler`. Worktree: `../flocked-w4-a`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w4-a -b w4-a-scheduler wave-3
  cd ../flocked-w4-a && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/scheduler/**`, `apps/api/src/do/anchor-do.ts`, `apps/api/src/chain/{operator,client,tx}.ts`, `apps/api/migrations/0005_*.sql`, `apps/api/test/{scheduler,anchor-do}/**`;
  - for the anti-abuse items, `apps/api/src/routes/entries.ts`, `apps/api/src/rounds/grant.ts` and `apps/api/test/anti-abuse/**`;
  - the Free `stakeMax` cap in `packages/shared/src/config.ts` and its test;
  - anvil-backed tests in `e2e/tests/anchor-*.test.ts`;
  - `docs/sessions/W4-A.md`.
- Must not touch:
  - `apps/api/src/do/round-do.ts` and `apps/api/src/rounds/{entry,close,hooks}.ts` (W4-D);
  - `apps/api/src/indexer/**` (W4-B), `contracts/**` (W4-C);
  - the registry files: `apps/api/src/{app,env,index}.ts`, `apps/api/src/routes/index.ts`, `apps/api/wrangler.jsonc`, `.github/workflows/*`, root `package.json`, `e2e/package.json`;
  - `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P2.4 `AnchorDO` signatures (`apps/api/src/do/types.ts`). RoundDO calls `submitCommit` today and treats `not_implemented` as retryable until its deadline.
- `wave-4.md` "Pinned interfaces": `OPERATOR_KEY` is used only in `src/chain/operator.ts` (`createRound`, `voidRound`, `propose`, `finalize`), and `ANCHOR_KEY` only inside AnchorDO. `chain/tx.ts` takes an `onTxSent` callback option; W4-D wires it to W4-B's `recordSentTx`, so don't import `src/indexer/**`.

## Tasks
1. Create the worktree (above).
2. In `0005`: `UNIQUE (closes_at) WHERE kind = 'daily'` (or an equivalent) on `rounds`, so overlapping cron runs can't create two daily rounds. Store `anchors.block_timestamp` as Unix seconds.
3. Scheduler: create rounds and lock them (idempotent, and immutable once locked). Config validation runs `checkTargetRound` on any non-default close or `beaconDelay`. Cap the Free `stakeMax` at 2^53 − 1. DST days produce 23 h and 25 h rounds.
4. Write `chain/{client,tx,operator}.ts`: viem clients, nonce handling, replacing stuck transactions, `onTxSent`.
5. AnchorDO per the Objective. Free lock leaves carry `freeConfigHash`. A partial batch emits `Skipped` for the item it skips. Gas per item (W2-B): about 75k for `lock`, 55k for `commit`, 73k for `anchorManifest`.
6. Anti-abuse (Carry-over from W3-Z):
   - Turnstile on the first Free entry of the game day (New York date of `closesAt`).
   - The grant needs an account at least 24 h old with a linked Farcaster identity or a wallet with a prior onchain transaction. An ineligible user gets no grant and no skip row. Record that reading under the handoff's Spec issues.
7. Put anvil-backed tests (stuck-transaction replacement, a mined batch) in `e2e/tests/anchor-*.test.ts` against the local stack. Unit tests mock the RPC so `pnpm check` needs no Docker. List the new stack tests under "Notes for D" so W4-D adds them to the Stack job.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22). Run the stack tests locally with `pnpm stack:up` and `pnpm --filter @flocked/e2e exec vitest run tests/anchor-*.test.ts`, then `pnpm stack:down`.
- Required:
  - PIPE-2: per-key deadlines, a partial batch with a `Skipped` item, and stuck-transaction replacement mined on anvil.
  - ALERT-2 and ALERT-6 (schedule gap) detection.
  - Lock is idempotent and immutable.
  - `chain_round_id` comes from the `createRound` receipt.
  - The Free lock leaf's `configHash` equals `freeConfigHash`.
  - DST days produce 23 h and 25 h rounds.
  - Turnstile on the first Free entry only, and the grant's anti-farming rule.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- The cron creates and locks rounds, and AnchorDO anchors lock leaves and commitments before their deadlines.
- The listed tests pass, and PIPE-2, ALERT-2 and ALERT-6 are named with their tests in the handoff.
- The handoff is written.

## Constraints
- Never commit secrets; tests generate keys (anvil's well-known keys are fine for local tests). `OPERATOR_KEY` and `ANCHOR_KEY` are Workers secrets; add their local values through `e2e/stack/.dev.vars` in the notes for D.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W4-A.2`).

## End of session
1. Commit, then `git push -u origin w4-a-scheduler`.
2. Write `docs/sessions/W4-A.md` from plan.md 3.2. Put cron triggers, secrets, env vars, the `src/index.ts` dispatch and the stack tests for D under "Notes for D and Z". Commit and push.
3. End with your status and: "When W4-A, B and C all report complete, start W4-D from `docs/prompts/W4-D.md`."
