# Session W2-D: Pinned interfaces

**Role:** integrate. **Size:** M (if it runs long, split: `W2-D.2` takes the `apps/api` skeleton and `src/points/`). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template), 3.4 (Z checklist) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-2.md` (all), and `docs/plan/wave-1.md` "Pinned interfaces" P1.3 (the ticket EIP-712 shape `eip712.ts` must match).
- `docs/sessions/W1-Z.md` (wave-1 summary), then the handoffs `docs/sessions/W2-A.md`, `W2-B.md` and `W2-C.md` on their branches.
- Spec sections, loaded with `pnpm spec "<heading>" [--sub "<label>"]`: "API"; "Data model"; "Real-time and the reveal" `--sub "WebSocket messages (server → client)"`; "Round lifecycle" `--sub "Timing"` and `--sub "Scheduling"`; "Architecture" (the table only); "Non-functional requirements" `--sub "Alerts"`; "Settlement and payout math" `--sub "Refund rules"` (the notes under the table changed in wave 1: rule order, one entry per account, `minEntrants` and `capMultiple` ≥ 1; they feed `config.ts`).
- The Decision log rows added in wave 1 (`pnpm spec "Out of scope, launch gates and decision log" | tail -8`), in particular the voice-line percentage rule.

## Objective
Merge W2-A, B and C onto `w2-integration`. Wire `@flocked/tlock`, `@flocked/abi` and the design tokens into the workspace and CI. Apply the three wave-1 carry-overs. Then implement P2.4, the shared contracts wave 3 builds against (zod schemas for every endpoint, WebSocket and queue messages, locked config, time and ID helpers, EIP-712 builders, alert codes, the full D1 schema and the `apps/api` skeleton with every binding and DO stub), plus the TL-4 forge cross-check.

## Starting point
- First read the three handoffs. If any isn't `complete`, stop, and print the continuation prompts to run first plus a fresh W2-D prompt (plan.md 2.6).
- Base: `main` (equals tag `wave-1`). Branch: `w2-integration`. Worktree: `../flocked-w2-d`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w2-d -b w2-integration main
  cd ../flocked-w2-d
  git merge --no-ff origin/w2-a-tlock
  git merge --no-ff origin/w2-b-anchor
  git merge --no-ff origin/w2-c-design
  pnpm install && (cd contracts && forge soldeer install)
  ```
  If A and B both changed `pnpm-lock.yaml`, take either side, rerun `pnpm install` to regenerate it, and commit the result.

## Scope and file ownership
- May create or edit: registry files (root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `eslint.config.js`, `.prettierignore`, `.github/workflows/*`, `apps/api/wrangler.jsonc`, `apps/api/src/index.ts`, `apps/api/src/routes/index.ts`, `apps/api/migrations/0001_init.sql`); `packages/shared/**` except `design-tokens.json`; `apps/api/**`; `contracts/test/TargetRound.t.sol`; wiring-only fixes in A's, B's and C's paths (record each in Deviations); `CLAUDE.md` (commands); `docs/sessions/W2-D.md`, `docs/prompts/W2-Z.md`.
- Must not touch: `packages/shared/design-tokens.json` (design sessions), contract sources, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P2.4 in `docs/plan/wave-2.md`, in full: file paths, names and RPC signatures are what wave 3's parallel sessions build against.
- P2.1 (`@flocked/tlock`), P2.2 (Anchor, deploy JSON, `@flocked/abi`) and P2.3 (tokens) as built by A, B and C. `eip712.ts` matches P1.3's ticket and P2.2's receipt.
- Migration numbers: this wave uses `0001` only. Wave 3 reserves W3-A `0002`, W3-B `0003`, W3-D `0004`.

## Tasks
1. Check the handoffs, create the worktree and merge (above). Apply every registration in A's, B's and C's "Notes for D and Z".
2. Wiring: root `contracts:build` (forge build plus ABI codegen); CI steps for ABI freshness and a zod check of `design-tokens.json` against P2.3; `pnpm check` covers the new packages.
3. Wave-1 carry-overs (from `docs/sessions/W1-Z.md`):
   - CI hardening: every `pnpm --filter` step in `ci.yml` gets `--fail-if-no-match`, and the `properties` job runs `test/properties.test.ts` by path instead of `-t property`, so a rename can't turn it into a green no-op.
   - A test that `@flocked/settle`'s `Mode` equals `@flocked/shared`'s. Settle keeps its own copy so it stays dependency-free.
   - The share-percentage rule for `winLine`/`lossLine` in `packages/shared/src/copy.ts`: whole percent of valid entries, the winning share rounded down and the losing share rounded up, "<1%" and ">99%" at the extremes, with tests at 0, 1, 49.5, 50.5, 99 and 100%.
4. P2.4: `packages/shared/src/api/*` (request and response schemas for every endpoint in the spec's API table, plus `errors.ts`), `ws.ts`, `queues.ts`, `config.ts` (with RFC 8785 canonical JSON, `freeConfigHash` and `questionHash`; record `questionHash`'s encoding as a spec issue), `time.ts` (with 23 h and 25 h DST tests), `ids.ts`, `eip712.ts` (checked against `FlockedEscrow.ticketDigest` and the Anchor receipt), `alerts.ts`, and re-exports of `VoidReason`/`RefundReason` from `@flocked/settle`.
5. `apps/api/migrations/0001_init.sql`: every table, column, unique key, partial unique index, CHECK and index in "Data model", with a Workers-runtime test that every spec table and unique key exists.
6. The `apps/api` skeleton per P2.4: `wrangler.jsonc` bindings and environments, `src/index.ts` and `src/env.ts`, 501 route stubs mounted in `src/routes/index.ts`, `src/lib/*`, `src/points/` fully implemented with atomicity tests, `src/do/types.ts` RPC signatures with stub DO classes, and the Vitest Workers config plus `test/helpers/`.
7. `contracts/test/TargetRound.t.sol` replays `packages/tlock/vectors/target-round.json` through `createRound` (TL-4).

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check` and `(cd contracts && FOUNDRY_PROFILE=ci forge test)` pass on `w2-integration`; CI is green on the pushed branch (`gh run list --branch w2-integration`).
- Schemas round-trip fixtures; the migration applies cleanly in the Workers test runtime; DST tests pass; the points batches roll back on insufficient balance; TL-4 passes.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- P2.4 is delivered in full. TL-4 is proven, and CON-9 and TL-1..3 stay green on `w2-integration`. The carry-overs are done. CI is green. The handoff and the W2-Z prompt are written.

## Constraints
- Never commit secrets: `.dev.vars` (gitignored) for local values; tests generate keys. Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, follow plan.md 2.6 (`W2-D.2`).

## End of session
1. Commit, then `git push -u origin w2-integration`.
2. Write `docs/sessions/W2-D.md` from plan.md 3.2, then commit and push it.
3. Draft the Z prompt from plan.md 3.1 and the "W2-Z checklist" in `docs/plan/wave-2.md`. Save it to `docs/prompts/W2-Z.md`, commit, push, and print it in a fenced block.
