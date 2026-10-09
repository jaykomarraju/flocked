# W3-D handoff: local stack + first Free entry end to end

## Status

complete: A, B and C are merged on `w3-integration`, and the local stack runs a real Free round end to end,
locally and in CI. `pnpm check`, `format:check` and the CI forge profile are green.

## Summary

- **Merge:** `w3-a-auth`, `w3-b-round-do`, `w3-c-design` with `--no-ff`. One conflict, in `apps/api/test/routes.test.ts`
  (both `IMPLEMENTED` lists kept). Merged tree: api 418 tests before W3-D's additions.
- **Notes for D applied:** `LOCAL_DEPLOYMENT` in `env.ts` (B); `limitUser('entries')` on `POST /rounds/:id/entries`
  (A); `TOS_VERSION` in all three environments, the W3-A secrets and local-only values in the `wrangler.jsonc`
  header (A); tlock `classify.properties.test.ts` in CI's properties job (B).
- **Test seam** `apps/api/src/local/seam.ts` at `/__test/*`: pin the game clock, create and lock a daily Free round
  (D1 rows + `RoundDO.init`), read it back, and reveal (verify the beacon, then `decryptWithSignature` and `classify`
  on every entry, inside the Worker). It answers 404 unless `ENVIRONMENT=local` and the request carries the per-run
  `FLOCKED_TEST_SEAM_KEY` as a Bearer token.
- **Local stack** `e2e/stack/`: `pnpm stack:up` (cold ~18 s on the Mac; 0.4 s when already up), `stack:down`
  (~1 s) and `stack:status`. It runs 3 drand nodes in Docker (`go-drand-local` v2.1.8, `bls-unchained-g1-rfc9380`,
  3 s, threshold 2, DKG by `drand/dkg.sh`), anvil 31337 (`STACK_FORK_URL` optional), the CREATE2 deploy with fresh
  role keys and the local genesis, `e2e/stack/.dev.vars`, D1 migrations, `wrangler dev --local`, and the
  Farcaster mock. `.state.json` holds public facts only. See `e2e/stack/README.md`.
- **Smoke test** `e2e/tests/stack-smoke.test.ts` (6 tests, ~68 s). Two SIWE wallets sign in. The seam creates a
  round. Picks are sealed with `@flocked/tlock` against the local chain (`checkTargetRound` ok). Each receipt is
  checked against `FlockedAnchor.receiptSigner()` and `verifyReceipt` on anvil, and recovered with the shared
  typed data. Entries go in after the wall clock passes `closesAt` (proving the pinned clock reaches the RoundDO).
  The clock then moves to close: a late entry gets `round_closed`, and the D1 root equals `freeCommitmentTree`
  over the receipts. Once the local beacon arrives, picks open in Node and in the `wrangler dev` bundle.
- **CI:** `.github/workflows/stack.yml` (`smoke` job) on `main` and `w*-integration`.

## Branch and head commit

`w3-integration` @ `b7ab1e2` (code; this handoff and the W3-Z prompt follow).

## Files touched

- New: `apps/api/src/local/seam.ts`, `apps/api/test/local-seam.test.ts`, `e2e/{package.json,tsconfig.json,vitest.config.ts}`,
  `e2e/stack/{docker-compose.yml,drand/node.sh,drand/dkg.sh,env.mjs,up.mjs,down.mjs,status.mjs,README.md}`,
  `e2e/tests/stack-smoke.test.ts`, `.github/workflows/stack.yml`, `docs/sessions/W3-D.md`, `docs/prompts/W3-Z.md`.
- Edited (registry): `apps/api/src/index.ts`, `apps/api/wrangler.jsonc`, `apps/api/src/env.ts`, root `package.json`,
  `pnpm-lock.yaml`, `.gitignore`, `.github/workflows/ci.yml`.
- Edited (integration fixes in A/B files): `apps/api/test/routes.test.ts` (merge), `apps/api/src/routes/entries.ts`
  (rate limit), `apps/api/src/crypto/receipt.ts` (`ReceiptEnv` now picks `LOCAL_DEPLOYMENT` from `Env`).

## Tests run

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` + `pnpm check` (merged A+B+C, before W3-D code) | pass: node:test 20, abi 13, settle 66, tlock 176, shared 438, api 418, forge 199 |
| `pnpm check` (head) | pass: api 427 (+9 seam tests), the rest unchanged |
| `pnpm format:check`; `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | pass; 199 passed |
| `pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/stack-smoke.test.ts` | pass locally (OrbStack, Node 22.23.1), cold stack: 6 passed in 68 s; also rerun on a warm stack |
| CI on `w3-integration` @ `b7ab1e2` | pass: CI run 37883942613 (check, contracts, properties); Stack run 37883942654 (`smoke` on ubuntu-latest: stack up in 26.6 s, 6 smoke tests in 68 s) |
| Manual: email sign-in on the stack (A's open issue) | `send_email` builder form works under `wrangler dev`; Miniflare wrote the message to `apps/api/.wrangler/tmp/email/` |

## Traceability rows covered

None are assigned to W3-D. Supporting evidence: **TL-1** Workers half now also runs in the real `wrangler dev`
esbuild bundle against a live beacon (`stack-smoke.test.ts` › "opens every pick with the local beacon, in Node and
in the wrangler dev bundle"), including tlock's self-test on the first `classify`. The stack and seam are the base
for **E2E-1/E2E-2** (W7-D) and **E2E-14**.

## Deviations

- **Clock seam mutates the env object.** `POST /__test/clock` sets `env.FLOCKED_TEST_CLOCK` in place, relying on
  workerd giving the Worker and its DOs one env object per isolate (`wrangler dev` runs one isolate). The
  alternatives were a wrangler restart per clock change, or changing the pinned `src/lib/clock.ts`. The smoke test
  proves the pin reaches the RoundDO. A wrangler reload (a source edit) forgets the pin.
- **Files outside the prompt's list:** the seam (`src/local/seam.ts`) and its test are new D files (the task
  needed a seam); `env.ts` also gained `FLOCKED_TEST_SEAM_KEY`.
- **`.dev.vars` lives at `e2e/stack/.dev.vars`** (`wrangler dev --env-file`), so a developer's `apps/api/.dev.vars`
  is never overwritten or read by the stack.
- **`APP_ORIGIN`/`EMAIL_FROM` are not wrangler vars** (A suggested adding them). As top-level vars, wrangler
  warns on every run that staging and production lack them, and those values are owner-supplied. Locally the
  stack writes them; tests use A's fixtures.
- **drand:** `ghcr.io/drand/go-drand-local` (pinned by digest), not `go-drand`, whose build requires TLS between
  nodes. No source build was needed. Rationale in `e2e/stack/README.md`.
- **Ports:** anvil 18545 and drand 18080 by default (not 8545), to stay clear of `dry-run.sh` and other local
  chains. `STACK_*_PORT` overrides each.
- The seam does not write the FlockedAnchor lock leaf (AnchorDO is W4-A), and the RoundDO's commit hand-off still
  answers `not_implemented`. The smoke test checks the root in D1, not on chain.
- CI runs on `ubuntu-latest` (24.04 today), not pinned. No test was skipped, deleted or weakened.

## Spec issues

- **"Testing and acceptance criteria" › End to end:** "drand's Docker image" should name the local-network image
  (`go-drand-local`), because the regular image can't run a plain local network. "an anvil fork of Base" should
  read "anvil, optionally forking Base" (the stack forks only with `STACK_FORK_URL`). Recommend both edits.

## Open issues

- The smoke test's SIWE sign-up calls Turnstile's real siteverify (always-pass test secret), so CI depends on
  `challenges.cloudflare.com`. If it flakes, add a local siteverify mock (W7-D).
- Ubuntu 26 becomes `ubuntu-latest` on Oct 19, 2026: if the Stack job breaks, pin `ubuntu-24.04` (next D).
- The `smoke` job runs only on pushes to `main`/`w*-integration`, so it can't be a required PR check. Z checks it
  before merging (plan 3.4 step 3).
- Log noise on the stack: `AnchorDO.submitCommit` not implemented (W4-A) and settle-queue retries (W5-A).
- `stack:down` does not delete `apps/api/.wrangler/tmp/email/` (gitignored).
- `go-drand-local` is amd64 only. On Apple Silicon the first container start after a pull takes about 30 s
  longer (Rosetta).

## Notes for D and Z

- **Risky diffs worth reading:** `apps/api/src/local/seam.ts` (guard and env mutation), `apps/api/src/index.ts`
  (`/__test/*` routing), `wrangler.jsonc` (`run_worker_first` gains `/__test/*` in every environment; the seam
  404s outside local).
- **W3-Z checklist:** ID-4 (W3-A), DO-1..4 and DO-5 alarms (W3-B) are proven by their handoffs' tests on the merged
  tree; the stack smoke must be green in CI (`gh run list --branch w3-integration --workflow Stack`).
- Later e2e sessions (W7-D) should reuse `e2e/stack/env.mjs` (`readState`, `readDevVars`) and the seam. Add seam
  routes there rather than reaching into D1.
- A and B's spec issues (nullable handle, auth per-IP bucket, suspended sign-in, `daily_grant_skips`, Turnstile on
  first Free entry, empty Free mode root, room-round grants) are in their handoffs. Z raises them.
