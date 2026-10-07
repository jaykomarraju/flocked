# Flocked contracts

Foundry project for the Stakes-mode escrow (`FlockedEscrow`). `FlockedAnchor` arrives in W2-B. The behaviour is
specified in `Product_Spec.md`, section "Smart contract"; the pinned interface is P1.3 in `docs/plan/wave-1.md`.

## Layout

| Path | What |
| --- | --- |
| `src/FlockedEscrow.sol` | The escrow |
| `src/interfaces/IFlockedEscrow.sol` | Spec interface verbatim, plus pinned views, timelock functions, events and errors |
| `src/lib/StakesMath.sol` | Stakes closed form (pure), mirrors the TypeScript `settleStakesClosedForm` |
| `test/Escrow.*.t.sol` | Unit tests by area (traceability CON-1..7, CON-10) |
| `test/fuzz/` | Fuzz `enter`, `propose`, `claim` and the closed form (CON-11) |
| `test/invariant/` | Handler + invariants: solvency, no settled-and-refunded round, exactly one guardian (CON-7, CON-8, CON-12) |
| `test/Vectors.t.sol` | Recorded closed-form vectors through `StakesMath` and a real `propose` |
| `test/fixtures/` | Hand-computed seed vectors and their arithmetic |
| `test/mocks/` | `MockUSDC` (6 decimals, EIP-2612, blocklist), a fee-on-transfer token |

## Build and test

Foundry 1.7.1. Dependencies come through Soldeer (`[dependencies]` in `foundry.toml`, pinned by `soldeer.lock`):
OpenZeppelin Contracts 5.7.0 and forge-std 1.17.0. `dependencies/` is gitignored; `remappings.txt` is committed.

```bash
cd contracts
forge soldeer install                       # once, and after a dependency change
forge fmt --check
forge build
forge test                                  # unit + fuzz (1,000 runs) + invariant (256 × 100)
FOUNDRY_PROFILE=ci forge test               # CI profile: fuzz 2,000 runs, invariant 512 × 200
forge coverage --report summary --no-match-coverage 'test/|dependencies/'
```

Foundry 1.7 has no `--profile` flag on `forge test`; select the profile with `FOUNDRY_PROFILE`.

## Constructor

```solidity
constructor(IERC20 usdc, address admin, address guardian, address operator, address pauser,
            address ticketSigner, address treasury, uint64 drandGenesis, uint64 drandPeriod)
```

| Param | Notes |
| --- | --- |
| `usdc` | The only accepted token (Base USDC in production) |
| `admin` | `DEFAULT_ADMIN_ROLE`, the admin multisig |
| `guardian` | `GUARDIAN_ROLE`, the guardian multisig and the role's only holder |
| `operator` | `OPERATOR_ROLE`, the backend key |
| `pauser` | `PAUSER_ROLE` |
| `ticketSigner` | May be zero (entries disabled until a signer is set through the timelock) |
| `treasury` | Credited with fees and dust at finalize |
| `drandGenesis`, `drandPeriod` | quicknet: 1692803367 and 3; a local drand network's values in tests |

Every address except `ticketSigner` must be non-zero, and both drand values must be non-zero.

EIP-712 domain: name `Flocked`, version `1`, `block.chainid`, verifying contract = the escrow. Ticket type
`EntryTicket(uint256 roundId,address wallet,bytes32 personTag,uint64 expiry)`, 65-byte ECDSA signatures.
`ticketDigest(ticket)` returns the digest to sign, which is also the `ticketHash` in `Entered`.

## Roles

| Role | Can | Granted by |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | schedule/execute/cancel timelocked changes; revoke `OPERATOR_ROLE` and `PAUSER_ROLE`; disable the ticket signer | admin |
| `OPERATOR_ROLE` | `createRound`, `propose`, `voidRound` (before close) | admin, only through the 72 h timelock |
| `GUARDIAN_ROLE` | `veto`, `voidRound` (before close), `transferGuardian` | exactly one holder: handed on by the guardian with `transferGuardian` (immediate), or replaced by the admin through the 7-day timelock |
| `PAUSER_ROLE` | `pause` (blocks `enter`/`enterWithPermit` only) | admin, immediately |

Only `DEFAULT_ADMIN_ROLE` can `unpause` (immediately), so a stolen pauser key can't undo a pause.
`grantRole(OPERATOR_ROLE, …)` reverts with `TimelockRequired`. `grantRole`, `revokeRole` and `renounceRole` revert with
`SingleGuardian` for `GUARDIAN_ROLE`, whoever calls them; `guardian()` returns the holder, and `transferGuardian` emits
`GuardianTransferred(previous, current)`.

## Timelocks

Each change is `schedule*` → wait → `execute*` (or `cancel*`), all `DEFAULT_ADMIN_ROLE`. Each emits
`TimelockScheduled` / `TimelockExecuted` / `TimelockCancelled` with the operation ID
`keccak256(abi.encode(action, abi.encode(params)))` (see `operationId`, `timelockReadyAt`).

| Change | Functions | Delay |
| --- | --- | --- |
| Ticket signer | `scheduleTicketSigner` / `executeTicketSigner` / `cancelTicketSigner` | 72 h |
| Treasury | `scheduleTreasury` / `executeTreasury` / `cancelTreasury` | 72 h |
| Operator grant | `scheduleOperatorGrant` / `executeOperatorGrant` / `cancelOperatorGrant` | 72 h |
| Rescue | `scheduleRescue` / `executeRescue` / `cancelRescue` (USDC only above `totalObligations`, checked at execution) | 72 h |
| Guardian replacement | `scheduleGuardianReplacement` / `executeGuardianReplacement` / `cancelGuardianReplacement` (a single write: revokes the one holder, whoever it is by then, and grants the new guardian; constant gas) | 7 days |

Immediate: `revokeRole` (operator, pauser), `setTicketSigner(address(0))`, `pause`, `unpause` (admin), `transferGuardian`
(guardian).

## Views used off-chain

`getRound(id)` (config, status, counters, proposal, derived amounts and claim counts), `beaconTime(r)`,
`ticketSigner()`, `treasury()`, `guardian()`, `hasEntered(id, account)`, `personTagUsed(id, tag)`, `hasClaimed(id, account)`,
`withdrawable(account)`, `roundCount()`, `totalObligations()`, `ticketDigest(ticket)`, `domainSeparator()`,
`operationId(action, data)`, `timelockReadyAt(id)`.

## The vector test

`test/Vectors.t.sol` reads the file at `VECTORS_PATH` (default `test/fixtures/stakes-closed-form.seed.json`, the P1.1
format), checks every `expected` field against `StakesMath.compute`, and runs every vector that fits the launch ceilings
(stake 1–100 USDC, ≤ 200 entrants) through `createRound` → `enter` → `propose` → `finalize`, checking the stored
amounts and the treasury and creator credits. W1-D points `VECTORS_PATH` at
`../packages/settle/vectors/stakes-closed-form.json` (already allowed by `fs_permissions`).
