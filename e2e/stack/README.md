# Local stack

The `local` environment from plan 4.4 on one machine: a drand network in Docker, anvil, the contracts, and
`wrangler dev` for `apps/api`. The e2e tests run against it.

```bash
nvm use                      # Node 22.23
pnpm stack:up                # ~20 s (the first run on a Mac also pulls the drand image)
pnpm --filter @flocked/e2e exec vitest run tests/stack-smoke.test.ts   # ~70 s
pnpm --filter @flocked/e2e exec vitest run   # every stack test, one file at a time (~5.5 min)
pnpm stack:status            # exits 1 if anything is down
pnpm stack:down              # stops everything and deletes the state
```

Needs Docker (OrbStack on the owner's Mac, OA-01), Foundry 1.7.1 (`anvil`, `forge`) on `PATH`, `pnpm install` and
`(cd contracts && forge soldeer install)`. CI runs the same commands (`.github/workflows/stack.yml`) on `main` and
`w*-integration`.

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
4. **API**: writes `e2e/stack/.dev.vars`, applies the D1 migrations, creates a placeholder `apps/web/dist` if it is
   missing (the assets binding needs the directory; it is gitignored), and starts
   `wrangler dev --local --env-file e2e/stack/.dev.vars` on `127.0.0.1:8787`. A developer's own
   `apps/api/.dev.vars` is not read and not touched. The service mocks run beside it: Farcaster Quick Auth
   (`e2e/mocks/farcaster`, `127.0.0.1:8789`), Coinbase OAuth and API (`e2e/mocks/coinbase`, `:8790`) and the
   Coinbase Verifications chain reads (`e2e/mocks/eas`, `:8791`). Settlement fetches beacons from the local drand
   network (`DRAND_RELAYS`).
5. **Crons** (`cron.mjs`): `wrangler dev` never fires the Worker's cron triggers, so a driver process runs them
   through the seam (`POST /__test/cron`): the minute cron (scheduler tick and indexer kick) every 5 s
   (`STACK_CRON_INTERVAL_MS`) and the hourly one every 10 minutes (`STACK_CRON_HOURLY_MS`). Passes never
   overlap, and each writes a heartbeat to `.run/cron.json` that `stack:status` checks. The scheduler logs
   `ALERT_SCHEDULE_GAP` for today's real daily round, which has no house question on the stack; that is
   expected.

`up` is idempotent: a healthy stack is left as it is, and anything else (a half-started or stale stack) is torn
down and started fresh. Ports can be moved with `STACK_API_PORT`, `STACK_ANVIL_PORT`, `STACK_DRAND_PORT`,
`STACK_FARCASTER_PORT`, `STACK_COINBASE_PORT`, `STACK_EAS_PORT` and `STACK_INSPECTOR_PORT`.

## Files (all gitignored, rewritten on every `up`)

| Path                                    | What                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/stack/.state.json`                 | Public facts: drand chain (hash, public key, genesis, period, URL), contract addresses, every role's address, the API URL and app origin, process IDs                                                                                                                                                                                                                  |
| `e2e/stack/.dev.vars`                   | The API's vars and secrets (mode 0600): the drand chain and `DRAND_RELAYS`, `LOCAL_DEPLOYMENT`, `RECEIPT_SIGNER_KEY`, `ANCHOR_KEY`, `OPERATOR_KEY`, Turnstile's always-pass test secret, `APP_ORIGIN`, `EMAIL_FROM`, `FARCASTER_AUTH_ORIGIN`, `FLOCKED_TEST_SEAM_KEY`, and personhood's `PERSON_ID_KEY`, mock Coinbase client, `COINBASE_*_ORIGIN` and `ATTESTATION_*` |
| `e2e/stack/.run/logs/`                  | One log per step and process (`dkg`, `deploy`, `migrations`, `wrangler`, `anvil`, ...)                                                                                                                                                                                                                                                                                 |
| `e2e/stack/.run/wrangler/`              | `wrangler dev`'s persistence: D1, KV, Durable Object storage                                                                                                                                                                                                                                                                                                           |
| `e2e/stack/.run/ticket-signer.dev.vars` | `TICKET_SIGNER_KEY`, the escrow's ticket signer key (W5-Z), for the signer Worker and stack tests. Never in `.dev.vars`: the API must not hold it (NFR-7)                                                                                                                                                                                                              |

The other role keys (admin, guardian, pauser, ticket signer, treasury) are generated and dropped; only their
addresses are kept. Email sign-in codes sent locally land as files under `apps/api/.wrangler/tmp/email/`.

## The test seam

`/__test/*` (`apps/api/src/local/seam.ts`) stands in for the scheduler and settlement until later waves build
them. It answers 404 unless `ENVIRONMENT` is `local` and the request carries `FLOCKED_TEST_SEAM_KEY` (generated per
run) as a Bearer token.

| Route                                                             | Does                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /__test/clock {nowMs}`                                      | Pins the game clock (`FLOCKED_TEST_CLOCK`) for the Worker and every DO; `null` returns to wall time. A wrangler restart forgets it                                                                                                                                                     |
| `POST /__test/cron {cron}`                                        | Runs a configured cron expression's jobs (`src/cron.ts` `runCron`), as its trigger would. The cron driver calls it                                                                                                                                                                     |
| `POST /__test/rounds/scheduled {opensAt, closesAt, beaconDelay?}` | A daily-shaped Free round and its question, unlocked. The scheduler's next tick locks it (past opensAt − 6 h), anchors its lock leaf and inits its RoundDO                                                                                                                             |
| `POST /__test/rounds {opensAt, closesAt, beaconDelay?}`           | A daily Free round, locked: question, `rounds`, `round_modes`, then `RoundDO.init`. The beacon round is the first at or after `closesAt + beaconDelay`                                                                                                                                 |
| `GET /__test/rounds/:id`                                          | RoundDO state, D1 status, the Free mode (commitment root, `lockTx`, `commitTx`, and once settled the bundle hash, refund reason and `revealedAt`), the settlement record and payouts, the entries with their outcome and archival, and the round key's anchor events in `chain_events` |
| `GET /__test/bundles/:id/:mode/:file`                             | A settlement bundle object from R2 (`manifest.json`, `chunk-nnnn.json`), byte for byte (W5-D)                                                                                                                                                                                          |
| `POST /__test/rounds/:id/reveal {signature}`                      | Verifies the beacon and opens every entry inside the Worker (`decryptWithSignature`, `classify`); writes nothing (the real settlement runs on its own)                                                                                                                                 |

## Stack tests

| File                                 | What                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/stack-smoke.test.ts`          | One real Free round end to end through the seam: SIWE, sealed picks, receipts, close, the local beacon, reveal in Node and in the Worker                                                                                                                                                                                          |
| `tests/lifecycle-open-close.test.ts` | A minute-long daily-shaped round moved only by the cron driver and the DOs' alarms: lock, lock leaf onchain, open, entries, close, commitment onchain before the beacon, both writes mirrored by the indexer (AC-6, first half)                                                                                                   |
| `tests/free-settle.test.ts`          | A daily-shaped round with 50 players (one VOID), moved only by the cron driver and the DOs' alarms, settles after its beacon: the bundle in R2 (read through `GET /__test/bundles/...`), the manifest anchored onchain, entries archived, and every balance moved by exactly the payout `@flocked/settle` computes in Node (W5-D) |
| `tests/anchor-tx.test.ts`            | The AnchorDO's and operator's transactions on anvil: batches with `Skipped`, a stuck transaction replaced at the same nonce                                                                                                                                                                                                       |
| `tests/indexer-reorg.test.ts`        | The indexer core over anvil: a reorg made with `evm_snapshot` / `evm_revert` and repaired, ALERT-8                                                                                                                                                                                                                                |

Files run one at a time (`fileParallelism: false`): they share anvil and the stack's keys, and `anchor-tx` turns
automine off for a moment. Run `anchor-tx` and `indexer-reorg` when no other round on the stack is about to lock
or close, since they sign with the same anchor key as the AnchorDO.

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
