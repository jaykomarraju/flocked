# Session W3-D: local stack + first Free entry end to end

**Role:** integrate. **Size:** M (split into `W3-D.2` if needed: merges and the local stack first; the smoke test and its CI job second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.1–3.2 (templates), 4 (Global conventions; 4.3 and 4.4 especially). Read nothing else in `plan.md`.
- `docs/plan/wave-3.md` (all of it, including "Changes from W2-Z" and the "W3-Z checklist").
- `docs/sessions/W2-Z.md`, then the W3-A, W3-B and W3-C handoffs (`docs/sessions/W3-{A,B,C}.md` on their branches).
- `contracts/README.md`, `contracts/script/Deploy.s.sol`, `contracts/script/dry-run.sh`, `packages/tlock/README.md`, `packages/tlock/src/chains.ts`, `apps/api/wrangler.jsonc`, `apps/api/src/lib/clock.ts`.
- Spec (Node 22: `nvm use` first): `pnpm spec "Testing and acceptance criteria"`, only the "End to end (Playwright)" bullet's first paragraph.

## Objective
Merge A, B and C. Build the local stack: a local drand network in Docker using the `bls-unchained-g1-rfc9380` scheme, anvil (`--fork-url` optional), the CREATE2 deploy, `.dev.vars` generation with fresh test keys, D1 migrations and `wrangler dev`. Then prove a real Free entry end to end against it, and run that proof in CI.

## Starting point
- Check first (plan.md 2.6): all three handoffs must be `complete`. If any isn't, stop and print the continuation prompts to run first, plus a fresh W3-D prompt.
- Create `w3-integration` from `main` (which equals tag `wave-2`) and merge `w3-a-auth`, `w3-b-round-do`, `w3-c-design` with `--no-ff`. Worktree: `../flocked-w3-d`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w3-d -b w3-integration main
  cd ../flocked-w3-d && nvm use
  git merge --no-ff origin/w3-a-auth && git merge --no-ff origin/w3-b-round-do && git merge --no-ff origin/w3-c-design
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)   # regenerate pnpm-lock.yaml if the merges conflict
  ```

## Scope and file ownership
- May create or edit: `e2e/stack/**` (`docker-compose.yml`, drand node configs, DKG bootstrap script, `up.mjs`, `down.mjs`, `status.mjs`, `env.mjs`, `README.md`), `e2e/package.json`, `e2e/tests/stack-smoke.test.ts`, the registry files (`apps/api/src/{index.ts,routes/index.ts}`, `apps/api/wrangler.jsonc`, `apps/api/src/env.ts` for B's needs, root `package.json`, `pnpm-workspace.yaml`, `.github/workflows/*`, `.gitignore`), `apps/api/migrations/0004_*.sql` (only if needed), `docs/sessions/W3-D.md`, `docs/prompts/W3-Z.md`, and fixes needed to integrate A, B and C.
- Must not touch: `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`, Paper.

## Pinned interfaces
- P2.4 as built (`docs/plan/wave-2.md`, "As built (W2-Z)"), the wave-3 session middleware contract, the receipt domain and typehash, and `contracts/deployments/<chainId>.json` (`31337.json` gitignored).
- Chain constants come only from `packages/tlock/src/chains.ts` (via `DRAND_*` vars) and the deploy script; the local drand chain's values reach the API through `.dev.vars` and `chainFromEnv`.

## Tasks
1. Merge (above); fix integration breaks; apply A's and B's "Notes for D" (env, bindings, DO exports, route mounts).
2. `pnpm stack:up` / `pnpm stack:down` (idempotent, about a minute) and `pnpm stack:status`. Stack facts go to `e2e/stack/.state.json` (gitignored): drand chain info, contract addresses, the keys' public addresses, the API URL. `wrangler dev` needs an `apps/web/dist` directory for the assets binding (create a placeholder at stack-up, not in git).
3. Local drand: a short period (3 s), `beaconDelay` 60 s, short test rounds; don't warp drand. If drand's image can't run the unchained G1 scheme, build the binary in the image. Record the approach in `e2e/stack/README.md`.
4. Smoke test (`e2e/tests/stack-smoke.test.ts`, Vitest in Node): sign in with SIWE (a test wallet); create and lock a round through a test-only admin seam (env-guarded, local only); encrypt with `@flocked/tlock` to the local chain; submit; verify the receipt against `receiptSigner()` read from the local `FlockedAnchor`; advance the clock to close (`FLOCKED_TEST_CLOCK`), wait for the local beacon, and decrypt with `decryptWithSignature`. This also confirms tlock works in the `wrangler dev` (esbuild) bundle.
5. CI: a job that runs the stack and the smoke test on Ubuntu (Docker available) for `w*-integration` and `main`. `ubuntu-latest` moves to Ubuntu 26 from Oct 19, 2026; pin `ubuntu-24.04` if the stack breaks there.

## Tests and checks
- `pnpm check`, `(cd contracts && FOUNDRY_PROFILE=ci forge test)` and `pnpm format:check` green (Node 22).
- `pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/stack-smoke.test.ts` (add `e2e` to `pnpm-workspace.yaml`) green locally (needs OA-01, OrbStack) and in CI on the pushed `w3-integration`.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- `w3-integration` holds A, B and C plus the stack; the smoke test is green locally and in CI; the handoff is written; the W3-Z prompt is saved and printed.

## Constraints
- Hold point: OA-01 (OrbStack working, `docker run hello-world`). If Docker isn't available, stop as `blocked` and say so.
- Never commit secrets: `.dev.vars` and `.state.json` are gitignored; keys are generated per run. The test-only admin seam must refuse to run unless `ENVIRONMENT=local`.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, follow plan.md 2.6 (`W3-D.2`).

## End of session
1. Commit, then `git push -u origin w3-integration`.
2. Write `docs/sessions/W3-D.md` from plan.md 3.2. Commit and push.
3. Draft the Z prompt from plan.md 3.1 and the wave-3 "W3-Z checklist"; save it to `docs/prompts/W3-Z.md`, commit, push, and print it in a fenced block.
