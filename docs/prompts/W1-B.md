# Session W1-B: `FlockedEscrow`

**Role:** build. **Size:** M (split into `W1-B.2` if needed: escrow core + unit tests first, fuzz + invariants second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4.2 (Toolchain). Read nothing else in `plan.md`.
- `docs/plan/wave-1.md`: the intro, "Pinned interfaces" P1.1, P1.3 and P1.4, and section "W1-B".
- There is no earlier wave summary (wave 1).
- Spec sections (no `pnpm spec` yet; use `awk '/^## <heading>$/{p=1;print;next} /^## /{p=0} p' Product_Spec.md` and read only the parts named):
  - "Smart contract": everything before "**Contract: `FlockedAnchor`**", then "**Challenge window, watcher and guardian**" and "**Gas and UX**"
  - "Settlement and payout math": "**Definitions**", "**Refund rules**", "**Normal case**", "**Stakes closed form**", "**Invariant**"
  - "Identity and personhood": "**Entry tickets (Stakes)**" only
  - "Testing and acceptance criteria": the "Contract tests (Foundry)" bullet only
  - "Out of scope, launch gates and decision log": the Decision log row about EIP-712 chain IDs

## Objective
Implement `FlockedEscrow` exactly to the spec in a standalone Foundry project under `contracts/`, with unit, fuzz and invariant tests covering every Required contract test, and a hand-computed seed vector file in the pinned P1.1 format that `Vectors.t.sol` checks against `StakesMath`. W1-D will later point that test at `@flocked/settle`'s generated vectors.

## Starting point
- Base: tag `wave-0`. Branch: `w1-b-escrow`. Worktree: `../flocked-w1-b`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w1-b -b w1-b-escrow wave-0
  cd ../flocked-w1-b
  ```
- There is no pnpm workspace in this wave. Work only with Foundry (installed: forge/anvil 1.7.1).

## Scope and file ownership
- May create or edit: `contracts/**` (Escrow only; `FlockedAnchor` is W2-B), `docs/sessions/W1-B.md`.
- Must not touch: any root file, `packages/`, `apps/`, the spec, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P1.3 in `docs/plan/wave-1.md`: file paths, constructor signature, EIP-712 name/version/typehash (chain ID from `block.chainid`), enum values, refund reason codes, claim leaf encoding, named views, built-in timelocks (72 h; guardian 7 d; immediate revocation, signer disable and pause), custom errors, NatSpec, `MockUSDC` with EIP-2612.
- P1.1 `stakes-closed-form` format for `contracts/test/fixtures/stakes-closed-form.seed.json` (all numeric fields are decimal strings).
- P1.4: `foundry.toml` settings, `fs_permissions`, fuzz/invariant runs, the `ci` profile, Soldeer dependencies (OpenZeppelin Contracts 5.x), `dependencies/` gitignored and `soldeer.lock` committed.

## Tasks
1. Create the worktree; `forge init --no-git contracts` (or create the layout by hand); configure `foundry.toml` per P1.4; `forge soldeer install` OpenZeppelin Contracts 5.x (and forge-std); add `contracts/.gitignore`.
2. `src/interfaces/IFlockedEscrow.sol` (spec interface verbatim, plus the pinned views and timelock functions), `src/lib/StakesMath.sol` (closed form: winner, F, C, D, w, R, r, dust, refund classification for rules 1–3), and `src/FlockedEscrow.sol`.
3. Implement every rule in the spec's "Rules the contract enforces": `createRound` (counter IDs and all validations and ceilings), `voidRound`, `enter`/`enterWithPermit` (ticket checks, 64–2,048-byte ciphertext, per-address and per-`personTag` dedupe, exact stake pull, `Entered` with the full ciphertext), `refundTooFew`, `propose` (refund vs settle proposals, `payoutRoot` zero for refunds, `claimsOpenAt`), `veto` (both directions), `finalize` (credits fee + dust to treasury, creator fee to creator), `refundTimeout`, `claim` (leaf, entered, one per address, per-kind count caps N_M, N_L, nVoid; finalize-if-needed), `claimRefund`, `withdraw` (pull), pause (blocks `enter` only), roles and timelocks, rescue above obligations only.
4. Tests (paths from `docs/plan/traceability.md` rows CON-1..8, CON-10..12): unit tests per area; fuzz `enter`, `propose`, `claim`; an invariant suite with a handler covering enter, propose, veto, finalize, claim, claimRefund, void, refundTooFew, refundTimeout, withdraw and `vm.warp`, asserting (a) USDC held ≥ the sum of outstanding obligations and (b) no round is ever both settled and refunded (status history ghost variables). Include a "creator cannot receive USDC" case (a blocklisting mock token or a creator contract that reverts on receive) for `withdraw`; and a ticket signed for one escrow reverting on a second escrow (CON-10).
5. Seed vectors: ≥ 8 hand-computed cases in `test/fixtures/stakes-closed-form.seed.json` (cover a settle, each refund reason 1–3, a cap-binding case, an r > 0 case, nVoid > 0, stake = 1 base unit), with the arithmetic in `test/fixtures/README.md`. `test/Vectors.t.sol` loops over the file (path in constant `VECTORS_PATH`) and checks every expected field against `StakesMath`, and runs at least two vectors through a real `propose` on a funded round.
6. `contracts/README.md`: build/test commands, roles, timelocks, constructor params, the vector test.
7. `forge fmt`, `forge build`, `forge test`, `forge test --profile ci`, `forge coverage --report summary`.

## Tests and checks
- `cd contracts && forge fmt --check && forge test && forge test --profile ci` all pass.
- `forge coverage` ≥ 95% lines on `FlockedEscrow.sol` and `StakesMath.sol` (report the numbers).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations.

## Definition of done
- Traceability rows CON-1..8 and CON-10..12 each have a named, passing test, listed in the handoff.
- The seed vectors pass through `StakesMath` and through `propose`.

## Constraints
- Follow the spec exactly. Where it's ambiguous (see "Open questions" in your wave-file section), choose the safest reading, implement it, and record it under Spec issues.
- No secrets. Tests generate their own keys (`vm.addr`, `vm.sign`).
- Stage files by name. Commits end with the attribution line from your system reminder.
- Running low on context: stop at a green commit, write the handoff as `partial`, and emit `W1-B.2` (save to `docs/prompts/W1-B.2.md`).

## End of session
1. Commit and `git push -u origin w1-b-escrow`.
2. Write `docs/sessions/W1-B.md` from plan.md 3.2. In "Notes for D and Z", give the exact `forge` commands CI needs, the Soldeer install step, the Foundry version, and every view/function name W2+ will call (confirm or amend P1.3). Commit and push.
3. End with your status line and: "When W1-A, B and C all report complete, start W1-D from `docs/prompts/W1-D.md`."
