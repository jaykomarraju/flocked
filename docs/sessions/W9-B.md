# W9-B handoff: `@flocked/verify` + CLI

## Status

complete — `verifyRound`, `verifyEntry`, the `flocked-verify` CLI (exit 0/1/2) and `@flocked/verify/browser` reproduce Free and Stakes settlements from bundles made by the W5-A pipeline; the live-chain run is W9-D's PIPE-6 e2e.

## Summary

- **Fetch and check** (`src/recompute.ts` `loadBundle`): the manifest and every chunk, strictly parsed against `docs/bundle-format.md` (bundleFormat 1) and re-encoded to prove the bytes are canonical JCS; chunk hashes, the seq partition (chunk i = seq [i·size, (i+1)·size)), `ChunkRef` fields, per-chunk totals and VOID counts, entry field rules, `voids` per reason. A newer `bundleFormat` or `formulaVersion` is unverifiable, not a mismatch.
- **drand:** chain hash and `verifyBeacon` for `beaconRound` (`@flocked/tlock`); default quicknet, or `drand` / `--drand-info` / `DRAND_*` env.
- **Recompute:** each entry's reason in the pinned order (Free `not_anchored`, `stake_out_of_range`, then `classify`; Stakes `classify` with the chain round ref), option and nonce; Free `commitment = keccak256(ciphertext)`; `settle` with the locked params (`countQualifyingOnly` for `kind = room`, the bundle's `qualifies` flags); the record field by field; the payout root (Free tree any outcome, Stakes only when settled); the Free commitment root over seq < `commitment.entryCount`. Room flags: no VOID qualifies, Stakes `qualifies = valid`, no account qualifies twice. `settle` refusing the entries (e.g. one account twice) is a mismatch, not a crash.
- **Compare (Free):** `getAnchor(roundKey(roundId, 0))`: closesAt and beaconRound, `configHash = freeConfigHash(config)`, commitment root, entry count and total stake, `manifestHash = bundleHash`, `anchorTx` = the `Committed` tx. Each write's sender (`Locked`, `Committed`, `ManifestAnchored`) is reported; a later `RoleRevoked(ANCHOR_ROLE, sender)` marks it disputed.
- **Compare (Stakes):** `getRound(chainRoundId)` config against the locked config; the close block's hash; `Entered` logs up to the close block (count, and every log the round has; player and stake per seq; ciphertexts from the logs); the `OutcomeProposed` log whose `bundleHash` matches: status, n0, n1, nVoid, payoutRoot (zero for a refund).
- **Verdict:** any failed check → `mismatch` (1); else any check that couldn't run (no bundle, not anchored or proposed yet, an RPC error, an anchor log not found) or a disputed anchor → `unverifiable` (2); else `match` (0). Per-entry checks are aggregated (first five bad seqs listed).
- **CLI** (`bin/flocked-verify.mjs` → `src/cli.ts`): text or `--json`, progress on stderr, `--account` prints that account's entries and payouts with Merkle proofs. **Browser subset** (`src/browser.ts`): everything but `node.ts` (directory source) and `cli.ts`; esbuild bundles it for the browser platform with no Node built-ins.

## Branch and head commit

`w9-b-verify` @ `1492c5a` (code `a2dd20a`, then the mutation-driven tests); this handoff is the next commit.

## Files touched

All new, under `packages/verify/`: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `bin/flocked-verify.mjs`; `src/{types,bundle,checks,chain,source,recompute,verify,cli,node,browser,index}.ts`; `test/{verify,tamper,room,cli,chain,browser}.test.ts`, `test/{pipeline,helpers}.ts`, `test/stubs/cloudflare-workers.ts`. Edited: `pnpm-lock.yaml` (the new importer only). This file.

## Tests run

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` on `wave-8` before any change | pass |
| `pnpm --filter @flocked/verify test` | pass (46 tests, 6 files, ~10 s) |
| `pnpm check` (Node 22.23.1) at `1492c5a`'s tree | pass: abi 13, settle 66, tlock 176, shared 504, e2e phase check 4, web 284, signer 19, **verify 46**, api 1311, forge 202 |
| `pnpm format:check` | pass |
| Mutation checks (scratchpad script, one replacement per run) | 6 of 6 killed: `countQualifyingOnly` dropped (room.test), pre-void order swapped (verify.test, after adding an entry both unanchored and out of range), revocation ignored (verify.test › disputed), chunk VOID count unchecked (tamper.test › a chunk's VOID count, added), Stakes player not compared (verify.test › another player, added), creator award ignored for `awardRecipient` null (verify.test) |

## Traceability rows covered

- **PIPE-6** (W9-B part, fixtures): `packages/verify/test/cli.test.ts` › "exit 0 on a Free bundle from the pipeline, and on a Stakes one", "exit 1 on a mismatch, 2 when …", "--account …", "the bin runs through node and a real viem client …". Fixtures are made by the API's own `decryptChunk` and `reduce` (`test/pipeline.ts`). The e2e half (`e2e/tests/verify-cli.spec.ts`) is W9-D's.
- **AC-3** (partly): the CLI half against fixtures; the `npx` form and the Verify page are later (see Open issues).
- Required tamper tests: `test/tamper.test.ts` (Free and Stakes each): one byte in a chunk, the payout root, a VOID reason, a VOID turned valid, chunk totals, a chunk's VOID count, the record, a manifest the chain never saw; Free: a swapped ciphertext, a changed anchored stake, a non-canonical manifest.
- Room bundle where a non-qualifying entrant changes rule 1: `test/room.test.ts` › "a non-qualifying entrant (account under 24 h) …" and "flipping the non-qualifying flag changes the recomputed outcome …".
- Browser subset without Node APIs: `test/browser.test.ts`.

## Deviations

- **Pinned `verifyRound`:** the pinned fields are unchanged; optional `addresses`, `source`, `reader` (tests) and `onProgress` were added. `verifyEntry({ ...VerifyRoundOptions, account }) → { report, entries, payouts }` (the pin left its arguments open).
- **`bundleBaseUrl` is the API origin:** bundles are read from the pinned public route `GET /rounds/:id/bundles/:mode/:file` (W6-Z). `httpSource(url, { layout: 'bucket' })` / `--bucket-layout` read a bucket mirror (`{url}/bundles/…`); a CLI directory path is read as a bucket mirror.
- **Fixtures are generated in the tests, not committed.** tlock encryption is randomized, so committed files could not be regenerated byte for byte. The tests import `apps/api/src/settlement/{decrypt,reduce}.ts` by a computed path (so this package's typecheck doesn't pull in Workers types) with `cloudflare:workers` aliased to a stub in `vitest.config.ts`. `prepareChunks` needs D1 and the anchor, so the fixture builder writes the decrypt inputs itself, mirroring its pre-void rule.
- **A disputed anchor makes the verdict `unverifiable` (exit 2)** even when everything else matches: a write from a later-revoked key can't be trusted (see Spec issues).
- **Session size:** about 270k tokens in this session's own context (about 70k of it the harness's system prompt and tools), no subagents: over size M. I didn't split, because the work fit in one pass with no `.2` needed.
- No test was skipped, deleted or weakened.

## Spec issues

- **"Smart contract" › Stolen anchor key:** the spec says a later-revoked key's anchors are disputed but not how that affects the verdict, and a routine rotation (revoking an old key) would dispute every past anchor it made. Recommend: say disputed means exit 2 (as built), and have the anchor-key runbook rotate by granting the new key and revoking the old one only on compromise, or list routine rotations so the verifier can accept them.
- **`docs/bundle-format.md` › Verifying a bundle:** it doesn't name where bundles are fetched from. Recommend naming the public route `/rounds/:id/bundles/:mode/:file` (and any public bucket URL) there.
- **`docs/bundle-format.md` › Manifest (`commitment`):** "null … for a Free mode with no entries", but `prepareChunks` treats a missing commitment as "every entry anchored". The verifier fails a Free bundle with entries and a null commitment. Recommend stating that it can't happen (such a mode is refunded under rule 4 before the reveal and publishes no bundle).

## Open issues

- **`npx @flocked/verify` (AC-3):** the bin loads TypeScript sources through `tsx`, like every workspace package; publishing needs a build (bundle `src/cli.ts`, ESM, with `@flocked/*` inlined). Owner: the session that publishes it (W11-C or the release wave).
- **Live chain:** `viemReader` is checked by types (ABI-typed `readContract`/events), a fake-transport test (log order, range bisection) and the unreachable-RPC CLI test only. W9-D's PIPE-6 e2e is its first run against the real contracts.
- **Long scans on Base:** `RoleRevoked` and `OutcomeProposed` are read from the write or close block to the head, halving a refused range down to 500 blocks. A provider with a tight `getLogs` limit makes this slow. Anchor writes are located by binary search on block timestamps (`lockedAt`, `committedAt`, `manifestAnchoredAt`).
- Decryption is sequential (~6 ms per entry): about 10 min for 100k entries. Fine for the CLI; the Verify page (W11-C) should verify one entry, not a whole round.

## Notes for D and Z

- **New dependencies of `packages/verify`** (lockfile importer only, committed): `@flocked/{abi,settle,shared,tlock}` (workspace), `tsx` 4.23.15, `viem` 2.57.3, `zod` 4.6.5; dev `esbuild` 0.28.2. All were already in the lockfile, so W9-D only re-resolves at the merge.
- No registration is required: `pnpm -r` picks the package up for lint, typecheck and test. Optional root script: `"verify": "node packages/verify/bin/flocked-verify.mjs"`.
- If `apps/api/src/settlement/{decrypt,reduce,prepare}.ts` gain new `cloudflare:*` imports, `packages/verify/test/stubs/cloudflare-workers.ts` may need the new names.
- **PIPE-6 e2e (W9-D), running the CLI against the stack**, from the repo root after a Free round settles and anchors (and a Stakes round has its proposal):
  ```bash
  S=e2e/stack/.state.json
  node packages/verify/bin/flocked-verify.mjs --round <roundId> --mode free \
    --rpc "$(jq -r .anvil.rpcUrl $S)" --chain-id 31337 --deployment contracts/deployments/31337.json \
    --bundles "http://127.0.0.1:${STACK_API_PORT:-8787}" --drand-info "$(jq -r .drand.url $S)/info" --json
  ```
  Use `--mode stakes` for Stakes. Expect exit 0. A Stakes mode before its proposal, or a Free mode before `anchorManifest`, is exit 2, and the public route serves bundles only once the mode is revealed. For a tamper case, copy the bundle into a directory (`<dir>/bundles/<roundId>/<mode>/…`), change one byte, pass `--bundles <dir>` and expect exit 1. `--account <userIdHash|wallet>` prints that account's payout proof, which can be checked against `GET /claims`.
