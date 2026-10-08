# Wave 2 summary

## Status

Merged to `main` at `776b0a2` (`--no-ff` of `w2-integration` @ `fa67113`). CI: `w2-integration` run 37741448828 success (`check`, `contracts`, `properties`); `main` run 37741723764 success. Tag `wave-2` is on `main`'s head, the commit that adds this summary, so wave-3 worktrees contain it and `main` equals the tag.

Local checks on `w2-integration` before the merge and on `main` after it (Node 22.23.1): `pnpm install --frozen-lockfile && pnpm check` (node:test 20, abi 11, settle 66, tlock 161, shared 438, api 281, forge 199) and `FOUNDRY_PROFILE=ci forge test` (199), nothing skipped. All four handoffs were `complete` (W2-C finished through W2-C.2 after the owner upgraded to Paper Pro).

## On main now

- **Toolchain:** Node 22.23 (`.nvmrc`, root `engines >=22.23`, `@types/node` 22), `@cloudflare/vitest-plugin` 1.3.7 for Workers-runtime tests. CI adds tlock vector freshness, the design-tokens schema test, ABI freshness (`gen.mjs --check`) and tlock property tests; every `--filter` step fails if nothing matches.
- **`@flocked/tlock`** (W2-A): pinned quicknet config, beacon math and `checkTargetRound`, the 34-byte plaintext codec, binary-age `encryptPick`, a strict canonical-header parser, synchronous BLS `verifyBeacon`, `decryptWithSignature`, `classify` (never throws on bad ciphertext) and `commitment`. Runs in Node and workerd (6.4 ms per decrypt in workerd). 36 target-round vectors.
- **`contracts/`** (W2-B): `FlockedEscrow` with admin-only `unpause` and a single-holder guardian (`transferGuardian`); `FlockedAnchor` (write-once lock, commit and manifest per round key, skip-and-emit batches, 72 h timelocks, EIP-712 receipts with `verifyReceipt`); CREATE2 `Deploy.s.sol` plus an anvil dry run. 199 forge tests; 100% line and branch coverage on both contracts. `TargetRound.t.sol` replays the tlock vectors through `createRound`; `SharedEip712.t.sol` checks shared digests against the contracts.
- **`@flocked/abi`** (W2-B): generated `as const` ABIs, committed deployments, `addressesFor(chainId, local?)`; `pnpm contracts:build` regenerates them.
- **`@flocked/shared`** (W2-D): zod schemas for every API row (`ENDPOINTS`, 63 entries incl. drafted `/admin/*` and `POST /paymaster`), WS and queue messages, locked config with RFC 8785 JCS, `freeConfigHash`, `questionHash`, New York time math, ULIDs, EIP-712 builders, `roundKey`/`MODE_CODES`, alert codes, `formatShare` with `winLine`/`lossLine(count, total)`, the tokens schema, and `design-tokens.json` (W2-C).
- **`@flocked/api`** (W2-D): `wrangler.jsonc` (all bindings, three environments; staging/production IDs are owner-supplied placeholders), migration `0001_init.sql` (the full data model), Hono app with 501 stubs for 15 route modules, `src/lib/*`, seven DO stubs with pinned RPC types, atomic points movements, queue and cron dispatch, Workers tests and helpers.
- **Design** (W2-C): Paper file "Flocked" with `Foundations` (5 artboards) and `Components` (18 sheets, light and dark); 23 exports under `docs/design/exports/`; `docs/design/{screens,README}.md`.

## Interfaces changed or added

- `docs/plan/wave-2.md` "As built (W2-Z)" lists every addition to P2.1–P2.4; the handoffs' "Deviations" have the detail.
- W2-Z fixes on `w2-integration`: `apps/api/src/points/index.ts` (a retried guarded grant could credit twice; the credit now also requires the balance below the threshold, with a test); `packages/shared/src/copy.ts` (four approved voice lines in `VOICE`); `apps/api/migrations/0001_init.sql` (`entries.user_id` nullable with `foreign_entry` and a CHECK; `audit_log.actor_user_id`; no database exists yet, so `0001` was edited rather than rebuilding `entries` in a later migration) and `apps/api/test/migrations.test.ts`; `packages/shared/src/alerts.ts` (`ALERT_BEACON_LATE`, the VOID-rate threshold) and its test; `packages/shared/test/api.test.ts` (the paymaster row is now in the spec's API table); comment fixes in `packages/shared/src/{api/index,api/entries,config}.ts`.

## Decisions

Owner decisions on Oct 8, 2026 (all recommended options). Thirteen Decision log rows dated Oct 8.
- **tlock:** VOID order header → target → decrypt → plaintext → option; canonical-header rules as built; another round or chain hash is `wrong_target`; a non-canonical `U` or wrong-length stanza body is `decrypt_failed` (code: W3-B).
- **Hashes:** `questionHash` = keccak256(abi.encode(prompt, label0, emoji0, label1, emoji1)) over NFC-then-trimmed strings; `freeConfigHash` = keccak256 of the JCS of `{beaconDelay, free}`.
- **Anchor:** receipt domain version "1"; `lock` only before close; `anchorManifest` reverts; `setReceiptSigner(0)` is immediate; Free = 0, Stakes = 1.
- **beaconDelay:** config validation runs the target-round check on non-default closes or delays; Stakes clients check against the published locked config.
- **Config:** Free presets 10/25/50/100, `capMultiple` 1–255, award recipient = author ULID or null; game day = New York date of `closesAt`; a skipped daily grant is final for the day.
- **Foreign entries** (stolen ticket signer): stored with `user_id` NULL and a foreign flag, alert, settlement held for the guardian.
- **API and data model:** the drafted answers (admin paths, site-root share routes, `cards[]`, handle rule, paymaster row, payouts at finalize, `audit_log.actor_user_id`, seconds for onchain times, WS `refunded` fields).
- **Client:** Stakes hidden only for region, age and self-exclusion; five-tab navigation.
- **Design:** dark `accent-ink` `#121212`; light `muted` `#6E6E6E`; new `scrim`; rules for text on and in the accent; mascot dark mode as drawn; four voice lines.
- **Ops:** `cpu_ms` 60,000 Worker-wide; retries, DLQs, batch sizes and crons as drafted; `ALERT_BEACON_LATE`; VOID-rate threshold 2% and ≥ 10.
- Spec sections edited: "Overview" (Game day), "Round lifecycle", "Sealed picks (timelock encryption)", "Settlement and payout math", "Modes: Free and Stakes", "Identity and personhood", "Smart contract", "Architecture", "Data model", "API", "Real-time and the reveal", "Client app", "Profiles, leaderboards and rooms", "Compliance and responsible play", "Non-functional requirements", and the Decision log. Design_Language.md: "Color tokens", "Typography", "Mascot", "Voice".
- Plan (Z's call): personhood and identity handlers live in `routes/me.ts` (they are `me` rows in `ENDPOINTS`), so no new route modules (wave-5 and wave-7 files updated).

## Traceability

- Closed: TL-2, TL-3, TL-4, CON-9 (✅); CON-7 extended with the guardian and `unpause` tests.
- Partly proven: TL-1 (Workers and Node halves; browser half W9-C), SET-4 (math and classification; pipeline W5-A).

## Carry-over

- **W3-B:** the tlock `U` fix and environment-error rethrow; a 2,048-byte ciphertext cap at submit; look up the existing entry on a failed retried stake; receipts via the shared builder and the abi fixture's `userIdHash`.
- **W3-C:** apply the colour decisions (tokens, schema, Paper, re-exports); draft refund lines per reason.
- **W3-D:** confirm tlock in the `wrangler dev` bundle; `apps/web/dist` placeholder; Ubuntu 26 on `ubuntu-latest` from Oct 19.
- Later waves (recorded in each wave file's "Carry-over from W2-Z"): W4-A unique daily round, config validation, Free `stakeMax` ≤ 2^53 − 1; W4-B foreign entries; W4-C escrow and `gen.mjs` nits, CREATE2 factory; W5-A payouts at finalize, VOID threshold, decrypt CPU; W6-A payouts for foreign entries; W6-D room-round auth and caching; W7-A WS fields; W8-B streak update; W8-C navigation and mascot components; W9-A push upsert; W9-C browser bundle and `tle` interop; W10-A `run_worker_first` for share and card paths; W14-A staging routes and resource IDs.
- **Watch:** `Vectors.t.sol` gas (from W1-Z); TypeScript 7 still waits on typescript-eslint. Vitest 5 is no longer blocked by Node.

## Owner actions

- **OA-D1 (any time before W8):** review Foundations and Components in Paper. Wait for W3-C's colour update (muted, scrim) before signing off.
- **OA-01 (needed by W3-D):** open OrbStack once and confirm `docker run hello-world`. W3-D stops as `blocked` without it.
- **OA-20 (audit, needed by W15; start now):** book an auditor; the package comes from W4-C after W4-Z.
- **OA-21 (legal, text by W12) and OA-22 (Coinbase personhood, by W16):** start now; both have long lead times.
- **OA-02 done:** the Paper MCP works (Paper Pro).
- Nothing else is due in waves 3–4. `apps/api/wrangler.jsonc` holds placeholder staging/production resource IDs that the owner supplies at the first staging deploy (W14-A; OA-04 by W13).

## Next wave

- Prompts: `docs/prompts/W3-A.md` (auth and sessions), `W3-B.md` (RoundDO Free entries, plus the tlock fix), `W3-C.md` (design: colour decisions, then core flow) run in parallel; `W3-D.md` (local stack + first Free entry) after all three report complete.
- Changes from the wave file are in `docs/plan/wave-3.md` "Changes from W2-Z". Migrations: W3-A `0002`, W3-B `0003`, W3-D `0004`.
