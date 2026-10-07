# Seed vectors: `stakes-closed-form.seed.json`

Hand-computed vectors in the P1.1 `stakes-closed-form` format (`docs/plan/wave-1.md`). Every numeric field is a
decimal string. `test/Vectors.t.sol` checks every `expected` field against `StakesMath`, and runs each vector that fits
the launch ceilings through a real `createRound` → `enter` × n → `propose` → `finalize` on a funded round.

W1-D points `VECTORS_PATH` at `../packages/settle/vectors/stakes-closed-form.json` (CON-13); this file stays as the
contract's own seed.

## Formulas (spec "Settlement and payout math", "Stakes closed form")

Refund first, in this order: reason 1 if n0 + n1 < minEntrants; reason 2 if n0 = 0 or n1 = 0; reason 3 if n0 = n1.
Otherwise M is the option with the smaller headcount (`winner` 0 or 1), N_M and N_L its and the other's headcounts, and

```
Lp = N_L·s      F = ⌊Lp·feeBps/10000⌋      C = ⌊Lp·creatorBps/10000⌋      D = Lp − F − C
w  = min(⌊D/N_M⌋, capMultiple·s)           R = D − N_M·w
r  = ⌊R/N_L⌋    dust = R − N_L·r
winPayout = s + w   rebatePayout = r   voidRefund = s   roundBalance = (n0 + n1 + nVoid)·s
```

Check (invariant): N_M·(s + w) + N_L·r + nVoid·s + F + C + dust = roundBalance.

For a refund, `status` = 3, `winner` = 255, and every money field is 0 except `voidRefund` (= s) and `roundBalance`.

## Vectors

| id | covers |
| --- | --- |
| cap-binding | cap binds, r > 0, dust 0 |
| cap-binding-rebate-dust-void | cap binds, r > 0, dust > 0, nVoid > 0, winner = option 1 |
| cap1-rebate-dust | capMultiple 1, r > 0, dust > 0, minEntrants 1 |
| refund-one-sided | reason 2, nVoid > 0 |
| refund-tie | reason 3 |
| refund-too-few | reason 1 at n0 + n1 = minEntrants − 1 |
| settle-basic | the P1.1 example, cap not binding, nVoid > 0 |
| stake-1-unit-void | stake = 1 base unit, fees round to 0, nVoid > 0 |
| stake-100-usdc-min-creator | stake 100 USDC, creatorBps 0, dust > 0 |
| zero-fees-min-entrants-exact | feeBps = creatorBps = 0, n0 + n1 = minEntrants |

### settle-basic — s = 5,000,000; 500/100 bps; cap 10; min 20; n0 = 30, n1 = 12, nVoid = 1

- 42 ≥ 20, both sides non-empty, no tie → settle. N_M = 12 (option 1, `winner` = 1), N_L = 30.
- Lp = 30 × 5,000,000 = 150,000,000. F = 150,000,000 × 500 / 10,000 = 7,500,000. C = 1,500,000.
- D = 150,000,000 − 7,500,000 − 1,500,000 = 141,000,000.
- ⌊D/12⌋ = 11,750,000; cap = 50,000,000 → w = 11,750,000. R = 141,000,000 − 12 × 11,750,000 = 0. r = 0, dust = 0.
- winPayout = 16,750,000. roundBalance = 43 × 5,000,000 = 215,000,000.
- Check: 12 × 16,750,000 + 0 + 5,000,000 + 7,500,000 + 1,500,000 + 0 = 215,000,000 ✓

### refund-too-few — s = 1,000,000; min 20; n0 = 10, n1 = 9, nVoid = 0

- 19 < 20 → reason 1. roundBalance = 19,000,000; voidRefund = 1,000,000.

### refund-one-sided — s = 2,000,000; min 20; n0 = 25, n1 = 0, nVoid = 2

- 25 ≥ 20; n1 = 0 → reason 2. roundBalance = 27 × 2,000,000 = 54,000,000; voidRefund = 2,000,000.

### refund-tie — s = 3,000,000; min 20; n0 = 15, n1 = 15, nVoid = 0

- 30 ≥ 20, both non-empty, n0 = n1 → reason 3. roundBalance = 90,000,000; voidRefund = 3,000,000.

### cap-binding — s = 1,000,000; 500/100; cap 10; min 20; n0 = 2, n1 = 40, nVoid = 0

- N_M = 2 (option 0), N_L = 40. Lp = 40,000,000. F = 2,000,000. C = 400,000. D = 37,600,000.
- ⌊D/2⌋ = 18,800,000 > cap 10,000,000 → w = 10,000,000. R = 37,600,000 − 20,000,000 = 17,600,000.
- r = ⌊17,600,000 / 40⌋ = 440,000; dust = 0. winPayout = 11,000,000. roundBalance = 42,000,000.
- Check: 2 × 11,000,000 + 40 × 440,000 + 2,000,000 + 400,000 = 22,000,000 + 17,600,000 + 2,400,000 = 42,000,000 ✓

### cap1-rebate-dust — s = 1,000,000; 500/100; cap 1; min 1; n0 = 3, n1 = 7, nVoid = 0

- N_M = 3 (option 0), N_L = 7. Lp = 7,000,000. F = 350,000. C = 70,000. D = 6,580,000.
- ⌊D/3⌋ = 2,193,333 > cap 1,000,000 → w = 1,000,000. R = 6,580,000 − 3,000,000 = 3,580,000.
- r = ⌊3,580,000 / 7⌋ = 511,428 (7 × 511,428 = 3,579,996); dust = 4. winPayout = 2,000,000. roundBalance = 10,000,000.
- Check: 6,000,000 + 3,579,996 + 350,000 + 70,000 + 4 = 10,000,000 ✓

### stake-1-unit-void — s = 1; 500/100; cap 10; min 20; n0 = 13, n1 = 11, nVoid = 3

- 24 ≥ 20 → settle. N_M = 11 (option 1), N_L = 13. Lp = 13. F = ⌊6,500/10,000⌋ = 0. C = ⌊1,300/10,000⌋ = 0. D = 13.
- ⌊13/11⌋ = 1 ≤ cap 10 → w = 1. R = 13 − 11 = 2. r = ⌊2/13⌋ = 0; dust = 2. winPayout = 2. roundBalance = 27.
- Check: 11 × 2 + 0 + 3 × 1 + 0 + 0 + 2 = 27 ✓

### stake-100-usdc-min-creator — s = 100,000,000; 500/0; cap 10; min 20; n0 = 7, n1 = 19, nVoid = 2

- N_M = 7 (option 0), N_L = 19. Lp = 1,900,000,000. F = 95,000,000. C = 0. D = 1,805,000,000.
- ⌊D/7⌋ = 257,857,142 ≤ cap 1,000,000,000 → w = 257,857,142. R = 1,805,000,000 − 1,804,999,994 = 6.
- r = ⌊6/19⌋ = 0; dust = 6. winPayout = 357,857,142. roundBalance = 28 × 100,000,000 = 2,800,000,000.
- Check: 7 × 357,857,142 + 2 × 100,000,000 + 95,000,000 + 6 = 2,504,999,994 + 200,000,000 + 95,000,006 = 2,800,000,000 ✓

### zero-fees-min-entrants-exact — s = 1,000,000; 0/0; cap 10; min 20; n0 = 11, n1 = 9, nVoid = 0

- 20 = minEntrants → settle. N_M = 9 (option 1), N_L = 11. Lp = 11,000,000. F = C = 0. D = 11,000,000.
- ⌊D/9⌋ = 1,222,222 → w = 1,222,222. R = 11,000,000 − 10,999,998 = 2. r = 0; dust = 2.
- winPayout = 2,222,222. roundBalance = 20,000,000. Check: 9 × 2,222,222 + 2 = 20,000,000 ✓

### cap-binding-rebate-dust-void — s = 2,000,000; 500/100; cap 10; min 20; n0 = 47, n1 = 3, nVoid = 1

- N_M = 3 (option 1), N_L = 47. Lp = 94,000,000. F = 4,700,000. C = 940,000. D = 88,360,000.
- ⌊D/3⌋ = 29,453,333 > cap 20,000,000 → w = 20,000,000. R = 88,360,000 − 60,000,000 = 28,360,000.
- r = ⌊28,360,000 / 47⌋ = 603,404 (47 × 603,404 = 28,359,988); dust = 12. winPayout = 22,000,000.
- roundBalance = 51 × 2,000,000 = 102,000,000.
- Check: 66,000,000 + 28,359,988 + 2,000,000 + 4,700,000 + 940,000 + 12 = 102,000,000 ✓
