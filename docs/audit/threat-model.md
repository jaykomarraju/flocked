# Threat model

The trust model, residual risks and known issues for `FlockedEscrow` and `FlockedAnchor`. The behaviour is in
`Product_Spec.md`, section "Smart contract"; owner decisions are in its Decision log (the Oct 7 and Oct 8, 2026 rows
on the escrow and `FlockedAnchor`). Everything here describes the audit commit in [package.md](package.md).

## Assets

- **Entrants' USDC** in `FlockedEscrow`. Every unit belongs to one round (`roundBalance`) until it is claimed, or until
  it is credited as a fee and withdrawn. `totalObligations` is the running total of everything owed.
- **Integrity of outcomes.** Who wins and how much is fixed by the posted tally and the closed form, and is final only
  after the challenge window.
- **Free-round anchors** in `FlockedAnchor`: write-once lock leaves, commitment roots and manifest hashes. These are
  what make a Free round's sealed picks and results verifiable.
- **Receipt and ticket signer identity**: which keys the client and the escrow trust.

## Trust model

| Actor | Holds | Trusted for | Can't |
| --- | --- | --- | --- |
| Admin multisig | `DEFAULT_ADMIN_ROLE` on both contracts | Scheduling, executing and cancelling timelocked changes. Immediate revocations. Disabling the ticket or receipt signer. Unpause | Move entrants' USDC (rescue covers only the surplus above `totalObligations`). Grant `OPERATOR_ROLE` or `ANCHOR_ROLE`, or set a signer, without 72 h of public notice. Replace the guardian without 7 days. Touch `GUARDIAN_ROLE` through `grantRole`/`revokeRole` |
| Guardian multisig | `GUARDIAN_ROLE` (exactly one holder) | `veto` before `claimsOpenAt`. `voidRound` before close. Handing the role on with `transferGuardian` | Move money anywhere. A veto or a void only refunds |
| Operator (backend key) | `OPERATOR_ROLE` | `createRound` within the launch ceilings. `propose` a tally. `voidRound` before close | Pay anyone but the round's entrants, the frozen creator and the treasury. Exceed the posted tally per kind. Finalize early |
| Pauser | `PAUSER_ROLE` | `pause` (blocks `enter` and `enterWithPermit` only) | Unpause. Block proposals, vetoes, claims, refunds or withdrawals |
| Ticket signer | EIP-712 key | Who may enter a Stakes round (geo, age, self-exclusion and caps are enforced off-chain) | Enter for a wallet without that wallet's transaction. Enter twice per wallet or per person tag |
| AnchorDO key | `ANCHOR_ROLE` | Writing Free lock leaves, commitments and manifests on time | Overwrite anything. Write outside the time windows |
| Receipt signer | EIP-712 key (in `apps/signer` for Stakes tickets; the anchor's `receiptSigner` for Free receipts) | Signing entry receipts the client checks | Anything on-chain beyond `verifyReceipt` returning true |
| Treasury and creators | Addresses credited at finalize | Withdrawing their own balance | Withdraw to another address (no `withdrawTo`, Decision log Oct 7) |
| Watcher (off-chain, separate account) | None on-chain | Publishing a verdict on every proposal, void, lock, commitment and manifest. Paging the guardian | Anything on-chain |
| drand quicknet | n/a | Publishing round `beaconRound` at `GENESIS + (r − 1) × PERIOD` | Not checked on-chain: `propose` only waits for the beacon time. If the beacon is missing, Free refunds under rule 8 and Stakes times out (reason 6) |
| Circle (USDC) | Token admin | An honest 6-decimal ERC-20 with EIP-2612 permit | See K-1 and K-2: Circle can freeze addresses or the escrow, or pause USDC |
| Base sequencer | Block production | Timestamps within seconds, and liveness | See R-8 (a halt at close) |

**Upgrades.** There is no proxy. A fix means redeploying and migrating, and both contracts are deployed through the
CREATE2 factory, so an unchanged configuration lands at the same address on every chain.

## Residual risks (from the spec)

The spec's "Residual risk" list, accepted by the owner. Each one ends in delay or refunds, never in a loss of funds.

| ID | Risk | Bound and response |
| --- | --- | --- |
| R-1 | **Never proposing.** A malicious operator never proposes | The round ends in the 72 h timeout refund (reason 6). Slow, public, and money goes only to the entrants |
| R-2 | **Deliberately wrong proposal.** An operator who has seen the result proposes a wrong settlement the guardian must veto | A full refund within about 2 h. The wrong tally proves operator fault publicly. The guardian charter treats it as a key compromise: revoke `OPERATOR_ROLE` |
| R-3 | **False veto.** The guardian vetoes a correct settlement | A full refund. The guardian charter covers conflicts of interest, and the watcher alerts on a veto that doesn't match a mismatch it reported |
| R-4 | **Key compromise (operator or guardian).** Griefing as in R-1 to R-3 | Revoke the role (immediate), pause entries, rotate keys (the guardian through its 7-day timelock), and redeploy and migrate if needed |
| R-5 | **Stolen ticket signer.** Tickets that skip geo, age, self-exclusion and caps | Each shows up as a foreign entry (an `Entered` with no ticket record). Pause and disable the signer, both immediate. The round's settlement waits for the guardian |
| R-6 | **Fake people.** The operator, as ticket issuer, mints tickets for fake people | With a fixed stake, extra heads lose about 6% of their stake in fees, so this can't buy an outcome at a profit. It shows only in operator records |
| R-7 | **Stolen anchor key.** Pre-empting `lock` (a Free round denial of service; the round is re-keyed before `opensAt`) or `anchorManifest` (the bundle can't be verified) | `ANCHOR_ROLE` grants go through the timelock and revocation is immediate. `@flocked/verify` reports each anchor's sender and marks anchors from a later-revoked key as disputed |
| R-8 | **Base halt at close.** If Base stalls past the beacon delay, catch-up blocks could include Stakes entries made after the picks became readable | Accepted (Decision log, Oct 7). Base halts are rare, about one of 33 minutes in Aug 2025. The beacon delay is at least 60 s (2 min by default) |

## Known issues

These are found or confirmed in audit prep (W4-C). None is a contract change; each is either accepted behaviour or an
off-chain responsibility. The ones that aren't in the spec's residual-risk list are recorded as spec issues in
`docs/sessions/W4-C.md` for the owner.

| ID | Issue | Status |
| --- | --- | --- |
| K-1 | **USDC blocklist.** If Circle blocklists an entrant, that entrant's `claim` or `claimRefund` reverts until it is lifted. The amount stays in `totalObligations`, so it can't be rescued, and there is no `withdrawTo`. The same applies to a credited treasury or creator (spec). If Circle blocklists the escrow itself, every transfer stops | Accepted. Funds are frozen, not lost, and the escrow can do nothing about Circle's admin powers. Not in the spec's list for entrants: spec issue 2 |
| K-2 | **USDC pause or upgrade.** A USDC pause halts entries and claims until it ends. A fee-on-transfer upgrade makes `enter` revert `StakeTransferMismatch` (fails safe) | Accepted (issuer risk) |
| K-3 | **A wrong payout tree with a right tally.** The contract caps claims per kind at N_M, N_L and nVoid, and only entrants can claim, so a round can never pay out more than it holds (invariants below). It can't check that the leaves name the right entrants. A root that gives some winners' leaves to losers lets the first N_M claimers of a kind be paid, which can be the wrong people | The guardian veto (R-2): the watcher recomputes the leaves from the bundle. Spec issue 1 asks to name this case in the residual-risk list |
| K-4 | **Front-run permit.** `enterWithPermit` ignores a failing `permit` (it may have been front-run), so the entry needs an existing allowance | By design (interface NatSpec). A front-runner only spends the user's own permit on the user's own allowance |
| K-5 | **A vetoed refund proposal can repeat.** A veto of a RefundProposed round returns it to Open, so the operator can propose again | Bounded: `propose` closes at `closesAt + REFUND_TIMEOUT` and `refundTimeout` takes over. At most about 74 h of delay, then a refund |
| K-6 | **`getRoleAdmin(GUARDIAN_ROLE)` is `DEFAULT_ADMIN_ROLE`.** Since W4-C removed the dead `_setRoleAdmin(GUARDIAN_ROLE, GUARDIAN_ROLE)`, the view names the admin role, but that gives the admin nothing: `grantRole`, `revokeRole` and `renounceRole` revert `SingleGuardian` for it, whoever calls | Documented. The only paths are `transferGuardian` and the 7-day replacement |
| K-7 | **The treasury moves while fees are credited.** Fees go to `treasury` as it is at finalize. A former treasury keeps its credited balance and withdraws it itself | By design (pull pattern, no `withdrawTo`) |
| K-8 | **Anchor payloads are opaque.** `FlockedAnchor` doesn't check `questionHash`, `configHash`, `commitmentRoot`, `entryCount` or `totalStake` (a zero root is still "written"). It enforces only write-once and the time order | By design. `@flocked/verify` and the watcher check the contents against the bundle |
| K-9 | **A skipped commitment refunds the Free mode.** If a commitment misses its window (a late batch, or a pre-empted key), it is skipped (reason 3) and can never be written. The mode refunds, and its manifest can still be anchored, since a manifest needs a lock but not a commitment | By design (spec). The AnchorDO checks each key's state before building or retrying a batch |
| K-10 | **CREATE2 squatting.** Anyone can deploy the same init code through the factory, but only to the same address with the same constructor arguments and roles. The deploy script then sees code there and treats it as deployed | Harmless. Before trusting an address, check the deployed configuration (roles, signers, drand values) |
| K-11 | **drand parameters are immutable.** `GENESIS` and `PERIOD` are constructor values. If quicknet changed, you'd redeploy | Accepted (spec, "Constants") |

## Invariants the tests hold

Each property below is checked by a Foundry invariant (CON-7, CON-8, CON-9, CON-12, plus the W4-C extensions). The
file list and run counts are in [package.md](package.md#tests).

- **Solvency (CON-12):** the escrow's USDC balance ≥ the obligations computed from round state, and
  `totalObligations` equals them exactly.
- **Per-round conservation** (spec "Settlement and payout math", Invariant): paid out + fees credited + still owed =
  `roundBalance` = `entryCount × stake`, for every round, from the events. Every settle proposal's amounts satisfy
  Σ payouts + F + C + dust = T + V, vetoed ones included. Credited fees are either still withdrawable or were
  withdrawn.
- **Claim exclusivity:** each account claims at most once per round (a payout or a refund, never both), only entrants
  claim, `hasClaimed` matches the events, and the per-kind event counts match the counters. Probes check three things:
  a settled round pays no refunds, a refunded round pays no payouts, and a non-entrant's leaf in an over-generous tree
  never pays.
- **State machine (CON-8):** no round is both settled and refunded, and every transition is one the spec allows.
- **Single guardian (CON-7):** `GUARDIAN_ROLE` always has exactly one holder, the one last handed it.
- **Anchor write-once (CON-9):** each key is written at most once per kind, the first write is never changed, and
  every write event matches what was stored.
- **Anchor time order:** lock < `closesAt` ≤ commit < beacon time ≤ manifest. A commit or manifest needs a lock. The
  beacon is within its bounds.
- **Anchor timelocks:** no grant or signer change takes effect before 72 h. The receipt signer and the `ANCHOR_ROLE`
  holders match the schedule, execute, cancel and revoke history. `timelockReadyAt` is exactly 72 h after
  scheduling. The `ReceiptSignerSet` history is in order and stamped with block time. Direct grants and direct signer
  sets revert.
