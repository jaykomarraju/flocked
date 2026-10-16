# Local stack

The `local` environment from plan 4.4 on one machine: a drand network in Docker, anvil, the contracts, and
`wrangler dev` for `apps/api` with the ticket signer (`apps/signer`) beside it. The e2e tests run against it.

```bash
nvm use                      # Node 22.23
pnpm stack:up                # ~20 s (the first run on a Mac also pulls the drand image)
pnpm --filter @flocked/e2e exec vitest run tests/stack-smoke.test.ts   # ~70 s
pnpm --filter @flocked/e2e exec vitest run   # every stack test, one file at a time, in CI's order (~10 min)
pnpm e2e                     # the Playwright API specs (W7-D, ~20 min); on a fresh stack, see "Playwright specs"
pnpm e2e:ui                  # the web app's browser specs (W8-C); on a fresh stack of its own, see e2e/ui/README.md
pnpm stack:status            # exits 1 if anything is down
pnpm stack:down              # stops everything and deletes the state
```

Needs Docker (OrbStack on the owner's Mac, OA-01), Foundry 1.7.1 (`anvil`, `forge`) on `PATH`, `pnpm install` and
`(cd contracts && forge soldeer install)`. CI runs the same commands (`.github/workflows/stack.yml`) on `main` and
`w*-integration`, one step per test file, in the order of the table under [Stack tests](#stack-tests).

## What `stack:up` does

1. **drand** (`docker-compose.yml`, `drand/`): three nodes, threshold 2, scheme `bls-unchained-g1-rfc9380`
   (quicknet's), period 3 s. `drand/node.sh` generates each node's key pair and starts the daemon; `drand/dkg.sh`
   runs the DKG with drand0 as leader (`generate-proposal`, `init`, `join`, `execute`). Genesis is 15 s after
   `init`. The chain hash and group key are new on every run.
2. **anvil** on `127.0.0.1:18545`, chain ID 31337. `STACK_FORK_URL=<rpc>` forks that chain (Base, say) and keeps
   chain ID 31337. The URL is never written to the state file.
3. **Contracts**: `contracts/script/Deploy.s.sol` through the CREATE2 factory, from anvil's first dev account,
   with the local drand genesis and period and a fresh key for every role. The deploy writes
   `contracts/deployments/31337.json` (gitignored); `up` checks that `FlockedAnchor.receiptSigner()` is the
   generated signer, and funds the anchorer and operator keys.
4. **API**: writes `e2e/stack/.dev.vars`, applies the D1 migrations and the config seeds, creates a placeholder
   `apps/web/dist` if it is missing (the assets binding needs the directory; it is gitignored), and starts
   `wrangler dev --local --env-file e2e/stack/.dev.vars` on `127.0.0.1:8787`. A developer's own
   `apps/api/.dev.vars` is not read and not touched. The service mocks run beside it: Farcaster Quick Auth
   (`e2e/mocks/farcaster`, `127.0.0.1:8789`), Coinbase OAuth and API (`e2e/mocks/coinbase`, `:8790`), the
   Coinbase Verifications chain reads (`e2e/mocks/eas`, `:8791`) and Turnstile's siteverify (`e2e/mocks/turnstile`,
   `:8792`, W7-D; the API calls it through `TURNSTILE_SITEVERIFY_URL`, honoured only locally, so no stack test calls
   Cloudflare). Settlement fetches beacons from the local drand network (`DRAND_RELAYS`).
   - **Ticket signer** (`apps/signer`, W6-B): the same `wrangler dev` runs it as a second Worker
     (`--config apps/api/wrangler.jsonc --config e2e/stack/.run/signer/wrangler.json`). The API's `SIGNER` service
     binding resolves in process, and both Workers share the local D1, so the signer sees the `stakes_tickets` row
     the API commits before it signs.
   - **The signer's env**: `wrangler dev` gives `--env-file` to the first config only, and reads a further config's
     secrets from the `.dev.vars` beside that config. So `up` runs the signer from a copy of
     `apps/signer/wrangler.jsonc` in `.run/signer/` (`main` points back at `apps/signer/src`), whose `.dev.vars` is
     a link to `.run/ticket-signer.dev.vars`: `TICKET_SIGNER_KEY` and `LOCAL_DEPLOYMENT`. The API never gets the key
     (NFR-7). A developer's own `apps/signer/.dev.vars` is not read.
   - **Config seeds** (the `config` table): `mode.stakes.enabled` is `true` and `geo.stakes.allow` is `["US"]`.
     `wrangler dev` runs with `CLOUDFLARE_CF_FETCH_ENABLED=false`, so every request's `request.cf` is wrangler's
     placeholder (US, TX) on every machine, and a verified US player is eligible for Stakes.
5. **Crons** (`cron.mjs`): `wrangler dev` never fires the Worker's cron triggers, so a driver process runs them
   through the seam (`POST /__test/cron`): the minute cron (scheduler tick and indexer kick) every 5 s
   (`STACK_CRON_INTERVAL_MS`) and the hourly one every 10 minutes (`STACK_CRON_HOURLY_MS`). Passes never
   overlap, and each writes a heartbeat to `.run/cron.json` that `stack:status` checks. The scheduler logs
   `ALERT_SCHEDULE_GAP` for today's real daily round, which has no house question on the stack; that is
   expected.

`up` is idempotent: a healthy stack is left as it is, and anything else (a half-started or stale stack) is torn
down and started fresh. Ports can be moved with `STACK_API_PORT`, `STACK_ANVIL_PORT`, `STACK_DRAND_PORT`,
`STACK_FARCASTER_PORT`, `STACK_COINBASE_PORT`, `STACK_EAS_PORT`, `STACK_TURNSTILE_PORT` and `STACK_INSPECTOR_PORT`.

## Files (all gitignored, rewritten on every `up`)

| Path                                    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `e2e/stack/.state.json`                 | Public facts: drand chain (hash, public key, genesis, period, URL), contract addresses, every role's address, the API URL and app origin, process IDs                                                                                                                                                                                                                                                                                                        |
| `e2e/stack/.dev.vars`                   | The API's vars and secrets (mode 0600): the drand chain and `DRAND_RELAYS`, `LOCAL_DEPLOYMENT`, `RECEIPT_SIGNER_KEY`, `ANCHOR_KEY`, `OPERATOR_KEY`, Turnstile's always-pass test secret and `TURNSTILE_SITEVERIFY_URL` (the mock), `APP_ORIGIN`, `EMAIL_FROM`, `FARCASTER_AUTH_ORIGIN`, `FLOCKED_TEST_SEAM_KEY`, personhood's `PERSON_ID_KEY`, mock Coinbase client, `COINBASE_*_ORIGIN` and `ATTESTATION_*`, and Stakes' `PERSON_TAG_KEY` (fresh every run) |
| `e2e/stack/.run/logs/`                  | One log per step and process (`dkg`, `deploy`, `migrations`, `wrangler`, `anvil`, ...)                                                                                                                                                                                                                                                                                                                                                                       |
| `e2e/stack/.run/wrangler/`              | `wrangler dev`'s persistence: D1, KV, Durable Object storage                                                                                                                                                                                                                                                                                                                                                                                                 |
| `e2e/stack/.run/ticket-signer.dev.vars` | The signer's env (mode 0600): `TICKET_SIGNER_KEY`, the escrow's ticket signer key (W5-Z), and `LOCAL_DEPLOYMENT`. Stack tests read the key from it. Never in `.dev.vars`: the API must not hold it (NFR-7)                                                                                                                                                                                                                                                   |
| `e2e/stack/.run/signer/`                | The signer's config as the stack runs it (`wrangler.json`, a copy of `apps/signer/wrangler.jsonc`), and its `.dev.vars`, a link to `ticket-signer.dev.vars`                                                                                                                                                                                                                                                                                                  |

The other role keys (admin, guardian, pauser, treasury) are generated and dropped; only their addresses are
kept. Email sign-in codes sent locally land as files under `apps/api/.wrangler/tmp/email/`.

## `stack:status`

One row per part; any `FAIL` (or a half-finished `up`) exits 1, and `up` starts a stack afresh instead of reusing it.

| Row      | Checks                                                                                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drand`  | HTTP serves this run's chain and a beacon                                                                                                                                                                                                                                                                                                      |
| `anvil`  | The process, and `FlockedAnchor` has code                                                                                                                                                                                                                                                                                                      |
| `api`    | The `wrangler dev` process, `.dev.vars`, and `GET /api/v1/me` answers 401                                                                                                                                                                                                                                                                      |
| `signer` | wrangler's Local Explorer API (`/cdn-cgi/local/explorer/api/local/workers`) lists the Worker that the API's `SIGNER` binding names (`apps/api/wrangler.jsonc`) as running in this `wrangler dev`, with the API's D1 and persistence. `.dev.vars` has no `TICKET_SIGNER_KEY`, and the signer's `.dev.vars` links to the key file, which has one |
| mocks    | `farcaster`, `coinbase`, `eas`, `turnstile`: the process and `GET /health`                                                                                                                                                                                                                                                                     |
| `cron`   | The driver process, and a heartbeat in the last few intervals                                                                                                                                                                                                                                                                                  |

`stakes-ticket` exercises the binding itself: the API's prepare route has the signer sign a ticket.

## The test seam

`/__test/*` (`apps/api/src/local/seam.ts`) stands in for the scheduler and settlement until later waves build
them. It answers 404, with the app's own body (`{"error":{"code":"not_found","message":"Not found"}}`), unless
`ENVIRONMENT` is `local` and the request carries `FLOCKED_TEST_SEAM_KEY` (generated per run) as a Bearer token.

| Route                                                                                   | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /__test/clock {nowMs}`                                                            | Pins the game clock (`FLOCKED_TEST_CLOCK`) for the Worker and every DO; `null` returns to wall time. A wrangler restart forgets it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /__test/cron {cron}`                                                              | Runs a configured cron expression's jobs (`src/cron.ts` `runCron`), as its trigger would. The cron driver calls it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /__test/rounds/scheduled {opensAt, closesAt, beaconDelay?, free?, stakes?}`       | A daily-shaped round and its question, unlocked. Free by default; `stakes: {stake?, feeBps?, creatorBps?, capMultiple?, minEntrants?, creator?}` adds a Stakes mode over the launch defaults (W6-A), and `free: false` drops Free. The scheduler's next tick locks it (past opensAt − 6 h): Free's lock leaf, Stakes' `createRound` onchain; then it inits its RoundDO                                                                                                                                                                                                                                                                                                                                                   |
| `POST /__test/rounds {opensAt, closesAt, beaconDelay?}`                                 | A daily Free round, locked: question, `rounds`, `round_modes`, then `RoundDO.init`. The beacon round is the first at or after `closesAt + beaconDelay`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /__test/rounds/:id`                                                                | RoundDO state, D1 status, the Free mode (commitment root, `lockTx`, `commitTx`, and once settled the bundle hash, refund reason and `revealedAt`), the settlement record and payouts, the entries with their outcome and archival, and the round key's anchor events in `chain_events`. `stakes` (W6-A): status, `chainRoundId`, `lockTx`, refund reason, bundle hash, `revealedAt`, `claimsOpenAt`, `finalAt`, every proposal (`settlements`), payouts, and entries (wallet, transaction, `foreign`). `free` is null for a Stakes-only round, `stakes` null without a Stakes mode. `holds` (W7-D): the round's settlement holds, open or released (`mode`, `reason`, `txHash`, `createdAt`, `releasedAt`, `releasedBy`) |
| `POST /__test/stakes/tickets {roundId, userId?, wallet, personTag, expiry, ticketHash}` | Records an entry ticket the test signed itself with the stack's ticket-signer key, as the signer path stores it (W6-A). A new user when `userId` is absent; answers `{userId}`. The indexer files the round's `Entered` under that user through it                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /__test/holds/release {roundId, mode, reason}`                                    | Releases an open settlement hold as the guardian's admin action does (W6-F1 O1, for E2E-6): `released_at` (the game clock), `released_by` `test-seam` and an `audit_log` row (actor `admin`, action `settlement_hold_released`), in one batch. `reason` is `foreign_entry`, `void_rate` or `refund_vetoed`. Answers `{roundId, mode, reason, releasedAt, releasedBy}`, 404 when no such hold is open, 400 on a bad body. The coordinator sees the release on its next hold poll (60 s of wall time)                                                                                                                                                                                                                      |
| `GET /__test/bundles/:id/:mode/:file`                                                   | A settlement bundle object from R2 (`manifest.json`, `chunk-nnnn.json`), byte for byte (W5-D)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /__test/rounds/:id/reveal {signature}`                                            | Verifies the beacon and opens every entry inside the Worker (`decryptWithSignature`, `classify`); writes nothing (the real settlement runs on its own)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Stack tests

| File                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/stack-smoke.test.ts`          | One real Free round end to end through the seam: SIWE, sealed picks, receipts, close, the local beacon, reveal in Node and in the Worker                                                                                                                                                                                                                                                                                                       |
| `tests/lifecycle-open-close.test.ts` | A minute-long daily-shaped round moved only by the cron driver and the DOs' alarms: lock, lock leaf onchain, open, entries, close, commitment onchain before the beacon, both writes mirrored by the indexer (AC-6, first half)                                                                                                                                                                                                                |
| `tests/free-settle.test.ts`          | A daily-shaped round with 50 players (one VOID), moved only by the cron driver and the DOs' alarms, settles after its beacon: the bundle in R2 (read through `GET /__test/bundles/...`), the manifest anchored onchain, entries archived, and every balance moved by exactly the payout `@flocked/settle` computes in Node (W5-D)                                                                                                              |
| `tests/anchor-tx.test.ts`            | The AnchorDO's and operator's transactions on anvil: batches with `Skipped`, a stuck transaction replaced at the same nonce                                                                                                                                                                                                                                                                                                                    |
| `tests/indexer-reorg.test.ts`        | The indexer core over anvil: a reorg made with `evm_snapshot` / `evm_revert` and repaired, ALERT-8                                                                                                                                                                                                                                                                                                                                             |
| `tests/stakes-ticket.test.ts`        | Stakes tickets (W6-B, W6-D): apps/signer's signing code against the escrow (a forged ticket reverts), then the deployed path. A player signs in, verifies through the Coinbase and EAS mocks and accepts the Terms; `POST /rounds/:id/entries/stakes/prepare` has the signer sign through `SIGNER`; `enter` accepts the ticket and the indexer files the entry under the player. Its round stays open for a day                                |
| `tests/stakes-settle.test.ts`        | A Stakes-only round with six entries (one VOID) proposes after its beacon and the safe head, with `@flocked/settle`'s amounts, then finalizes at `claimsOpenAt` with every payout in D1 (W6-A). Moves anvil's clock 2 h forward for good                                                                                                                                                                                                       |
| `tests/claims-wallet.test.ts`        | Builds on stakes-settle's round (W6-D; PIPE-1). For each player, `GET /claims?wallet=` with no session lists the payout `@flocked/settle` computes (none when it computes none), at the escrow's amount, with a proof that verifies against `getRound(id).payoutRoot` in Node and in a simulated `claim`. Then a winner claims (anvil impersonates the wallet) and, once the indexer sees `Claimed`, `/claims` drops the round for that wallet |

Files run one at a time (`fileParallelism: false`): they share anvil and the stack's keys, and `anchor-tx` turns
automine off for a moment. They run in the table's order, as in CI, whether one file per command or all with a
plain `vitest run` (`e2e/vitest.config.ts` sorts them; a file it doesn't list runs just before `stakes-settle`). All
eight take about 10 minutes. Run `anchor-tx` and `indexer-reorg` when no other round on the stack is about to lock or
close, since they sign with the same anchor key as the AnchorDO. `stakes-settle` moves anvil's clock 2 hours forward,
which can't be undone, so only `claims-wallet`, which builds on its round, comes after it; start a fresh stack
(`pnpm stack:down && pnpm stack:up`) to run anything else again.

anvil's clock can trail the wall clock by a second or two: it mines no empty blocks, and `indexer-reorg`'s
`evm_revert` sets the clock back to the reverted-to block's time. A test that sends a transaction just after a
round opens on the wall clock mines until a block reaches `opensAt` first (`stakes-ticket`).

## Time

drand runs on real time and is never warped. The smoke test pins the game clock just before close, creates a round
that closes 6 s later with `beaconDelay` 60 s, and enters after the wall clock has passed `closesAt` (proving
the pin reaches the RoundDO). It then moves the clock to `closesAt`. The RoundDO's alarm re-arms every
(`closesAt` − pinned clock) of wall time, so close runs within 6 s. The test then waits for the beacon on the real
clock, about 66 s after the round was created.

## drand image: why `go-drand-local`

The plan's fallback was to build drand from source if its image couldn't run the unchained G1 scheme. It wasn't
needed. drand v2's images support `bls-unchained-g1-rfc9380`, but the regular `ghcr.io/drand/go-drand` build
always uses TLS for node-to-node gRPC, so a plain-HTTP local network fails at `dkg generate-proposal` ("tls: first
record does not look like a TLS handshake"). drand publishes `ghcr.io/drand/go-drand-local`, the same release
built for local networks with insecure gRPC (its own `docker/start-network.sh` uses it). The compose file pins
`v2.1.8` by digest. The image is amd64 only: CI runs it natively, OrbStack on Apple Silicon under Rosetta, where
the very first start takes about 30 s longer.

Two quirks the scripts work around:

- The chain info is read through the control port (`drand show chain-info`), not HTTP. An HTTP request made
  before the DKG completes leaves the public API answering with errors or stale data for up to a minute.
- `up` finishes only once HTTP serves this chain's `/info` and a beacon.

## Playwright specs (`pnpm e2e`)

`e2e/playwright.config.ts` (W7-D) runs `e2e/tests/*.spec.ts` against the running stack with one worker; Vitest keeps
`tests/*.test.ts`. The fixtures in `e2e/fixtures/` are `stack` (this file's state, the seam and drand's containers),
`wallet` (fresh EOAs with gas, MockUSDC stakes, anvil's dev accounts, a role anvil impersonates), `user` (SIWE sign-in,
personhood through the Coinbase and EAS mocks, the Terms with the age `GET /me` asks for; one CF-Connecting-IP per
player) and `clock` (the game clock pin, anvil mining and warps). Their HTTP helper names a non-JSON answer's status and
body, and retries only idempotent requests: `wrangler dev` can drop a request under load.

| Spec                     | Rows                       | What                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drand-outage.spec.ts`   | E2E-14                     | drand's containers stopped; a Free round closes with its commitment anchored; the game clock moves past beacon time + 24 h and rule 8 refunds every entry with no reveal. drand starts again afterwards, and the late beacon changes nothing                          |
| `lifecycle.spec.ts`      | E2E-1, E2E-2, AC-1 (local) | Verified players enter Free and Stakes in a daily-shaped round that only the cron driver and the DOs' alarms move: lock, open, close, beacon, Free settled and Stakes proposed, read through the public API. No seam call after the setup                             |
| `stakes-claims.spec.ts`  | E2E-4 (API), AC-5          | A Stakes round with a win, two rebates and a VOID proposes; after the warp to claimsOpenAt the backend finalizes, and each player claims exactly what `GET /claims` lists, once                                                                                       |
| `stakes-copy.spec.ts`    | E2E-10                     | A player enters another's ciphertext byte for byte; both entries are tallied as the same pick and both win                                                                                                                                                            |
| `stakes-timeout.spec.ts` | AC-5 (timeout)             | A foreign entry (a ticket the API never issued) holds the coordinator, so nothing is proposed; after the warp past closesAt + 72 h the backend calls `refundTimeout` and every entrant claims its stake back                                                          |
| `stakes-veto.spec.ts`    | E2E-6                      | A one-sided round's refund proposal is vetoed by the guardian (anvil impersonates it): a `refund_vetoed` hold, nothing proposed while it is open; released through the seam, the coordinator proposes again; after the warp the round settles and refunds are claimed |

**Two phases.** anvil's clock only moves forward, and the escrow refuses `createRound` once its clock is past
`opensAt`, so no round can be made after a warp. The `api` project therefore runs every spec's rounds up to the
point that needs a warp, and the `api-warp` project (it depends on `api`) runs the tests tagged `@warp`: each moves the
chain and game clocks to at least its own target (`clock.warpTo`; neither clock ever moves back) and checks the
outcome. A spec's `api` phase hands its round and players to its `api-warp` phase in `.run/e2e/<spec>.json`.
`pnpm e2e` runs both projects; `api-warp` leaves anvil 72 hours ahead, so start a fresh stack to run anything again.

The browser specs follow the same rule as their own suite (W8-C): `ui`, then `ui-warp` for their `@warp` tests, on a
**fresh stack of their own** (`pnpm e2e:ui`), never after `api-warp` on the same stack. So each warp phase runs after
the one non-warp phase that shares its stack. The rule is enforced, not just written down:

- the first warp writes `.run/e2e/warped.json` (`fixtures/clock.ts`), and the `stack` fixture then refuses a
  non-warp project on that stack with "start a fresh stack" (`fixtures/index.ts`);
- after a warp the game clock never runs behind anvil: `warpTo` floors its pin at wall time, and `clock.release()`
  keeps the clock pinned at or past anvil's head instead of going back to wall time;
- `e2e/ui/phases.test.ts` (in `pnpm test`) lists every Playwright test and checks that each lands in exactly one
  project, that the warp projects hold exactly the `@warp` tests, and that each depends only on its own suite's
  first phase.

The full local run is therefore two stacks: `pnpm stack:up && pnpm e2e && pnpm stack:down`, then
`pnpm stack:up && pnpm e2e:ui && pnpm stack:down`. CI runs them as two jobs (`.github/workflows/e2e.yml`).
