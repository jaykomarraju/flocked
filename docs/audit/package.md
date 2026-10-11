# Flocked contracts: audit package

Flocked is a daily minority game: one question, two options, and picks sealed with timelock encryption (drand
quicknet) until a shared reveal. The side fewer people picked wins. Stakes mode escrows USDC on Base in
`FlockedEscrow`. Free mode is for points, and `FlockedAnchor` holds its write-once commitments.

## Commit to audit

| | |
| --- | --- |
| Repository | `github.com/jaykomarraju/flocked` (public) |
| Commit | `36d115cc37e624730d76a65db28945db2dcf1326` (branch `w4-c-audit-prep`; the last commit that changes `contracts/`) |
| Tag | `audit-candidate-1` (made by W4-Z at merge; `git diff 36d115c audit-candidate-1 -- contracts/src` is empty) |
| Compiler | solc 0.8.30, optimizer on (200 runs), `via_ir = false`, `evm_version = "cancun"` |
| Dependencies | OpenZeppelin Contracts 5.7.0, forge-std 1.17.0 (tests only), pinned by `contracts/soldeer.lock` |

## Scope

| File | nSLOC | sha256 at the audit commit |
| --- | --- | --- |
| `contracts/src/FlockedEscrow.sol` | 484 | `3b4cebe059101152ca17d9b45a0046ecc4ce0bbfe3e09ba56222a27c2c4b14fa` |
| `contracts/src/FlockedAnchor.sol` | 207 | `023f968a2a6034acefe9224ed4545fcb0d7b61bc6ec18f61ba40d410abb4b309` |
| `contracts/src/lib/StakesMath.sol` | 68 | `a7726d61a86f70d77ad84365144356358d30a234089a24dcaaeb42ae7d07cb64` |
| `contracts/src/interfaces/IFlockedEscrow.sol` | 188 | `fc78716a02cf1f5915fe335246d2e8d036887026d6ebc62721d9e98cce10f832` |
| `contracts/src/interfaces/IFlockedAnchor.sol` | 78 | `ab2695924075463b9d5a95b9b3adee91a81ccdc82ca5db4506fb1e80e45e9fc2` |
| **Total** | **1,025** | (nSLOC as aderyn counts it) |

OpenZeppelin modules used, all unmodified:

- `AccessControlEnumerable` (escrow) and `AccessControl` (anchor);
- `Pausable`, `ReentrancyGuard`;
- `EIP712`, `ECDSA`, `MerkleProof`;
- `SafeERC20` / `IERC20Permit`.

**Out of scope, but useful context:**

- `contracts/script/Deploy.s.sol`: the CREATE2 deploy (salt `keccak256("flocked.deploy.v1")`) and `dry-run.sh`;
- `contracts/test/**`: tests, mocks and fixtures;
- the off-chain system: the API Worker, the AnchorDO, the ticket signer and the watcher.

The behaviour is specified in `Product_Spec.md`, section "Smart contract". Read that section and the Decision log
rows dated Oct 7 and 8, 2026 (single guardian, admin-only unpause, no `withdrawTo`, `FlockedAnchor` as built,
foreign entries). The rounding rules are in "Settlement and payout math": "Stakes closed form" and "Invariant".

## Architecture

### `FlockedEscrow` (Stakes)

One contract holds every Stakes round's USDC with per-round accounting. Round IDs come from a counter (1, 2, 3, …).
A round's config is frozen at `createRound`: open and close times, the drand `beaconRound`, a fixed `stake`, fee and
creator basis points, the cap multiple, `minEntrants`, the creator and the `questionHash`.

```
createRound ─▶ Open ──propose (refund tally)──▶ RefundProposed ──finalize (≥ claimsOpenAt)──▶ Refunded
                │  ╰─propose (settle tally)──▶ SettleProposed ──finalize──▶ Settled
                │        veto (< claimsOpenAt): SettleProposed ─▶ Refunded (5); RefundProposed ─▶ Open
                ╰─ voidRound (< closesAt, 4) · refundTooFew (≥ closesAt, < minEntrants, 1) · refundTimeout (≥ closesAt + 72 h, 6) ─▶ Refunded
```

- **`enter` / `enterWithPermit`.**
  - An entry needs an EIP-712 `EntryTicket(roundId, wallet, personTag, expiry)` from the current ticket signer.
  - There is one entry per wallet and one per person tag per round.
  - The tlock ciphertext (64–2,048 bytes) is emitted in full.
  - The escrow pulls exactly `stake`, checking that its balance rose by exactly that much.
- **`propose`** posts `(n0, n1, nVoid, payoutRoot, bundleHash)` after beacon time.
  - A refund tally (reasons 1–3, checked in that order) becomes RefundProposed, with a zero root.
  - Otherwise the contract derives the winner and every amount with `StakesMath.compute`, and stores them.
  - Either way it sets `claimsOpenAt = now + 2 h`. No USDC moves until finalize.
- **`claim`** is for a Settled round. The leaf is OpenZeppelin StandardMerkleTree's
  `keccak256(bytes.concat(keccak256(abi.encode(roundId, account, uint8 kind))))`, where the kind is Win (s + w),
  Rebate (r) or VoidRefund (s). It allows one claim per address and caps the claims of each kind at N_M, N_L and nVoid.
- **`claimRefund`** is for a Refunded round: each entrant gets their stake back once, whatever the reason.
  `claim` and `claimRefund` both finalize a due proposal first.
- **Fees** are credited at finalize: fee plus dust to the treasury, the creator fee to the creator. Each pulls its
  own with `withdraw` (pull pattern).
- **Accounting.** `totalObligations` rises by `stake` on entry and falls on every claim, refund or withdrawal. The
  admin's `rescue` can take only USDC above it, or tokens other than USDC.

### `StakesMath`

It is pure, and mirrors `settleStakesClosedForm` in `@flocked/settle`, which is checked against shared vectors.
Lp = N_L·s, F = ⌊Lp·feeBps/10⁴⌋ and C = ⌊Lp·creatorBps/10⁴⌋, so D = Lp − F − C. Then:

- w = min(⌊D/N_M⌋, capMultiple·s);
- R = D − N_M·w, with r = ⌊R/N_L⌋ and dust = R − N_L·r.

M is the smaller side. A tie, a one-sided split or too few valid entries refunds instead.

### `FlockedAnchor` (Free)

It holds one record per `roundKey = keccak256(abi.encode(bytes16 roundId, uint8 mode))`, and writes each kind at most
once:

- **lock leaf** (`lock`, batch): before `closesAt`, with the beacon 60 s–10 min after close;
- **commitment** (`commit`, batch): in `[closesAt, beaconTime)`, after a lock;
- **manifest** (`anchorManifest`, single): at or after beacon time, after a lock (no commitment needed).

Invalid batch items emit `Skipped(key, reason)` and the rest still apply. `anchorManifest` reverts instead.

The anchor also publishes the Free receipt signer. A new signer goes through a 72 h timelock; disabling it is
immediate. `verifyReceipt` checks a `Receipt` against the current signer, and `ReceiptSignerSet` events carry the
signer's history.

### EIP-712 domains

Both contracts use name `Flocked`, version `1`, `block.chainid`, and the contract itself as the verifying contract. On
Base Sepolia that chain ID is 84532, and on Base 8453.

- Escrow type: `EntryTicket(uint256 roundId,address wallet,bytes32 personTag,uint64 expiry)`.
- Anchor type: `Receipt(bytes16 roundId,uint8 mode,bytes32 userIdHash,uint64 stake,bytes32 commitment,uint32 seq,uint64 closesAt,uint64 beaconRound)`.

## Roles and timelocks

| Role | Contract | Can | Granted |
| --- | --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` (admin multisig) | both | Schedule, execute and cancel the changes below. Revoke operator, pauser and anchorer. Disable a signer. `unpause` | constructor |
| `OPERATOR_ROLE` (backend key) | escrow | `createRound`, `propose`, `voidRound` before close | only `scheduleOperatorGrant` → 72 h → `executeOperatorGrant` (`grantRole` reverts `TimelockRequired`) |
| `GUARDIAN_ROLE` (guardian multisig, one holder) | escrow | `veto` before `claimsOpenAt`, `voidRound` before close, `transferGuardian` | `transferGuardian` (immediate, by the guardian), or `scheduleGuardianReplacement` → 7 days → `executeGuardianReplacement` (by the admin; a single write that replaces whoever holds it then). `grantRole`, `revokeRole` and `renounceRole` revert `SingleGuardian` |
| `PAUSER_ROLE` | escrow | `pause` (entries only) | `grantRole`, immediate |
| `ANCHOR_ROLE` (AnchorDO key) | anchor | `lock`, `commit`, `anchorManifest` | only `scheduleAnchorGrant` → 72 h → `executeAnchorGrant` |

| Timelocked change | Delay | Functions |
| --- | --- | --- |
| Escrow ticket signer | 72 h | `scheduleTicketSigner` / `executeTicketSigner` / `cancelTicketSigner` (`setTicketSigner(0)` is immediate) |
| Escrow treasury | 72 h | `scheduleTreasury` / `executeTreasury` / `cancelTreasury` |
| `OPERATOR_ROLE` grant | 72 h | `scheduleOperatorGrant` / `executeOperatorGrant` / `cancelOperatorGrant` |
| Rescue (USDC only above obligations, checked at execution) | 72 h | `scheduleRescue` / `executeRescue` / `cancelRescue` |
| Guardian replacement | 7 days | `scheduleGuardianReplacement` / `executeGuardianReplacement` / `cancelGuardianReplacement` |
| Anchor receipt signer | 72 h | `scheduleReceiptSigner` / `executeReceiptSigner` / `cancelReceiptSigner` (`setReceiptSigner(0)` is immediate) |
| `ANCHOR_ROLE` grant | 72 h | `scheduleAnchorGrant` / `executeAnchorGrant` / `cancelAnchorGrant` |

- Each operation's ID is `keccak256(abi.encode(action, abi.encode(params)))`.
- Scheduled operations don't expire.
- Only `DEFAULT_ADMIN_ROLE` executes or cancels.
- Every step emits `TimelockScheduled`, `TimelockExecuted` or `TimelockCancelled`.

These take effect immediately:

- `revokeRole` (operator, pauser, anchorer);
- disabling either signer;
- `pause` (pauser) and `unpause` (admin only);
- `transferGuardian`.

The trust model and residual risks are in [threat-model.md](threat-model.md), and the static analysis triage is in
[static-analysis.md](static-analysis.md).

## Tests

```bash
git clone https://github.com/jaykomarraju/flocked && cd flocked && git checkout 36d115c
cd contracts
forge soldeer install                         # OpenZeppelin 5.7.0, forge-std 1.17.0
forge build
forge test                                    # unit + fuzz (1,000 runs) + invariant (256 runs × 100 calls)
FOUNDRY_PROFILE=ci forge test                 # fuzz 2,000 runs, invariant 512 × 200
forge coverage --report summary --no-match-coverage 'test/|dependencies/|script/'
node tools/check-natspec.mjs                  # after forge build: NatSpec on every external function and event
slither . --fail-medium && aderyn .           # static analysis (versions in static-analysis.md)
```

Foundry 1.7.1 is required. Foundry 1.7 has no `--profile` flag, so the profile is selected with `FOUNDRY_PROFILE`.
`Vectors.t.sol` and `MerkleVectors.t.sol` read fixtures from `../packages/*` (allowed by `fs_permissions`), so run
from a full checkout.

| Suite | What it proves |
| --- | --- |
| `Escrow.*.t.sol` | Unit tests by area: create, enter, propose, challenge and veto, claims, refunds, roles and timelocks, reverts |
| `fuzz/*.t.sol` | `enter`, `propose`, `claim` and the closed form under random inputs |
| `Vectors.t.sol` | Closed-form vectors shared with `@flocked/settle`, run through `StakesMath` and through a real `createRound` → `enter` → `propose` → `finalize` |
| `MerkleVectors.t.sol`, `SharedEip712.t.sol`, `AnchorReceipt.t.sol` | Merkle leaves, EIP-712 digests and receipts that match the TypeScript (viem, `@openzeppelin/merkle-tree`) |
| `invariant/EscrowInvariant.t.sol` | Solvency, `totalObligations`, per-round conservation, claim exclusivity, claims within tally, the state machine, the single guardian (7 invariants) |
| `Anchor*.t.sol` | Anchor unit tests, roles, fuzz, receipts and the deploy script. `AnchorInvariant.t.sol`: write-once, time order and timelock ordering (3 invariants) |

Results at the audit commit (Foundry 1.7.1):

| Check | Result |
| --- | --- |
| `forge test` | 202 passed, 0 failed, 0 skipped (22 suites) |
| `FOUNDRY_PROFILE=ci forge test` | 202 passed in 233 s; all 10 invariants ran 512 runs × 200 calls with 0 reverts |
| `forge coverage` | 100% of lines, statements, branches and functions: `FlockedEscrow` 314/314 lines, `FlockedAnchor` 119/119, `StakesMath` 29/29 |
| `node tools/check-natspec.mjs` | complete |
| `slither . --fail-medium` | exit 0 (24 low or informational results, all triaged) |
| `aderyn .` | 0 high, 9 low (all triaged) |
| Mutation spot checks | 5 of 5 caught by the new invariants: a refund that skips `hasClaimed`, a dust credit dropped at finalize, claims without the entrant check, a `Locked` event with swapped fields, and an anchor timelock 1 s short |

## Deployment

`script/Deploy.s.sol` deploys both contracts (and `MockUSDC` on anvil only) through the deterministic CREATE2
factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` (Arachnid's deterministic deployment proxy, forge-std's
`CREATE2_FACTORY`). The factory was confirmed on Oct 11, 2026, by reading its code over each chain's public RPC:

| Network | Chain ID | RPC (source) | Block read | Code hash |
| --- | --- | --- | --- | --- |
| Base Sepolia | 84532 (`eth_chainId`) | `https://sepolia.base.org` | 47,964,215 | `0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989` |
| Base | 8453 (`eth_chainId`) | `https://mainnet.base.org` | 52,453,686 | `0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989` |

The runtime code is the same on both chains: Arachnid's proxy (`github.com/Arachnid/deterministic-deployment-proxy`).
The OP Stack lists it as a preinstall at this address ("Arachnid's Deterministic Deployment Proxy",
`specs.optimism.io/protocol/preinstalls.html`), and Base is an OP Stack chain. Neither contract is deployed to either network yet
(`contracts/deployments/` holds no 84532 or 8453 file). W14-A checks the factory again before the production deploy.

## Changes since wave 3

Hardening only. No behaviour change, no new function and no changed revert condition.

- **`GuardianReplaced(address indexed previous, address indexed newGuardian)`** gains `previous`, the holder the
  replacement removed. This is the only ABI change.
- **`executeGuardianReplacement`** now also emits `GuardianTransferred(previous, newGuardian)`, so every move of the
  role emits it.
- **The dead `_setRoleAdmin(GUARDIAN_ROLE, GUARDIAN_ROLE)` is removed.** The guardian's role admin is now
  `DEFAULT_ADMIN_ROLE`, which grants nothing (threat-model K-6).
- **`executeRescue`** puts `nonReentrant` first (F-1).
- **The pragma is pinned** to `0.8.30` on both contracts and the library (F-2).
- **NatSpec** now covers every external function, public getter and event.
- **Slither suppressions** mark the triaged false positives (S-1, S-2).
- **Tests.**
  - The escrow invariants gain per-round conservation and claim exclusivity, a settle scenario (before it, about one
    run in 257 reached a settlement), and stranger leaves in over-generous trees.
  - The anchor invariants gain timelock ordering, event-against-storage checks, key rotation, and targeting of the
    commit window.
