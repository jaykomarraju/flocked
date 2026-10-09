# Session W4-D: Lifecycle wiring

**Role:** integrate. **Size:** M (split into `W4-D.2` if needed: the merge, registrations and RoundDO hardening first; the void paths and the stack lifecycle test second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template), 3.4 (Z checklist) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-4.md`: the intro, "Pinned interfaces", "W4-D", "W4-Z checklist", and the "All" and W4-D items of "Carry-over from W3-Z".
- `docs/sessions/W3-Z.md` (wave-3 summary). The handoffs `docs/sessions/W4-A.md`, `W4-B.md`, `W4-C.md`. Then `e2e/stack/README.md`.
- Code: `apps/api/src/do/round-do.ts`, `apps/api/src/rounds/**`, `apps/api/src/local/seam.ts`, `apps/api/src/{app,env,index}.ts`, `apps/api/wrangler.jsonc`, `e2e/stack/{up,env}.mjs`, `e2e/tests/stack-smoke.test.ts`, `.github/workflows/{ci,stack}.yml`.
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Round lifecycle"
  pnpm spec "Settlement and payout math" --sub "Refund rules"
  pnpm spec "Sealed picks (timelock encryption)" --sub "Free mode specifics"
  ```
  Changed in wave 3 (Decision log, Oct 9, 2026): an empty Free mode anchors no commitment and refunds under rule 1, not rule 7 ("Sealed picks", "Settlement and payout math"). Read the Oct 9 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 9'`.

## Objective
Merge A, B and C onto `w4-integration`, then wire the round lifecycle:
- The scheduler initialises the RoundDO at lock and opens it at `opensAt`.
- RoundDO close sends the commitment to AnchorDO.
- Indexer handlers move Stakes entries into RoundDO counters (`ingestStakesEntry`) and record `Committed`/`Locked` confirmations on `round_modes`.
- The two-phase void: the RoundDO stops entries, and `voidRound` must confirm in a block before `closesAt`, otherwise the void is abandoned.
- The guardian void path: reason 4 from an unknown sender voids Stakes while Free continues.

Also apply the RoundDO hardening from the W3-Z review. Prove on the local stack that a short daily-shaped round runs open → closed → committed with no manual step.

## Starting point
- Check first (plan.md 2.6): all three handoffs must be `complete`. If any isn't, stop and emit its continuation prompt plus a fresh W4-D prompt.
- Create `w4-integration` from `main` (which equals tag `wave-3`) and merge with `--no-ff`:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w4-d -b w4-integration main
  cd ../flocked-w4-d && nvm use
  git merge --no-ff origin/w4-a-scheduler && git merge --no-ff origin/w4-b-indexer && git merge --no-ff origin/w4-c-audit-prep
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - the registry files: `apps/api/src/{app,env,index}.ts`, `apps/api/src/routes/index.ts`, `apps/api/wrangler.jsonc`, `.github/workflows/*`, root `package.json`, `e2e/package.json`, `pnpm-lock.yaml`, and migration `apps/api/migrations/0007_*.sql` (only if needed);
  - `apps/api/src/lifecycle/**`, and the handler registrations in `apps/api/src/indexer/handlers.ts`;
  - `apps/api/src/do/round-do.ts` and `apps/api/src/rounds/{entry,close,hooks,schedule}.ts` (owned this wave by D), `apps/api/src/local/seam.ts`;
  - `apps/api/test/lifecycle/**`, `apps/api/test/round-do/**`, `e2e/stack/**`, `e2e/tests/lifecycle-open-close.test.ts`;
  - integration fixes in A, B and C files where a merge needs them;
  - `docs/sessions/W4-D.md`, `docs/prompts/W4-Z.md`.
- Must not touch: `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P2.4 DO signatures, and `wave-4.md` "Pinned interfaces" (the `chain_events` columns, the `handlers.ts` registry, `OPERATOR_KEY` only in `chain/operator.ts`, `ANCHOR_KEY` only in AnchorDO, `chain/tx.ts`'s `onTxSent` wired to W4-B's `recordSentTx`).
- The contracts' ABI as W4-C froze it. Don't change contracts.

## Tasks
1. Merge (above), and resolve conflicts keeping both sides. Apply every handoff's "Notes for D":
   - crons and dispatch in `src/index.ts`;
   - the `OPERATOR_KEY`/`ANCHOR_KEY` and RPC env, written to `e2e/stack/.dev.vars` by `up.mjs`;
   - `onTxSent` → `recordSentTx`;
   - the CI static-analysis job from W4-C;
   - A's and B's stack tests added to `.github/workflows/stack.yml`.
2. Lifecycle wiring per the Objective, plus `requestVoid` and the receiving side of `onModeResult` (wave 5 calls it).
3. RoundDO hardening (Carry-over from W3-Z):
   - a repeated `init` calls `advance()`;
   - failed events back off, and `ALERT_DO_ERROR` is throttled;
   - an identical replay after close returns the stored receipt;
   - the `commitment_root` update checks `changes` and alerts when it's 0;
   - optionally, a short-balance entry on a sealed round gets `round_closed`;
   - an empty Free mode skips the commit (already true; add a test).
4. Make `close-race.test.ts`'s in-flight precondition deterministic (hold the D1 commit with a test hook instead of polling ticks).
5. `e2e/tests/lifecycle-open-close.test.ts`: a short daily-shaped round (minutes long, set through config and the seam's clock) runs open → close → commit on the stack with no manual call. One lock leaf and one commitment land onchain before the beacon (AC-6, first half).
6. If the Stack job fails on Ubuntu 26 (`ubuntu-latest` from Oct 19, 2026), pin `ubuntu-24.04`.

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check`, `pnpm format:check` and `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green.
- `pnpm stack:up`, then the stack smoke plus every stack test (`pnpm --filter @flocked/e2e exec vitest run`), then `pnpm stack:down`.
- CI and Stack green on the pushed `w4-integration` (`gh run list --branch w4-integration`).
- Required:
  - SET-1b (rule 4).
  - AC-6, first half.
  - A void before close works, and a void that misses close is abandoned.
  - A guardian void stops Stakes only.
  - The lifecycle stack test.
  - The RoundDO hardening cases.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- A, B and C are merged, and the lifecycle runs on the stack without a manual step.
- The listed tests pass locally and in CI, and the handoff and the W4-Z prompt are written.

## Constraints
- Never commit secrets; the stack generates keys into the gitignored `e2e/stack/.dev.vars`.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W4-D.2`).

## End of session
1. Commit, then `git push -u origin w4-integration`.
2. Write `docs/sessions/W4-D.md` from plan.md 3.2. Commit and push.
3. Draft the Z prompt from plan.md 3.1 and `docs/plan/wave-4.md` "W4-Z checklist". It should cover tagging `audit-candidate-1` on the merge commit, telling the owner the audit package is ready (OA-20), and the wave-5 migrations (W5-A `0008`, W5-B `0009`, W5-D `0010`). Save it to `docs/prompts/W4-Z.md`, commit, push, and print it in a fenced block.
