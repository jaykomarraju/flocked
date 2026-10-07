# W1-C handoff: `@flocked/settle`

## Status
complete — engine, closed form, invariant, Merkle builders, vectors and all SET/PROP tests green.

## Summary
- `packages/settle` is a self-contained package (P1.4) implementing P1.2: `settle()` (general formula: fees, cap, rebates, dust, VOID exclusion, refund rules 1–3 with `countQualifyingOnly`, Free `creatorAward` outside the invariant), `settleStakesClosedForm()`, `checkInvariant()`, `stakesPayoutTree` / `freePayoutTree` / `freeCommitmentTree` (OpenZeppelin StandardMerkleTree), `userIdHash`.
- Money is `bigint` only; params are validated and lifted to `bigint` before any arithmetic. Guarded by ESLint rules in `src/` and a type-level + grep test.
- Deterministic vector generator (`pnpm vectors`, seed `0x5e771e`) and three committed vector files (P1.1); the generator cross-checks closed form vs general formula entry by entry for every Stakes vector up to 300k entries.
- 66 tests (unit, 5 fast-check properties at 1,000 runs by default, Merkle cross-checks against `@openzeppelin/merkle-tree`, vector determinism/coverage).

## Branch and head commit
`w1-c-settle` @ `98d69c8` (plus this handoff commit)

## Files touched
All new, under `packages/settle/`:
- `package.json`, `pnpm-lock.yaml` (nested), `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `README.md`
- `src/{index,types,params,settle,closed-form,invariant,merkle}.ts`
- `test/{helpers,refunds,cap,free,void,edge,properties,merkle,money-types,vectors}.test.ts` (helpers is `helpers.ts`)
- `scripts/{gen-vectors,vectors}.ts`
- `vectors/{stakes-closed-form,stakes-payout-merkle,free-general}.json`, `vectors/README.md`
- `docs/sessions/W1-C.md` (new)

## Tests run
| Command (in `packages/settle`) | Result |
| --- | --- |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass (66 tests, 10 files, ~2 s) |
| `FAST_CHECK_RUNS=10000 pnpm test -t property` | pass (5 properties, ~6 s) |
| `pnpm vectors && git diff --exit-code vectors/` | clean (also run twice: byte-identical) |
| `pnpm build` | pass (emits `dist/`, gitignored) |

## Traceability rows covered
- SET-1: `test/refunds.test.ts` :: "SET-1 refund rules 1–3" (rule 1 at minEntrants − 1 and exact, VOIDs don't count, Free VOID-only/empty, rule 2, rule 1 precedes 2, rule 3 tie incl. uneven stakes) and "SET-1 room qualification (countQualifyingOnly)"
- SET-2: `test/cap.test.ts` :: "SET-2 cap and rebates" (not binding, binding, ratio 10/11 boundary, capMultiple 1, fees on whole pool, Free uneven-stake cap with proportional rebates and dust)
- SET-3: `test/free.test.ts` :: "SET-3 Free: headcount minority holding more stake"
- SET-4 (math part): `test/void.test.ts` :: "SET-4 VOID entries are excluded from tallies and refunded" (each of the 7 `VOID_REASONS`, Stakes and Free; malformed entries rejected)
- SET-5: `test/edge.test.ts` :: "SET-5 single-base-unit stakes"
- SET-6: `test/edge.test.ts` :: "SET-6 largest Stakes values in bigint" (100 USDC × 100k vs 150k through the general formula; billions of entrants, > 2^53)
- PROP-1..5: `test/properties.test.ts` :: "property > PROP-1: the invariant always holds and no payout is negative", "PROP-2: winner payout in [s, (1+cap)·s]; loser payout in [0, s]", "PROP-3: dust is below the losing headcount", "PROP-4: results are independent of entry order", "PROP-5: the Stakes closed form equals the general formula per entry"
- Acceptance "Merkle roots match OZ": `test/merkle.test.ts` :: "Merkle trees match OpenZeppelin StandardMerkleTree"; vectors: `test/vectors.test.ts`

## Deviations
- **Tool versions:** TypeScript 6.0.3 (not 7.0.2: typescript-eslint 8.71 requires `<6.1`); Vitest 4.1.11 (not 5.x: Vitest 5 needs Node ≥ 22, we run 20.19.5).
- **P1.2 left `StakesClosedForm` and the Free tree return types open.** Chosen: `StakesClosedForm` = `{ outcome, refundReason, winner, lossPool, fee, creatorFee, distributable, w, rebatePool, r, dust, winPayout, rebatePayout, voidRefund, roundBalance }` (mirrors the P1.1 `expected` block). `freePayoutTree(...).proof(userIdHash)`; `freeCommitmentTree(...).proof(seq)` (seq is unique per round).
- **Extra exports** (additive): `comparePayouts`, `InvariantError`, `STAKES_PAYOUT_LEAF` / `FREE_PAYOUT_LEAF` / `FREE_COMMITMENT_LEAF`, types `SettleResult`, `PayoutKind`, `PayoutTree`, `StakesLeafKind`, `FreeCommitmentLeaf`.
- **Input validation is strict** (throws): duplicate accounts, non-lowercase accounts, stake ≤ 0, valid entry without option, VOID with an option, unknown VOID reason, bps outside [0, 10000] or fee + creator > 10000, `capMultiple` < 1, non-integer params. Merkle builders reject empty trees, duplicate leaves and out-of-range values.
- **Zero rebates are omitted** from `settle()`'s payouts in both modes (spec states it only for Stakes leaves). Losers with r = 0 simply have no payout row.
- Vector `vectors` arrays are sorted by `id` (P1.1 "stable order (by id)").
- No test skipped or weakened.

## Spec issues
- **Settlement and payout math / Refund rules:** precedence when several rules apply isn't stated. Implemented 1 → 2 → 3 (e.g. 10 vs 0 with minEntrants 20 is rule 1). Recommend stating it; B's contract must match.
- **Same section:** one entry per account per round is implied by the Stakes leaf (no amount, no entry index) but not stated. `settle()` rejects duplicates. Recommend stating "one entry per account (Stakes) / per user (Free) per round".
- **Same section:** bounds on `capMultiple` (implemented ≥ 1) and `minEntrants` (≥ 0; with 0 an empty round refunds by rule 2) are unstated. Recommend the contract enforce the same.
- **Profiles… / Rooms, Anti-farming:** "distinct users / distinct people" is not something settle can see; it counts entries with `qualifies = true`. The API must set `qualifies` only on the first entry per person. Recommend saying so where qualification is computed.
- **Free creator award on refund:** spec silent; implemented as 0 (no Lp). Room rounds: caller passes `creatorAwardBps = 0`.
- **wave-1.md Open question** (Free rule 1 counts VOIDs?): implemented "no" per spec ("valid entries").

## Open issues
- None blocking. `pnpm install` warns that esbuild's build script was ignored; tsx and Vitest work anyway. D may add `onlyBuiltDependencies` at the root.

## Notes for D and Z
- **Dependencies (exact):** runtime `@openzeppelin/merkle-tree` 1.0.8 (pulls `@metamask/abi-utils`, `ethereum-cryptography`), `viem` 2.57.3. Dev: `typescript` 6.0.3, `vitest` 4.1.11, `fast-check` 4.10.2, `eslint` 10.12.0, `typescript-eslint` 8.71.1, `@eslint/js` 10.0.1, `tsx` 4.23.15, `@types/node` 20.19.43.
- **Vector generator:** `pnpm --filter @flocked/settle vectors` (= `tsx scripts/gen-vectors.ts`). Logic is in `scripts/vectors.ts` (`generateVectors()`, pure). `test/vectors.test.ts` already fails if committed vectors differ from a fresh generation; CI can additionally run `pnpm --filter @flocked/settle vectors && git diff --exit-code packages/settle/vectors`.
- **CI property job:** `FAST_CHECK_RUNS=10000 pnpm --filter @flocked/settle test -t property`.
- **Folding into the workspace:** delete `packages/settle/pnpm-lock.yaml` and `node_modules`; hoist shared devDeps to the root if the root config does; replace `eslint.config.js` with the root config **but keep the `src/**` money rules** (`no-restricted-globals` parseFloat/parseInt, `no-restricted-properties` Math.*, `no-restricted-syntax` `Number(...)`). `tsconfig.json` can extend a root base; keep `strict`, `noUncheckedIndexedAccess`, `types: ["node"]` (tests and scripts only; `src/` uses no Node APIs). `exports` points at `src/index.ts` so workspace consumers need no build.
- **For B/D vector cross-check:** Foundry reads `../packages/settle/vectors/*.json`; `status` 2/3, `winner` 255 on refund, everything decimal strings. The closed form's rule-1 count is n0 + n1 (VOIDs excluded), the ordering 1 → 2 → 3 above, and `capMultiple ≥ 1` are what the contract must match.
- Risky diff worth reading: `src/settle.ts` (~140 lines) and `src/closed-form.ts`.
