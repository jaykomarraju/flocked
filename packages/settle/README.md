# @flocked/settle

The pure settlement engine shared by the contracts' tests, the API, the verify CLI and the watcher. It follows the spec section "Settlement and payout math" exactly: integer arithmetic in base units, `bigint` only, floor everywhere. No Node or Workers APIs; runs in the browser, Workers and Node. Dependencies: `@openzeppelin/merkle-tree` and `viem`.

## API

| Export | What it does |
| --- | --- |
| `settle(entries, params)` | General formula (Free and Stakes). Returns the `SettlementRecord` and payouts sorted by account, then kind. |
| `settleStakesClosedForm({ stake, n0, n1, nVoid, ...params })` | Stakes closed form from headcounts, as the contract computes it. |
| `checkInvariant(record, payouts)` | Throws `InvariantError` unless the invariant and structural rules hold. |
| `stakesPayoutTree`, `freePayoutTree`, `freeCommitmentTree` | OpenZeppelin StandardMerkleTree builders: `{ root, proof(...) }`. |
| `userIdHash(roundId, userId)` | `keccak256(abi.encode(bytes16, bytes16))`. |
| `FORMULA_VERSION`, `VOID_REASONS` | Constants. |

`number` appears only for bps, the cap multiple and counts in `SettleParams`; params are lifted to `bigint` before any arithmetic. A test greps `src/` to keep it that way.

## The formula

Valid entry i has stake s_i. N(o) is the headcount on option o, W(o) its total stake, T = W(0) + W(1), V = total VOID stake. VOID entries are excluded from N, W and T and always refunded in full.

**Refunds** (every stake back, kind `refund`), checked in order:

1. fewer than `minEntrants` valid entries (with `countQualifyingOnly`, only valid entries with `qualifies = true` count);
2. one-sided: an option has no valid entries;
3. headcount tie: N(0) = N(1).

**Otherwise** the winner M is the option with the smaller headcount and L the other; Lp = W(L).

```
F  = ⌊Lp · feeBps / 10000⌋
C  = ⌊Lp · creatorBps / 10000⌋
D  = Lp − F − C
w_i = min(⌊D · s_i / W(M)⌋, capMultiple · s_i)        (i on M)   payout s_i + w_i
R  = D − Σ w_i
r_j = ⌊R · s_j / Lp⌋                                  (j on L)   payout r_j (omitted when 0)
dust = R − Σ r_j
```

**Invariant:** Σ payouts(M) + Σ payouts(L) + V + F + C + dust = T + V. Free runs with `feeBps = creatorBps = 0`; its `creatorAward = ⌊Lp · creatorAwardBps / 10000⌋` is house-minted and outside the invariant.

**Stakes closed form** (all stakes equal s): Lp = N_L·s; w = min(⌊D / N_M⌋, capMultiple·s); R = D − N_M·w; r = ⌊R / N_L⌋; dust = R − N_L·r. Winners get s + w, losers r, VOID entries s.

## Worked example (Stakes, cap binding)

s = 1 USDC = 1,000,000; fees 500 + 100 bps; capMultiple 10; minEntrants 1. One entrant picks option 0, eleven pick option 1, one entry is VOID.

| Step | Value |
| --- | --- |
| M = 0 (N = 1), L = 1 (N = 11), Lp = 11 · s | 11,000,000 |
| F = ⌊11,000,000 · 500 / 10000⌋ | 550,000 |
| C = ⌊11,000,000 · 100 / 10000⌋ | 110,000 |
| D = Lp − F − C | 10,340,000 |
| w = min(⌊10,340,000 / 1⌋, 10 · s) — the cap binds | 10,000,000 |
| R = D − 1 · w | 340,000 |
| r = ⌊340,000 / 11⌋ | 30,909 |
| dust = 340,000 − 11 · 30,909 | 1 |
| winner payout s + w | 11,000,000 |

Check: 11,000,000 + 11 · 30,909 + 1,000,000 (VOID) + 550,000 + 110,000 + 1 = 13,000,000 = 13 · s = `roundBalance`.

## Commands

```bash
pnpm typecheck && pnpm lint && pnpm test
FAST_CHECK_RUNS=10000 pnpm test -t property   # the CI property job
pnpm vectors                                  # regenerate vectors/ (deterministic, fixed seed)
```

See `vectors/README.md` for the vector formats.
