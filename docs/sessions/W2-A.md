# W2-A handoff: `@flocked/tlock`

## Status

complete — P2.1 built on tlock-js 0.9.0; TL-1 (Workers half), TL-2, TL-3 and TL-4 (vectors) proven; root `pnpm check` green on Node 22.

## Summary

- `packages/tlock` exists: pinned `QUICKNET` and `chainFromEnv` (`src/chains.ts`, the only home of chain constants), beacon math and `checkTargetRound`, the 34-byte plaintext codec and round references, binary-age `encryptPick`, a strict age-header parser (`isCanonicalHeader`), synchronous BLS `verifyBeacon`, `decryptWithSignature`, `classify` and `commitment`, plus base64url helpers.
- Decrypt-with-given-signature: tlock-js's `timelockDecrypt` fetches beacons itself, checks the wall clock and never checks the chain hash, so it isn't used. `src/seal.ts` calls tlock-js's `decryptAge` with its own stanza unwrapper, which passes the verified signature to tlock-js's `decryptOnG2`. Encryption uses tlock-js's `createTimelockEncrypter` and `encryptAge` against an offline chain client. `verifyBeacon` is `@noble/curves` 1.9.1 (tlock-js's version) `verifyShortSignature` with the RFC 9380 G1 DST. The README has the full approach.
- Fixtures: 7 real quicknet beacons (rounds 1, 9, 10, 1e6, 12 345 678, 32 870 000, 32 870 075) and `/info`, fetched once from `api.drand.sh` with source URLs; 7 Node-made ciphertexts that the Workers test decrypts.
- `vectors/target-round.json`: 36 generated cases, with a freshness test.
- Tests run in two Vitest projects: `node` (149) and `workers` (12, inside workerd).
- `.nvmrc` is now 22.23 (owner decision this session, below).

## Branch and head commit

`w2-a-tlock` @ `919b098` (the handoff commit follows it)

## Files touched

- New: `packages/tlock/**`: `package.json`, `README.md`, `tsconfig.json`, `vitest.config.ts`, `src/{chains,rounds,plaintext,header,encoding,beacon,seal,classify,commitment,index}.ts`, `test/{helpers,roundtrip,roundtrip.workers,signature,classify,plaintext,rounds,vectors,chains}.ts`, `scripts/{fetch-beacons,make-ciphertexts,vectors,gen-vectors}.ts`, `fixtures/quicknet-{beacons,ciphertexts}.json`, `vectors/target-round.json`.
- Edited: `.nvmrc` (20.19 → 22.23, owner-approved), `pnpm-lock.yaml` (from `pnpm add` in `packages/tlock` only; viem's peer key also gained `zod`, same viem version).
- New: `docs/sessions/W2-A.md`.

## Tests run

All on Node 22.23.1.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm --filter @flocked/tlock typecheck` / `lint` | pass |
| `pnpm --filter @flocked/tlock test` | pass (161: node 149, workers 12) |
| `pnpm check` | pass (node:test 20, shared 13, settle 66, tlock 161, forge 144) |
| `pnpm format:check` | pass |

## Traceability rows covered

- **TL-1 (Workers half):** `packages/tlock/test/roundtrip.workers.test.ts` :: "decrypts and classifies ciphertexts made in Node with the recorded signatures", "verifyBeacon accepts recorded round $round and rejects a flipped bit", "round-trips a pick encrypted inside workerd". Node half: `test/roundtrip.test.ts` :: "TL-1 (Node): encrypt to a recorded round, decrypt with its recorded signature". The browser half stays with W9-C.
- **TL-2:** `test/signature.test.ts` :: "flipping signature bit %i fails verification", "classify throws on a corrupted signature instead of returning VOIDs".
- **TL-3:** `test/classify.test.ts` :: "TL-3: malformed ciphertexts and bad plaintexts are VOID with their exact reason": 21 `non_canonical_header` cases (garbage, armor, extra tlock or X25519 stanza, arguments, decimal and hash form, wrapping, base64, CRLF, MAC line), 4 `wrong_target` (other round, other chain hash, round 0), 16 `decrypt_failed`, 8 `bad_plaintext` (length, version, round reference), 4 `bad_option`.
- **TL-4 (TypeScript half):** `vectors/target-round.json` and `test/vectors.test.ts` :: "TL-4 (TypeScript half): target-round vectors" (freshness, every case replayed, coverage of every error). The forge half is W2-D's.
- **SET-4 (classification part):** `test/classify.test.ts` (as TL-3). `not_anchored` and the stake range are W5-A's.
- Property: `test/plaintext.test.ts` :: "property: encode/decode round-trip and the length is always 34".

## Deviations

- **Node 22.** `@cloudflare/vitest-pool-workers` (every Vitest-4 version) depends on wrangler and miniflare, which need Node ≥ 22, and the root `.npmrc` has `engine-strict=true`. The owner chose to move now (AskUserQuestion, recommended option), so `.nvmrc` = 22.23 (CI reads it). The root `engines` field is unchanged (`>=20.19`, which 22 satisfies).
- **`@cloudflare/vitest-plugin` 1.3.7** replaces `@cloudflare/vitest-pool-workers`, which is deprecated and renamed (0.23.0 is its last release). Same API (`cloudflareTest`).
- **Vector format:** P2.1's seven fields plus `id`, `now`, `gameDay` (`""` unless daily) and `contractError` (`""`, `InvalidBeaconRound` or `BeaconOutOfRange`), so the client-only errors can be expressed and W2-D knows the contract's outcome. `expectedOk` is a boolean and `reason` a string (`""` when ok). Numbers are decimal strings.
- **`TargetRoundError`** members are defined here (P2.1 named the type only): `invalid_round`, `beacon_too_early`, `beacon_too_late`, `invalid_delay`, `not_first_round`, `beacon_in_past`, `wrong_daily_close`. The contract's checks run first.
- **Additive exports:** `TARGET_ROUND_ERRORS`, `isDailyClose`, `PLAINTEXT_LENGTH`, `PLAINTEXT_VERSION`, `toBase64Url`, `fromBase64Url`.
- **Stricter than the P2.1 signatures:** `encryptPick` refuses plaintexts that aren't 34 bytes. `classify` also throws (`RangeError`) when `roundRef` isn't 16 bytes, which is a caller error, not a VOID. `checkTargetRound` throws for non-integer `closesAt`/`now`. `decryptWithSignature` doesn't re-verify the signature (the caller does, as P2.1 says); it throws on a non-canonical header or another chain.
- An extra fixture, `fixtures/quicknet-ciphertexts.json`, proves cross-runtime decryption.
- No test was skipped, deleted or weakened.

## Spec issues

- **"Invalid entries": the VOID reasons have no order**, but one ciphertext can fail several checks, and the watcher must recompute the same reason. Recommend writing in the order `classify` uses: header → target → decrypt → plaintext → option (README, "VOID order").
- **"Canonical ciphertext header" leaves the encoding rules open.** Recommend pointing it at the rules as built: age's strict base64 and 64-column wrapping, LF only, lowercase hash, no leading zeros. A blob that isn't age at all is `non_canonical_header`, and a right round with another chain hash is `wrong_target` (wave-file open question).
- **"Scheduling": `MAX_BEACON_DELAY` can be unreachable.** When `closesAt` isn't a round time (not ≡ genesis mod 3 s), the first round at or after `closesAt + 600` lands 1–2 s past the bound, so `beaconDelay` = 600 can never be valid. The 21:00 New York closes are aligned (whole hours, and quicknet's genesis is ≡ 0 mod 3), so launch rounds aren't affected. Recommend that config validation run `checkTargetRound` on any non-default close or delay. The vectors cover it (`qn-delay600-phase*-too-late`).
- **Stakes `beaconDelay` isn't onchain.** `RoundConfig` has no `beaconDelay`, so the client checks "first round at or after `closesAt + beaconDelay`" against the published locked config, not chain data. (Free commits it in the lock leaf.) Worth a sentence in "Round config check (Stakes)".

## Open issues

- **Interop:** no ciphertext from the Go reference (`tle`) is in the fixtures (no Go toolchain here). Adding one is a cheap check (W9-C or later).
- **Browser bundle (W9-C):**
  - tlock-js's indirect `require("crypto")` breaks Vite 8/rolldown pre-bundling unless `crypto` is external.
  - This package imports `@noble/curves`' ESM build while tlock-js requires the CJS one, so a bundle may carry both.
  - Bundle size isn't measured yet.
- **Root `@types/node`** is still 20.19 while the runtime is 22 (D).

## Notes for D and Z

- **Toolchain (D/Z):**
  - Raise the root `engines.node` to `>=22.23` and `@types/node` to 22.
  - Z: update plan.md §4.2 (Node 22; `@cloudflare/vitest-plugin` instead of `vitest-pool-workers`) and the W1-Z "watch" item. Vitest 5's Node-22 blocker is gone.
  - Local sessions need `nvm use` (22.23) before `pnpm install`, because `engine-strict` rejects wrangler on Node 20.
- **CI:**
  - Nothing is required. `setup-node` reads `.nvmrc`, and `pnpm test` runs both tlock projects; workerd comes from `@cloudflare/workerd-linux-64` as an optional dependency.
  - Optional additions:
    1. A freshness step: `pnpm --filter @flocked/tlock vectors && git diff --exit-code packages/tlock/vectors`. The vectors test already fails if the file is stale.
    2. In `properties`: `pnpm --filter @flocked/tlock exec vitest run --project node -t property` with `FAST_CHECK_RUNS=10000`.
    3. Add `packages/tlock/vectors/*.json` and `packages/tlock/fixtures/*.json` to `.prettierignore`, since they are byte-exact. They pass Prettier today.
    4. pnpm prints "Ignored build scripts: workerd". Tests pass without the script; add `workerd` to `onlyBuiltDependencies` only if wrangler needs it.
- **W2-D TL-4 forge replay** (`contracts/test/TargetRound.t.sol`):
  - Three `(genesis, period)` pairs: quicknet, (1700000000, 1) and (1700000000, 30).
  - For each case: deploy or configure the escrow with that pair, warp below `opensAt < closesAt`, call `createRound`, and expect `contractError`.
  - `now`, `gameDay`, `beaconDelay` and `reason` are client-only. Every case the contract rejects is also refused by the client (tested).
- **Workers setup** (copy for `apps/api`):
  - Use `cloudflareTest({ miniflare: { compatibilityDate, compatibilityFlags: ['nodejs_compat'] } })`.
  - Set `test.deps.optimizer.ssr` = `{ enabled: true, include: [the three deep tlock-js paths], rolldownOptions: { external: ['crypto'] } }`. Without pre-bundling, workerd's CJS fallback returns `undefined` for tlock-js's nested `require("@noble/curves/...")`.
  - `nodejs_compat` is only needed to encrypt in a Worker.
  - The deployed Worker is bundled by wrangler's esbuild; W3 should confirm `decryptWithSignature` under `wrangler dev`.
- **Decrypt timing** (load-test input; local Apple Silicon, N = 20):
  - workerd: **6.4 ms per decrypt**, 5.5 ms per `verifyBeacon`.
  - Node 22: 18.4 ms and 14.9 ms.
  - `classify` with a cached signature costs about one decrypt.
  - Rough budget: 10 000 entries ≈ 64 s of CPU, so the decrypt queues must batch within the Worker CPU limit.
- **Shared helpers (D, P2.4):**
  - Cross-test `shared/time.ts` `dailyClosesAt(gameDay)` against `isDailyClose`, and `shared/ids.ts` ULID → bytes against `roundRefFromUlid`, or have shared reuse them.
  - `classify` returns settle's `VoidReason`.
- **Lockfile:** if B's `pnpm add` conflicts, regenerate. tlock adds `tlock-js` 0.9.0, `@noble/curves` 1.9.1, `@noble/hashes` 1.8.0, `@cloudflare/vitest-plugin` 1.3.7, `fast-check` 4.10.2 and `tsx` 4.23.15.
- **Risky diffs worth reading:** `src/header.ts` (what counts as canonical) and `src/seal.ts` (the tlock-js internals used).
