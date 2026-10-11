# Session W5-D: Free settlement apply

**Role:** integrate. **Size:** M (split into `W5-D.2` if needed: the four merges, the registrations and `applyFree` first; refund rules 7 and 8, the manifest anchor, archival, reconciliation and the stack test second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol, including the new last bullet of 2.6), 3.2 (Handoff template), 3.4 (Z checklist) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-5.md`: the intro, "Pinned interfaces", "W5-D", "W5-Z checklist", and the W5-D and "All" items of every "Carry-over" section. Also `docs/plan/wave-4.md` "W4-F1".
- `docs/sessions/W4-Z.md` (wave-4 summary). The handoffs `docs/sessions/W5-A.md`, `W5-B.md`, `W5-C.md` and `W4-F1.md`. Then `docs/bundle-format.md` (W5-A) and `e2e/stack/README.md`.
- Code:
  - `apps/api/src/settlement/**` (W5-A) and `apps/api/src/do/settlement-do.ts`;
  - `apps/api/src/do/round-do.ts`: `onModeResult` and the rule-8 event;
  - `apps/api/src/do/anchor-do.ts` (`submitManifest`) and `apps/api/src/lifecycle/void.ts` (rule-4 `void_refund`);
  - `apps/api/src/points/**`: ledger movements and `point_balances`;
  - the registry files;
  - `.github/workflows/stack.yml`.
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Round lifecycle"                                   # the Free rows
  pnpm spec "Settlement and payout math" --sub "Refund rules"
  pnpm spec "Settlement and payout math"                        # the Free bullets of "Normal case"
  pnpm spec "Data model"                                        # rows settlements, payouts; "Archival"; "Atomic points movements"
  ```
  Changed in wave 4 (Decision log, Oct 11, 2026): "Settlement and payout math" › Refund rules (rule 4's Free refunds are written at void confirmation), "Round lifecycle" (void abandonment, `createRound` before `opensAt`), "Data model" (`settlement_holds`, the indexer tables, `operator_txs`). Read the Oct 11 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 11'`.

## Objective
Merge W5-A, W5-B and W5-C, and W4-F1 as a fourth branch. Then build `applyFree`:
- write the settlement record, payouts and ledger movements in idempotent, chunked jobs (the ledger's unique key prevents double credit);
- the creator award, and the burned dust recorded;
- the entries' `option_index`, `valid` and `void_reason`;
- `revealed` set once the outputs are durable, then a call to `RoundDO.onModeResult` (its broadcast hook stays a no-op until W7);
- refund rules 1–3, 7 (commitment not anchored before the beacon) and 8 (beacon unavailable at +24 h, as a conditional update);
- the manifest anchored through AnchorDO (`submitManifest`);
- ciphertext archival once the outputs are durable;
- the nightly `point_balances` vs `points_ledger` reconciliation job.

## Starting point
- Check first (plan.md 2.6): all four handoffs (W5-A, B, C and W4-F1) must be `complete`. If any isn't, stop and emit its continuation prompt plus a fresh W5-D prompt.
- Create `w5-integration` from `main` (which equals tag `wave-4`), and merge with `--no-ff`:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w5-d -b w5-integration main
  cd ../flocked-w5-d && nvm use
  git merge --no-ff origin/w4-f1-review-fixes && git merge --no-ff origin/w5-a-settlement \
    && git merge --no-ff origin/w5-b-personhood && git merge --no-ff origin/w5-c-design
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
  Expect a trivial conflict in `apps/api/test/migrations.test.ts`, where `0007`, `0008` and `0009` each add tables; keep every side.

## Scope and file ownership
- May create or edit:
  - the registry files: `apps/api/src/{app,env,index}.ts`, `apps/api/src/routes/index.ts`, `apps/api/wrangler.jsonc`, `.github/workflows/*`, root `package.json`, `e2e/package.json`, `pnpm-lock.yaml`, and `e2e/stack/**` (to wire the Coinbase and EAS mocks and any new vars);
  - `apps/api/src/settlement/apply/free.ts`, `apps/api/src/jobs/reconcile.ts`, migration `apps/api/migrations/0010_*.sql`;
  - `apps/api/test/settlement/free-*.test.ts`, `e2e/tests/free-settle.test.ts`;
  - integration fixes in A, B, C and W4-F1 files where a merge needs them;
  - `docs/sessions/W5-D.md` and `docs/prompts/W5-Z.md`.
- Must not touch: `contracts/**` (the audit candidate), `apps/api/src/settlement/apply/stakes.ts` (W6-A), `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- `wave-5.md` "Pinned interfaces": `TallyResult`, the bundle format, the apply hooks, and `stakesEligibility`.
- P2.4 DO signatures. `wave-4.md` "Pinned interfaces": `OPERATOR_KEY` only in `chain/operator.ts`, `ANCHOR_KEY` only in AnchorDO, and the `registerHandler` registry.

## Tasks
1. Merge (above), and apply every handoff's "Notes for D":
   - bindings and vars, including W4-F1's fee cap with a local value;
   - the mock servers in the stack;
   - new stack tests as their own steps in `stack.yml`.
2. `applyFree` per the Objective. `onModeResult` updates only the DO and its broadcast; D1 stays the settlement's to write.
3. Refund rules 1–3, 7 and 8. Rule 4's Free refunds are already written at void confirmation (`void_refund`), so `applyFree` must not refund a voided round again. A voided Free mode still writes a bundle (spec "Data model" › Archival), but once a void is applied the RoundDO enqueues no settle message. Build that path, or raise it as a spec issue.
4. The manifest anchor through `AnchorDO.submitManifest` (W4-F1's N1 fix retries a manifest that reverts before beacon time). Then ciphertext archival.
5. `jobs/reconcile.ts` (nightly), registered on a cron in `src/cron.ts`.
6. `e2e/tests/free-settle.test.ts`: a Free round with about 50 entries from several users settles, its bundle is anchored, and balances match. Reuse `POST /__test/rounds/scheduled` and the cron driver, so nothing is called by hand.

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green (Node 22). `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green.
- `pnpm stack:up`, then `pnpm --filter @flocked/e2e exec vitest run` (every stack file, one at a time), then `pnpm stack:down`.
- Required: SET-1b (rules 7 and 8); NFR-6 (re-running apply yields identical rows and no extra ledger rows); the local-stack settle test above.
- Push, and confirm CI (check, contracts, properties, static-analysis) and Stack are green on `w5-integration` (`gh run list --branch w5-integration`).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Wave 5 and W4-F1 are merged on `w5-integration`, and a Free round settles end to end on the local stack: bundle in R2, ledger applied, manifest anchored.
- The listed tests pass, and the handoff names SET-1b (7, 8) and NFR-6 with their tests. The W5-Z prompt is written.

## Constraints
- Never commit secrets (`e2e/stack/.dev.vars` is gitignored). Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W5-D.2`).

## End of session
1. Commit, then `git push -u origin w5-integration`.
2. Write `docs/sessions/W5-D.md` from plan.md 3.2. Commit and push.
3. Draft the W5-Z prompt from plan.md 3.1 and `docs/plan/wave-5.md` "W5-Z checklist". It must also:
   - check that W4-F1's items are closed;
   - check that `audit-candidate-1` still matches `contracts/src` (`git diff audit-candidate-1 HEAD -- contracts/src` is empty);
   - record the audit status (OA-20).

   Save it to `docs/prompts/W5-Z.md`, commit, push, and print it in a fenced block.
