# Flocked contracts

Foundry project for the Stakes-mode escrow (`FlockedEscrow`) and the Free-mode anchor (`FlockedAnchor`). The behaviour
is specified in `Product_Spec.md`, section "Smart contract"; the pinned interfaces are P1.3 in `docs/plan/wave-1.md`
(escrow) and P2.2 in `docs/plan/wave-2.md` (anchor, deploy script, ABIs).

## Layout

| Path | What |
| --- | --- |
| `src/FlockedEscrow.sol` | The escrow |
| `src/interfaces/IFlockedEscrow.sol` | Spec interface verbatim, plus pinned views, timelock functions, events and errors |
| `src/lib/StakesMath.sol` | Stakes closed form (pure), mirrors the TypeScript `settleStakesClosedForm` |
| `src/FlockedAnchor.sol` | Free-round anchors: lock leaf, commitment root, manifest hash; receipt signer |
| `src/interfaces/IFlockedAnchor.sol` | Spec interface verbatim, plus pinned views, timelock functions, events and errors |
| `script/Deploy.s.sol` | CREATE2 deploy of both contracts (and `MockUSDC` on anvil); writes `deployments/<chainId>.json` |
| `script/dry-run.sh` | Fresh anvil + `Deploy.s.sol --broadcast` + checks of the written JSON against the chain |
| `deployments/` | Deployment files (`84532.json`, `8453.json` committed; `31337.json` gitignored) |
| `test/Escrow.*.t.sol` | Unit tests by area (traceability CON-1..7, CON-10) |
| `test/fuzz/` | Fuzz `enter`, `propose`, `claim` and the closed form (CON-11) |
| `test/invariant/` | Handler + invariants: solvency, no settled-and-refunded round, exactly one guardian (CON-7, CON-8, CON-12) |
| `test/Vectors.t.sol` | Recorded closed-form vectors through `StakesMath` and a real `propose` |
| `test/fixtures/` | Hand-computed seed vectors and their arithmetic |
| `test/mocks/` | `MockUSDC` (6 decimals, EIP-2612, blocklist), a fee-on-transfer token |
| `test/Anchor*.t.sol` | Anchor unit, roles, receipts, fuzz, invariant (CON-9) and the deploy script |

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

## FlockedAnchor

```solidity
constructor(address admin, address anchorer, address receiptSigner, uint64 drandGenesis, uint64 drandPeriod)
```

`admin` and `anchorer` must be non-zero; a zero `receiptSigner` starts with receipts disabled. `roundKey(roundId, mode)`
is `keccak256(abi.encode(bytes16 roundId, uint8 mode))`. Each round key gets each kind written at most once:

| Kind | Function | Valid when |
| --- | --- | --- |
| Lock leaf | `lock` (batch) | not locked; `closesAt + 60 s <= beaconTime(beaconRound) <= closesAt + 10 min`; `now < closesAt` |
| Commitment | `commit` (batch) | not committed; locked; `closesAt <= now < beaconTime(beaconRound)` |
| Manifest | `anchorManifest` (single) | not anchored; locked; `now >= beaconTime(beaconRound)`; non-zero hash |

In a batch an invalid item emits `Skipped(roundKey, reason)` and the rest still apply: 1 already written, 2 not
locked, 3 outside its time window, 4 beacon bounds (checked in that order; `lock` checks 1, 4, 3). Arrays of different
lengths revert the whole call. `anchorManifest` is not a batch and reverts instead (`ManifestAlreadyAnchored`,
`NotLocked`, `BeaconNotReached`, `ZeroManifestHash`). `getAnchor(key)` returns everything stored, with the time each
kind was written (zero if not yet), so the AnchorDO can check a key before building or retrying a batch.

Roles: `ANCHOR_ROLE` grants go through `scheduleAnchorGrant` / `executeAnchorGrant` / `cancelAnchorGrant` (72 h;
`grantRole` reverts with `TimelockRequired`); `revokeRole` is immediate. The receipt signer changes through
`scheduleReceiptSigner` / `executeReceiptSigner` / `cancelReceiptSigner` (72 h), and `setReceiptSigner(address(0))`
disables receipts immediately. Every change emits `ReceiptSignerSet(signer, validFrom)`, starting at deployment.

Receipts: EIP-712 domain name `Flocked`, version `1`, `block.chainid`, verifying contract = the anchor. Type
`Receipt(bytes16 roundId,uint8 mode,bytes32 userIdHash,uint64 stake,bytes32 commitment,uint32 seq,uint64 closesAt,uint64 beaconRound)`.
`receiptDigest(receipt)` is the digest to sign; `verifyReceipt(receipt, sig)` checks it against the current signer.
`test/AnchorReceipt.t.sol` recovers a receipt signed with viem (`packages/abi/test/fixtures/receipt.json`).

## Deploying

`script/Deploy.s.sol` deploys through the deterministic CREATE2 factory (`0x4e59…956C`) with the salt
`keccak256("flocked.deploy.v1")`, so a configuration always lands at the same addresses and a re-run deploys nothing.
Env: `ADMIN`, `GUARDIAN`, `OPERATOR`, `PAUSER`, `TICKET_SIGNER`, `TREASURY`, `ANCHORER`, `RECEIPT_SIGNER`,
`DRAND_GENESIS`, `DRAND_PERIOD`, and `USDC` (on anvil, leave it unset to deploy `MockUSDC`). `DEPLOYMENTS_FILE`
overrides the output path. It writes `deployments/<chainId>.json` as `{ escrow, anchor, usdc, deployBlock }`, where
`deployBlock` is the block to start scanning events from.

```bash
bash script/dry-run.sh                      # fresh anvil, broadcast, check the JSON against the chain
forge script script/Deploy.s.sol --rpc-url <url> --broadcast --sender <addr> --account <keystore>
```

After a build, `node ../packages/abi/scripts/gen.mjs` regenerates `@flocked/abi` (ABIs and committed deployments).
