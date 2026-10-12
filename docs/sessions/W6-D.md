# W6-D handoff: Read APIs, claims, reveal gating

## Status

complete — wave 6 is merged on `w6-integration`; the read endpoints and claims answer per their schemas with reveal gating; the signer runs on the stack; the Stakes stack tests (and the new claims test) are Stack steps.

## Summary

- **Merge:** W6-A, W6-B, W6-C merged with `--no-ff` (no conflicts; `migrations.test.ts` merged cleanly). Registrations: the `SIGNER` service binding (every env; `Env.SIGNER`, W6-B's `StakesEnv` gone; the API's tests bind a stand-in signer Worker that refuses every ticket), W6-C's copy export. W6-A registered its own handlers (nothing for D).
- **Reads (`apps/api/src/read/`):** `GET /rounds/today` (first-visit grant: `recordPriorTransactions` then `applyDailyGrant`), `/rounds/:id`, `/rounds?before=&limit=`, `/rounds/:id/me` (receipt re-signed, inclusion proof, result, payouts, claim proof, cards), `/rounds/:id/verify` and the bundle objects (`/rounds/:id/bundles/:mode/:file`), `GET /claims` (caller plus merged accounts, transitively) and `?wallet=` (from the bundle alone: manifest and chunk hashes checked, `settle` re-run, the payout tree rebuilt and its root checked).
- **Gating:** every per-option field is read through `revealed_at`, never through a row's presence. Room rounds: anonymous 401, non-member 404, member OK on `/rounds/:id`, `/verify`, bundles, `/me`, `/ws` and `/card` (the last two still stubs, gated). Room-round responses are `private, no-store` and never cached; anonymous public reads use the Cache API for 5 s (off on `local`).
- **Claims onchain:** `Claimed` / `RefundClaimed` mark `payouts.claimed_at` (removal clears it).
- **Fixes found by the suites:** applyFree credited balances before setting `revealed_at` (a winner's `/me` balance leaked the outcome); `/me` showed a pre-void `win` row; the archive cursor on a full last page; Stakes void refunds had no `payouts` rows. Plus the A↔B seam: ingestion now sets `stakes_tickets.used_tx`.
- **Rule 4:** `applyVoid` writes `refund` payouts rows idempotently (owner decision, Oct 12); Stakes voids too (`stakesVoidHandler`).
- **Stack:** the signer runs in the API's `wrangler dev` (second config, its own env file), `PERSON_TAG_KEY` per run, a `signer` status row, `stakes-ticket` now also runs the real `/prepare` → signer → `enter` path, and the stack steps `stakes-ticket`, `stakes-settle` and `claims-wallet`.

## Branch and head commit

`w6-integration` @ `2ce0d76` (code; this handoff and the W6-Z prompt are the next commits)

## Files touched

- New: `apps/api/src/read/{access,cache,rounds,verify,me,claims,claimed,proofs}.ts`, `migrations/0013_read_indexes.sql`, `test/gating/**`, `test/read/**`, `e2e/tests/claims-wallet.test.ts`, `docs/sessions/W6-D.md`, `docs/prompts/W6-Z.md`.
- Edited (mine): `src/routes/{rounds,claims,entries}.ts`, `src/env.ts`, `src/indexer/handlers.ts`, `wrangler.jsonc`, `vitest.config.ts`, `src/lifecycle/void.ts`, `packages/shared/src/index.ts`, `packages/shared/src/api/{index,rounds}.ts`, `e2e/stack/**`, `e2e/vitest.config.ts`, `.github/workflows/stack.yml`, tests `test/{routes,migrations}.test.ts`, `test/lifecycle/void.test.ts`.
- Integration fixes in A/B files: `src/settlement/apply/free.ts` (reveal before credits), `src/lifecycle/handlers.ts` (`used_tx`; Stakes void refunds), `src/stakes/{signer,prepare}.ts` (`Env`), tests `test/stakes/{helpers,isolation.test}.ts`, `test/lifecycle/handlers.test.ts`, `test/settlement/free-apply.test.ts`, `e2e/tests/stakes-ticket.test.ts`.

## Tests run

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` (Node 22.23.1, at `09d387d`; `2ce0d76` adds only e2e files: `pnpm lint` and e2e typecheck re-run green) | pass: abi 13, settle 66, tlock 176, shared 448, signer 18, api 843 (750 after the merge), forge 202; no "Errors" summary |
| `pnpm format:check` | pass |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | pass, 202 (300 s); `git diff audit-candidate-1 HEAD -- contracts/src` empty |
| `pnpm stack:up` + every stack file in CI order (at `2ce0d76`) | pass: 8 files, 30 tests (smoke 6, lifecycle 3, free-settle 3, anchor-tx 3, indexer-reorg 4, stakes-ticket 5, stakes-settle 4, claims-wallet 2), about 10 min; `stack:status` (with `signer`) ok before and after |
| CI / Stack on `w6-integration` @ `2ce0d76` | CI run 38261135298 (check, contracts, properties, static-analysis) and Stack run 38261135332 (eight test steps): success |
| Mutation checks (subagents and mine) | every gate, the grant, the merge recursion, the root check, the reveal order, rule 4's rows: each caught |

## Traceability rows covered

- **PIPE-1 (API half), AC-2 (API part):** `apps/api/test/gating/reveal.test.ts` › "PIPE-1 (API half), AC-2 (API part): a Free round, every GET route, before and after the reveal" (5 tests, incl. "settlement written … but revealed_at null: nothing per option on any route" and "a Free winner's GET /me balance does not move before revealed_at") and "… a Stakes round …" (5 tests, incl. "applyStakes wrote the record, outcomes and bundle and propose is mined, OutcomeProposed not yet indexed"). Each walks every GET route in `ENDPOINTS` anonymously, as a winner and as a VOID entrant.
- **PIPE-1 (bundle half):** `test/gating/bundles.test.ts` › "PIPE-1 (bundle half): a Free bundle is in R2 before revealed_at but served only after it", "… a Stakes bundle …", "… modes refunded before the reveal list no bundle" (Free rules 4, 7, 8; Stakes rule 1).
- **Room rounds members-only:** `test/gating/rooms.test.ts` › "room rounds are members-only on every gated route", "the edge cache stores anonymous public reads only", "GET /claims?wallet= leaves room rounds out".
- **Claim proofs verify against the onchain root (anvil):** `e2e/tests/claims-wallet.test.ts` › "lists each player’s payout, with the escrow’s amount and a proof of the onchain root" (verified in Node and by a simulated `claim`) and "a winner claims on anvil; once the indexer sees `Claimed`, /claims drops the round"; unit: `test/read/claims.test.ts` › "GET /claims?wallet=".
- **Rule 4 refund rows once:** `test/lifecycle/void.test.ts` › "writes one refund payouts row per Free entry, however often applyVoid runs (owner decision, Oct 12)"; Stakes: `test/lifecycle/handlers.test.ts` › "writes a refund payouts row per ticketed Stakes entry, once".
- **First-visit grant (W3-Z, W4-Z carry-over):** `test/read/rounds.test.ts` › "GET /rounds/today: the first-visit daily grant".
- **NFR-7 on the stack:** `stack:status` `signer` row; `e2e/tests/stakes-ticket.test.ts` (the API holds no `TICKET_SIGNER_KEY`; `/prepare` signs through the signer).

## Deviations

- **A route outside `ENDPOINTS`:** `GET /rounds/:id/bundles/:mode/:file` serves the bundle objects `/verify` lists (nothing served them; room bundles must be gated). Z: add its row to the pinned table.
- **`SettlementView.settledAt` is nullable** (a Stakes proposal isn't finalized yet).
- **Changed tests, each for a behaviour changed on purpose:** `test/routes.test.ts` (six endpoints implemented; `/ws` and `/card` gated before their 501; round reads may 404 from their handler); `test/settlement/free-apply.test.ts` (rule 4 now has refund rows); `test/lifecycle/handlers.test.ts` V3 (two statements: the entry and its ticket mark).
- **applyFree's step order** (W5-D's file): `revealed_at` is set before the credits; `status` and `final_at` still follow them.
- **Stack defaults** (stack agent): `up` seeds `mode.stakes.enabled = true` and `geo.stakes.allow = ["US"]` in the local `config`, and runs `wrangler dev` with `CLOUDFLARE_CF_FETCH_ENABLED=false` (location = wrangler's placeholder, US) so the real `/prepare` path runs. `e2e/vitest.config.ts` gets a sequencer that keeps `stakes-settle` and `claims-wallet` last.
- **Subagents:** three (stack wiring and the claims stack test; the gating suite; the read tests), each in its own worktree and branch, merged with `--no-ff`. I reviewed their source fixes.

## Spec issues

- **API (receipts):** `/rounds/:id/me` serves the Free receipt by re-signing its stored fields (EIP-712 is deterministic, so it equals the original while the key is unchanged). The Oct 12 row "Verify my entry without the Free receipt" implies the server doesn't serve it. Recommend: the API serves it as built, and the Verify copy covers a rotated key.
- **API (paths):** add `GET /rounds/:id/bundles/:mode/:file` (members-only for rooms) to the API table, or name an R2 public domain for daily bundles.
- **Reveal gating vs claims by wallet:** room-round payouts are left out of `?wallet=` (room bundles are members-only), so a deleted account's room-round Stakes payout isn't served by wallet. Recommend accepting it (the member signs in) or serving the wallet's own item only.
- **`StakesConfigWire.payoutAddress`:** derived as the author's payout wallet when it equals the locked `creator`. Recommend freezing it in `config_json` at lock (the treasury isn't in the deployment file).
- **Round visibility:** a round is public only once locked (404 before). Recommend saying so in "API".
- **Free reveal order:** "Settlement output"/"Round lifecycle" should say `revealed_at` is set before any balance moves.

## Open issues

- **Claimed foreign entries** (no `payouts` row) stay listed by `?wallet=` after their claim: marking them needs the mirrored `Claimed` events by (round, wallet), i.e. a table or an index (Z decision; low risk: foreign entries come only from a signer compromise and are held).
- **W13 (load):** `/claims` and `/me` rebuild a Stakes payout tree and a Free commitment tree per isolate (LRU of 8); at 100k entries that is a cold-start cost per round. Consider caching proofs in R2.
- **W7-A:** the RoundDO's live counts are read on every non-cached `/rounds/:id`; the WebSocket replaces most of that traffic.
- **Stale comment:** `StakesConfigWireSchema` says `config_json` may hold checksummed addresses; `LockedConfigSchema` requires lowercase.
- **`AddressSchema` is lowercase-only**, so clients must lowercase `?wallet=`.
- **anvil's clock trails wall time after `indexer-reorg`** (`evm_revert`); `stakes-ticket` mines to `opensAt`. Other tests acting right after a wall-clock event could hit it.

## Notes for D and Z

- **Read first for review:** `src/read/{access,proofs,me}.ts`, `src/settlement/apply/free.ts` (the moved reveal), `src/lifecycle/handlers.ts` (`used_tx`, void refunds), `e2e/stack/up.mjs` (two configs, one process).
- **Pinned interfaces:** responses conform to `packages/shared/src/api/{rounds,claims,entries}.ts` (validated in every read and gating test). `ENDPOINTS`: `/rounds/:id`, `/verify`, `/ws`, `/rounds/:id/card/…` are `optional`.
- **Migration 0013:** one index, `entries_stakes_wallet_idx` (wallet, round_id) for Stakes entries. Wave 7: W7-A `0014`, W7-B `0015`, W7-D `0016`.
- **For W7-A:** gate `/ws` with `roundAccess` (already in front of the stub) and send no per-option data before `revealed_at`. **For W10-A:** the card route is gated the same way.
