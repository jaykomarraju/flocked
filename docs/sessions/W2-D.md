# W2-D handoff: Pinned interfaces

## Status
complete — A, B and C merged; P2.4 delivered in full; TL-4 proven; the three wave-1 carry-overs done; `pnpm check` green on Node 22.

## Summary
- `w2-integration` = `main` + W2-A, W2-B, W2-C (`--no-ff`) + lockfile regeneration + three commits from this session.
- `@flocked/shared` now holds every P2.4 contract: zod request/response schemas for every row of the spec's API table and a pinned `ENDPOINTS` table (`src/api/*`; 63 entries, including 19 drafted `/admin/*` endpoints and `POST /paymaster`), WebSocket messages (`ws.ts`), queue messages (`queues.ts`), the locked config with RFC 8785 canonical JSON, `freeConfigHash` and `questionHash` (`config.ts`), New York schedule math (`time.ts`), ULIDs (`ids.ts`), EIP-712 ticket and receipt builders plus `roundKey` and `MODE_CODES` (`eip712.ts`), alert codes (`alerts.ts`), settle reason re-exports (`reasons.ts`), wire primitives (`wire.ts`) and the design-tokens schema (`tokens.ts`).
- `@flocked/api` (`apps/api`): `wrangler.jsonc` with every binding and the three environments, the `0001` migration (full "Data model"), Hono app with 501 stubs for all 15 route modules generated from `ENDPOINTS`, `src/lib/*`, pinned DO RPC interfaces with seven stub classes, fully built atomic points movements, queue and cron dispatch stubs, and Workers-runtime tests with `test/helpers/`.
- Forge: `TargetRound.t.sol` (TL-4) and `SharedEip712.t.sol` (shared digests and round keys equal the contracts' on chain 84532).
- Wiring: Node 22.23 engines and `@types/node` 22; `contracts:build` runs ABI codegen; CI hardening and new freshness/schema checks.
- Carry-overs: `--fail-if-no-match` everywhere, property jobs by path; `Mode` equality test; `formatShare` and `winLine`/`lossLine(count, total)`.
- Four subagents did the bulk (shared schemas, shared helpers, apps/api, forge); I reviewed and reconciled their output.

## Branch and head commit
`w2-integration` @ `635ac34` (code). This handoff and the W2-Z prompt follow it.

## Files touched
- Merged: everything in the W2-A, B and C handoffs.
- Edited: `package.json` (engines `>=22.23`, `@types/node` 22.20.5, `contracts:build`), `pnpm-lock.yaml`, `.github/workflows/ci.yml`, `.prettierignore`, `CLAUDE.md` (commands, toolchain), `contracts/foundry.toml` (read `../packages/tlock/vectors`, `../packages/shared/test/fixtures`), `packages/shared/{package.json,src/index.ts,src/copy.ts,test/copy.test.ts}`.
- New: `packages/shared/src/{wire,ws,queues,config,time,ids,eip712,alerts,reasons,tokens}.ts`, `packages/shared/src/api/*.ts` (14), `packages/shared/test/*.test.ts` (12 new), `packages/shared/test/eip712-fixture.ts`, `packages/shared/test/fixtures/**`; `apps/api/**`; `contracts/test/{TargetRound,SharedEip712}.t.sol`; `docs/sessions/W2-D.md`, `docs/prompts/W2-Z.md`.

## Tests run
All on Node 22.23.1.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm check` | pass: node:test 20, abi 11, settle 66, tlock 161, shared 438, api 280, forge 199 |
| `(cd contracts && FOUNDRY_PROFILE=ci forge test)` | pass, 199 / 199 |
| `pnpm format:check`; `forge fmt --check` | pass |
| `node packages/abi/scripts/gen.mjs --check`; tlock vectors regenerate with no diff | pass |
| `--fail-if-no-match` with no matching package, and a by-path run of a missing file | both exit 1 (so the hardened steps can't go green on nothing) |
| `wrangler deploy --dry-run` (staging, production; temp copy with an empty assets dir) | pass, 1.3 MB / 218 KB gzip |
| CI on `w2-integration` @ `635ac34` (`gh run list --branch w2-integration`) | run 37732324653 success: `check`, `contracts`, `properties` |

## Traceability rows covered
- **TL-4** (both halves): `contracts/test/TargetRound.t.sol::test_targetRound_vectorsMatchCreateRound` (36 cases: 15 accepted, 2 `InvalidBeaconRound`, 8 `BeaconOutOfRange`, 11 client-only rejections the contract accepts; also asserts no case is client-ok but contract-rejected) and W2-A's `packages/tlock/test/vectors.test.ts`.
- Kept green: CON-7, CON-9 (W2-B's tests), TL-1 Workers half, TL-2, TL-3 (W2-A's tests).
- Acceptance (P2.4): `packages/shared/test/api.test.ts` reads the spec's API table and asserts one `ENDPOINTS` entry with schemas per row, in order; `apps/api/test/routes.test.ts` asserts every entry answers 501 (not 404); `apps/api/test/do.test.ts` reaches all seven DOs over RPC; `apps/api/test/migrations.test.ts` checks every spec table, column and unique key; `apps/api/test/points.test.ts` proves an insufficient balance rolls back the whole batch; `packages/shared/test/time.test.ts` covers every 23 h and 25 h round in 2026–2030.

## Deviations
- **Ownership:** `contracts/test/SharedEip712.t.sol` (new test) and `contracts/foundry.toml` (`fs_permissions`) are outside the listed paths; both are test wiring, no contract source changed.
- **`EndpointDef`** adds optional `params`, `query` and `responseType` (`json`/`html`/`png`/`websocket`); `request` is the JSON body or null, and GETs have `<Name>QuerySchema`/`<Name>ParamsSchema`. All paths sit under `API_BASE_PATH = '/api/v1'`. Spec auth values map to `none`/`optional`/`user`/`admin` (`state` → none, `user or wallet` → optional, `member`/`owner` → user).
- **Names:** wire primitives end in `Schema` (`UlidSchema`, `DecimalBigintSchema`, …) to stay unique under `export *`. The free entry schemas are `CreateEntryRequest`/`CreateEntryResponse`; `apps/api/src/do/types.ts` defines `EnterFreeRequest { roundId, userId, body }` and `EnterFreeResponse` from them. EIP-712 message types are `TicketMessage`/`ReceiptMessage`.
- **`raiseAlert(env, code, data)`**, not `(code, data)`: the Analytics Engine binding comes from `env`.
- **Addresses** are lowercase on the wire and in `LockedConfig.creator` (one spelling); only the paymaster accepts any case (ERC-7677). ULIDs must be canonical uppercase (tlock's `roundRefFromUlid` accepts any case).
- **Seconds vs ms:** onchain values that aren't beacon math (ticket `expiry`, receipt `closesAt`, `stakes_tickets.expiry`) stay in seconds, as signed.
- **Copy API:** `winLine`/`lossLine` now take `(count, total)` and format through `formatShare`; the old number-taking tests were updated, not weakened. Exact 0 and 100% read `0%`/`100%` (unreachable for a player's own side).
- **Workers tests:** `@cloudflare/vitest-plugin` 1.3.7 (W2-A's choice); its `env` is typed as `Cloudflare.Env`, so `test/env.d.ts` merges `Env` there (no `ProvidedEnv`). AI and Vectorize are bound but throw locally, so code must take them as injectable dependencies.
- **apps/api extras:** `src/app.ts` (the Hono app), `src/cron.ts`, `src/queues/index.ts` (`HANDLERS` by queue), `src/do/{stub,index}.ts`, `src/routes/stub.ts`; extra keys and invariant CHECKs in the migration (listed under Spec issues).
- **Chosen, spec silent:** queue retries (settle 10, others 5), DLQs `<queue>-dlq`, cards/notify batch sizes 10/50, crons (every minute, hourly, `15 8 * * *`), Free presets 10/25/50/100, Free `capMultiple` 1–255, alert severities.
- **Not added:** W2-B's optional `dry-run.sh` CI step and `workerd` in `onlyBuiltDependencies` (tests pass without either).
- **Size:** past M. My context ≈ 210k; the subagents used about 970k between them.
- No test was skipped, deleted or weakened.

## Spec issues
1. "Smart contract" (`RoundConfig.questionHash`): pin keccak256(abi.encode(string prompt, string label0, string emoji0, string label1, string emoji1)), each NFC-normalized then trimmed, `""` for no emoji, case kept.
2. "Data model" / "Sealed picks" › Free mode specifics: pin `freeConfigHash` = keccak256(utf8(RFC 8785 JCS of `{beaconDelay, free}`)) over the parsed Free section.
3. Locked config gaps ("Modes: Free and Stakes", "Data model"): Free preset defaults, Free `capMultiple` upper bound, the award recipient's type (author's user ULID, or null). Adopt the chosen values above.
4. "Non-functional requirements" › Alerts: no severities, no VOID-rate threshold, and the "beacon unavailable after 10 min" alert ("Round lifecycle") has no pinned code. Recommend adding `ALERT_BEACON_LATE`.
5. "Game day" is undefined; `time.ts` uses the New York date of `closesAt` and hard-codes the 21:00 close. Non-default closes need their own path (with W2-A's `MAX_BEACON_DELAY` note).
6. "API": the `* /admin/*` row has no paths (drafted in `api/admin.ts`; W11-A may reshape, which needs an ownership call); mount point of `/s/:shareId` and card images (probably site root, plus `run_worker_first`); nothing creates a teaser card or returns a share ID (added `cards[]` to `GET /rounds/:id/me`); handle syntax (used `^[a-z0-9_-]{3,20}$`); the `/rounds?before=` cursor, `/claims` refund proof and WS `state` payload are unspecified; the paymaster isn't in the table.
7. "Data model": pin a payouts key (used unique `(round_id, mode, user_id, kind)`); `entries.user_id` is NOT NULL, so an `Entered` event with no ticket (signer-compromise path) can't be mirrored; `stakes_tickets.expiry` is seconds; `audit_log` has no actor column (add `actor_user_id`). Added keys beyond the spec: PKs on `user_stats`, `room_members`, `notification_prefs`, `indexer_state`, `limits`; uniques on `entries.receipt_seq` (partial), `rooms.invite_code`, `push_subscriptions.endpoint`, `anchors.tx_hash`.
8. "Architecture": `cpu_ms` is per Worker, not per consumer (set Worker-wide to 60 000; or split decrypt into its own Worker). Retries, DLQs and non-decrypt batch sizes are unspecified.
9. "Real-time and the reveal": the WS `refunded` message has no provisional flag or final time (the DO's `ModeResult` has them).
10. "Modes: Free and Stakes": can a daily grant skipped at balance ≥ 1 000 be credited later the same round? The builder writes no ledger row on skip, so either reading works.
11. Wire rule (plan P2.4): "beacon-math times are seconds" should read "beacon-math and onchain times".

## Open issues
- Plan: wave 5's `routes/personhood.ts` and wave 7's `routes/identity.ts` aren't among the 15 modules (their endpoints live under `me`). Z: either D mounts extra sub-apps then, or those sessions edit `routes/me.ts`.
- W2-B fixture: `packages/abi/scripts/receipt-fixture.mjs` computes `userIdHash` over (bytes16, string), but settle uses (bytes16, binary ULID). Fixture data only.
- `wrangler.jsonc` staging/production resource IDs are placeholders the owner supplies (W13 or first staging deploy). `wrangler dev` needs `apps/web/dist` (W3-D).
- Decrypt CPU (W2-A: 6.4 ms per decrypt in workerd) must fit the queue batch and `cpu_ms` (W5).

## Notes for D and Z
- **Risky diffs worth reading:** `apps/api/migrations/0001_init.sql` against "Data model"; `apps/api/src/points/index.ts` (a named CHECK `point_balances_non_negative` aborts the D1 batch); `packages/shared/src/config.ts` (both hashes); `packages/shared/src/api/index.ts` (`ENDPOINTS`, the admin draft); `apps/api/wrangler.jsonc` (queue settings, crons, DO migrations).
- **plan.md updates for Z:** §4.2 Node 22.23 and `@cloudflare/vitest-plugin`; §4.3 `contracts:build` done; §4.6 the new CI steps; the W1-Z "watch" item (Vitest 5 no longer blocked by Node). Traceability: TL-4 ✅.
- **For wave 3:** W3-A adds the session middleware in `src/app.ts` before the `/api/v1` mount (sets `user`/`session` per `lib/auth-context.ts`). Route owners replace `stubEndpoints(...)` in their module, keeping `ENDPOINTS` order, and use `validate()` and `requireUser`. W3-B calls `stakeMovement({ …, roundId, entryInsert })` (ledger ref = round ID); the signup grant is `grantMovement` with reason `signup`, ref = user ID. Any update to a terminal mode status sets `final_at` in the same statement (CHECK). Queue owners add `src/queues/<name>.ts` and register it in `HANDLERS`. Migrations reserved: W3-A `0002`, W3-B `0003`, W3-D `0004`.
- Rejected DO RPC calls print harmless "uncaught exception" lines in vitest output.
