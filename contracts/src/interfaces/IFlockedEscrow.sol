// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IFlockedEscrow
/// @notice Stakes-mode escrow for Flocked rounds. The first block (types, events and the core functions) is the
///         spec's interface verbatim; the pinned views, timelocked admin functions and custom errors follow it.
interface IFlockedEscrow {
    // ---------------------------------------------------------------------------------------------
    // Spec interface (Product_Spec.md, "Smart contract")
    // ---------------------------------------------------------------------------------------------

    enum Status {
        None,
        Open,
        SettleProposed,
        RefundProposed,
        Settled,
        Refunded
    }
    enum Kind {
        Win,
        Rebate,
        VoidRefund
    }

    struct RoundConfig {
        uint64 opensAt;
        uint64 closesAt;
        uint64 beaconRound; // drand quicknet round the picks are encrypted to
        uint128 stake; // fixed stake for every entry in the round
        uint16 feeBps;
        uint16 creatorBps;
        uint8 capMultiple;
        uint32 minEntrants;
        address creator; // question author's payout address, or treasury
        bytes32 questionHash; // keccak256 of the canonical prompt + both options
    }

    struct EntryTicket {
        uint256 roundId;
        address wallet;
        bytes32 personTag; // per-round person tag (see Identity and personhood)
        uint64 expiry;
    }

    event RoundCreated(uint256 indexed roundId, RoundConfig cfg);
    event Entered(
        uint256 indexed roundId, address indexed player, bytes32 indexed personTag, bytes32 ticketHash, bytes ciphertext
    );
    event OutcomeProposed(
        uint256 indexed roundId,
        Status status,
        uint32 n0,
        uint32 n1,
        uint32 nVoid,
        bytes32 payoutRoot,
        bytes32 bundleHash,
        uint64 claimsOpenAt
    );
    event ProposalVetoed(uint256 indexed roundId, bytes32 evidenceHash);
    event RoundFinalized(uint256 indexed roundId, Status status);
    event RoundRefunded(uint256 indexed roundId, uint8 reason);
    event Claimed(uint256 indexed roundId, address indexed player, Kind kind, uint256 amount);
    event RefundClaimed(uint256 indexed roundId, address indexed player, uint256 amount);

    /// @notice Creates a round with the next ID from the counter. OPERATOR_ROLE.
    /// @dev Reverts unless `block.timestamp < opensAt < closesAt <= opensAt + MAX_ROUND_DURATION`, the stake, fees and
    ///      cap are within the launch ceilings, `minEntrants >= 1`, `creator != 0`, and
    ///      `closesAt + MIN_BEACON_DELAY <= beaconTime(beaconRound) <= closesAt + MAX_BEACON_DELAY`.
    /// @param cfg The round configuration, frozen for the life of the round.
    /// @return roundId The new round's ID (1, 2, 3, ...).
    function createRound(RoundConfig calldata cfg) external returns (uint256 roundId);

    /// @notice Voids an Open round before `closesAt` (refund reason 4). OPERATOR_ROLE or GUARDIAN_ROLE.
    /// @param roundId The round to void.
    function voidRound(uint256 roundId) external;

    /// @notice Enters a round with a sealed pick, pulling exactly the round's stake in USDC.
    /// @dev Requires an Open, unpaused round inside `[opensAt, closesAt)`, a ticket signed by the current ticket
    ///      signer for this round and `msg.sender`, unexpired, a 64-2,048-byte ciphertext, and that neither the
    ///      caller nor the ticket's `personTag` has entered this round.
    /// @param roundId The round to enter.
    /// @param ciphertext The tlock ciphertext of the pick, emitted in full in `Entered`.
    /// @param ticket The EIP-712 entry ticket.
    /// @param ticketSig The ticket signer's 65-byte signature over the ticket.
    function enter(uint256 roundId, bytes calldata ciphertext, EntryTicket calldata ticket, bytes calldata ticketSig)
        external;

    /// @notice `enter` preceded by an EIP-2612 permit for exactly the round's stake.
    /// @dev A failing permit is ignored (it may have been front-run); the transfer then needs an allowance.
    /// @param roundId The round to enter.
    /// @param ciphertext The tlock ciphertext of the pick.
    /// @param ticket The EIP-712 entry ticket.
    /// @param ticketSig The ticket signer's 65-byte signature over the ticket.
    /// @param deadline The permit deadline.
    /// @param v The permit signature's v.
    /// @param r The permit signature's r.
    /// @param s The permit signature's s.
    function enterWithPermit(
        uint256 roundId,
        bytes calldata ciphertext,
        EntryTicket calldata ticket,
        bytes calldata ticketSig,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Proposes a round's outcome from the posted tally. OPERATOR_ROLE.
    /// @dev Requires an Open round, `beaconTime(beaconRound) <= now < closesAt + REFUND_TIMEOUT` and
    ///      `n0 + n1 + nVoid == entryCount`. A refund tally (reasons 1-3) needs a zero `payoutRoot`; a settle tally
    ///      needs a non-zero one. `bundleHash` must be non-zero. Sets `claimsOpenAt = now + CHALLENGE_WINDOW`.
    /// @param roundId The round.
    /// @param n0 Valid entries on option 0.
    /// @param n1 Valid entries on option 1.
    /// @param nVoid VOID entries.
    /// @param payoutRoot StandardMerkleTree root of the (roundId, account, kind) payout leaves, or zero for a refund.
    /// @param bundleHash keccak256 of the verification bundle manifest.
    function propose(uint256 roundId, uint32 n0, uint32 n1, uint32 nVoid, bytes32 payoutRoot, bytes32 bundleHash)
        external;

    /// @notice Vetoes a proposal before `claimsOpenAt`. GUARDIAN_ROLE.
    /// @dev SettleProposed becomes Refunded (reason 5); RefundProposed returns to Open.
    /// @param roundId The round.
    /// @param evidenceHash Hash of the guardian's evidence, emitted with the veto.
    function veto(uint256 roundId, bytes32 evidenceHash) external;

    /// @notice Finalizes a proposal at or after `claimsOpenAt`. Anyone.
    /// @dev SettleProposed becomes Settled (fee + dust credited to the treasury, creator fee to the creator);
    ///      RefundProposed becomes Refunded.
    /// @param roundId The round.
    function finalize(uint256 roundId) external;

    /// @notice Refunds an Open round after `closesAt` with fewer than `minEntrants` entries (reason 1). Anyone.
    /// @param roundId The round.
    function refundTooFew(uint256 roundId) external;

    /// @notice Refunds an Open round once `now >= closesAt + REFUND_TIMEOUT` (reason 6). Anyone.
    /// @param roundId The round.
    function refundTimeout(uint256 roundId) external;

    /// @notice Claims the caller's payout of `kind` from a Settled round, finalizing first if due.
    /// @dev Amounts: Win = s + w, Rebate = r, VoidRefund = s. Per-kind claim counts are capped at N_M, N_L, nVoid.
    /// @param roundId The round.
    /// @param kind The payout kind in the caller's leaf.
    /// @param proof The Merkle proof for leaf (roundId, msg.sender, kind).
    function claim(uint256 roundId, Kind kind, bytes32[] calldata proof) external;

    /// @notice Claims the caller's stake back from a Refunded round, finalizing first if due. Once per entrant.
    /// @param roundId The round.
    function claimRefund(uint256 roundId) external;

    /// @notice Pays the caller's credited fee balance (pull pattern, for the treasury and creators).
    function withdraw() external;

    /// @notice Pauses `enter` and `enterWithPermit`. PAUSER_ROLE. Takes effect immediately.
    function pause() external;

    /// @notice Unpauses entries. DEFAULT_ADMIN_ROLE only, so a stolen pauser key can't undo a pause. Immediate.
    function unpause() external;

    /// @notice Hands GUARDIAN_ROLE to `newGuardian`, immediately. GUARDIAN_ROLE.
    /// @dev The role always has exactly one holder: the caller loses it in the same call. `grantRole`, `revokeRole`
    ///      and `renounceRole` revert for it; the admin can replace the guardian only through the 7-day timelock.
    /// @param newGuardian The new guardian (non-zero).
    function transferGuardian(address newGuardian) external;

    // ---------------------------------------------------------------------------------------------
    // Pinned additions (docs/plan/wave-1.md, P1.3)
    // ---------------------------------------------------------------------------------------------

    /// @notice Full per-round state returned by `getRound`.
    /// @dev `winner` is 0 or 1 once settle-proposed, otherwise 255. `winPayout` = s + w, `rebatePayout` = r.
    ///      `fee`, `creatorFee` and `dust` are the closed-form amounts (credited at finalize).
    struct Round {
        RoundConfig cfg;
        Status status;
        uint8 refundReason;
        uint8 winner;
        uint32 entryCount;
        uint64 claimsOpenAt;
        uint128 roundBalance;
        uint32 n0;
        uint32 n1;
        uint32 nVoid;
        uint32 winClaims;
        uint32 rebateClaims;
        uint32 voidClaims;
        uint32 refundClaims;
        uint128 winPayout;
        uint128 rebatePayout;
        uint128 fee;
        uint128 creatorFee;
        uint128 dust;
        bytes32 payoutRoot;
        bytes32 bundleHash;
    }

    event Credited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event TimelockScheduled(bytes32 indexed id, bytes32 indexed action, bytes data, uint256 readyAt);
    event TimelockExecuted(bytes32 indexed id, bytes32 indexed action, bytes data);
    event TimelockCancelled(bytes32 indexed id, bytes32 indexed action, bytes data);
    event TicketSignerSet(address indexed previous, address indexed current);
    event TreasurySet(address indexed previous, address indexed current);
    event GuardianReplaced(address indexed newGuardian);
    event GuardianTransferred(address indexed previous, address indexed current);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error InvalidDrandParams();
    error RoundNotFound(uint256 roundId);
    error WrongStatus(uint256 roundId, Status status);
    error InvalidSchedule();
    error StakeOutOfRange();
    error FeeTooHigh();
    error CreatorFeeTooHigh();
    error CapMultipleOutOfRange();
    error ZeroMinEntrants();
    error InvalidBeaconRound();
    error BeaconOutOfRange();
    error RoundClosed();
    error RoundNotYetOpen();
    error RoundNotClosed();
    error TicketSignerDisabled();
    error TicketRoundMismatch();
    error TicketWalletMismatch();
    error TicketExpired();
    error ZeroPersonTag();
    error InvalidTicketSignature();
    error CiphertextLength(uint256 length);
    error AlreadyEntered();
    error PersonTagUsed();
    error StakeTransferMismatch();
    error EnoughEntrants();
    error BeaconNotReached();
    error ProposalWindowClosed();
    error TallyMismatch();
    error ZeroBundleHash();
    error PayoutRootMustBeZero();
    error ZeroPayoutRoot();
    error ChallengeWindowOver();
    error ChallengeWindowOpen();
    error TimeoutNotReached();
    error NotEntrant();
    error AlreadyClaimed();
    error InvalidProof();
    error ClaimLimitReached(Kind kind);
    error NothingToClaim();
    error NotOperatorOrGuardian();
    error TimelockRequired();
    error AlreadyScheduled(bytes32 id);
    error NotScheduled(bytes32 id);
    error TimelockNotReady(bytes32 id, uint256 readyAt);
    error RescueExceedsSurplus(uint256 amount, uint256 surplus);
    error SingleGuardian();

    /// @notice The full state of a round.
    /// @param roundId The round.
    /// @return The round's config, status, counters, proposal and derived amounts.
    function getRound(uint256 roundId) external view returns (Round memory);

    /// @notice Unix time at which drand round `r` is published: `GENESIS + (r - 1) * PERIOD`.
    /// @param r The drand round (must be >= 1).
    /// @return The beacon time in seconds.
    function beaconTime(uint64 r) external view returns (uint256);

    /// @notice The current ticket signer; zero means entries are disabled.
    /// @return The signer address.
    function ticketSigner() external view returns (address);

    /// @notice The treasury credited with fees and dust at finalize.
    /// @return The treasury address.
    function treasury() external view returns (address);

    /// @notice The one GUARDIAN_ROLE holder.
    /// @return The guardian address.
    function guardian() external view returns (address);

    /// @notice Whether `account` has entered `roundId`.
    /// @param roundId The round.
    /// @param account The wallet.
    /// @return True if entered.
    function hasEntered(uint256 roundId, address account) external view returns (bool);

    /// @notice Whether `personTag` has been used in `roundId`.
    /// @param roundId The round.
    /// @param personTag The per-round person tag.
    /// @return True if used.
    function personTagUsed(uint256 roundId, bytes32 personTag) external view returns (bool);

    /// @notice Whether `account` has claimed (a payout or a refund) from `roundId`.
    /// @param roundId The round.
    /// @param account The wallet.
    /// @return True if claimed.
    function hasClaimed(uint256 roundId, address account) external view returns (bool);

    /// @notice Credited fee balance `account` can `withdraw`.
    /// @param account The account.
    /// @return The balance in USDC base units.
    function withdrawable(address account) external view returns (uint256);

    /// @notice Number of rounds created; round IDs run from 1 to `roundCount()`.
    /// @return The count.
    function roundCount() external view returns (uint256);

    /// @notice USDC the contract owes: every round's unpaid entitlements plus every credited fee balance.
    /// @return The total in USDC base units.
    function totalObligations() external view returns (uint256);

    /// @notice Unix time at which a scheduled operation can execute, or zero if not scheduled.
    /// @param id The operation ID from `operationId`.
    /// @return The ready time.
    function timelockReadyAt(bytes32 id) external view returns (uint256);

    /// @notice The ID of a timelocked operation.
    /// @param action The action tag (for example `keccak256("TICKET_SIGNER")`).
    /// @param data The ABI-encoded parameters.
    /// @return The operation ID.
    function operationId(bytes32 action, bytes memory data) external pure returns (bytes32);

    /// @notice Disables the ticket signer immediately. Only `address(0)` is accepted; other signers need the timelock.
    /// @param newSigner Must be `address(0)`.
    function setTicketSigner(address newSigner) external;

    /// @notice Schedules a new ticket signer (72 hours). DEFAULT_ADMIN_ROLE.
    /// @param newSigner The new signer (non-zero).
    function scheduleTicketSigner(address newSigner) external;

    /// @notice Sets a scheduled ticket signer once its timelock has passed. DEFAULT_ADMIN_ROLE.
    /// @param newSigner The scheduled signer.
    function executeTicketSigner(address newSigner) external;

    /// @notice Cancels a scheduled ticket signer. DEFAULT_ADMIN_ROLE.
    /// @param newSigner The scheduled signer.
    function cancelTicketSigner(address newSigner) external;

    /// @notice Schedules a new treasury (72 hours). DEFAULT_ADMIN_ROLE.
    /// @param newTreasury The new treasury (non-zero).
    function scheduleTreasury(address newTreasury) external;

    /// @notice Sets a scheduled treasury once its timelock has passed. DEFAULT_ADMIN_ROLE.
    /// @param newTreasury The scheduled treasury.
    function executeTreasury(address newTreasury) external;

    /// @notice Cancels a scheduled treasury. DEFAULT_ADMIN_ROLE.
    /// @param newTreasury The scheduled treasury.
    function cancelTreasury(address newTreasury) external;

    /// @notice Schedules an OPERATOR_ROLE grant (72 hours). DEFAULT_ADMIN_ROLE. Revocation is immediate.
    /// @param account The account to grant.
    function scheduleOperatorGrant(address account) external;

    /// @notice Grants a scheduled OPERATOR_ROLE once its timelock has passed. DEFAULT_ADMIN_ROLE.
    /// @param account The scheduled account.
    function executeOperatorGrant(address account) external;

    /// @notice Cancels a scheduled OPERATOR_ROLE grant. DEFAULT_ADMIN_ROLE.
    /// @param account The scheduled account.
    function cancelOperatorGrant(address account) external;

    /// @notice Schedules replacing the guardian with `newGuardian` (7 days). DEFAULT_ADMIN_ROLE.
    /// @param newGuardian The replacement guardian (non-zero).
    function scheduleGuardianReplacement(address newGuardian) external;

    /// @notice Replaces the guardian once its 7-day timelock has passed. DEFAULT_ADMIN_ROLE.
    /// @dev A single write: revokes the one current holder (whoever it is by then) and grants `newGuardian`.
    /// @param newGuardian The scheduled guardian.
    function executeGuardianReplacement(address newGuardian) external;

    /// @notice Cancels a scheduled guardian replacement. DEFAULT_ADMIN_ROLE.
    /// @param newGuardian The scheduled guardian.
    function cancelGuardianReplacement(address newGuardian) external;

    /// @notice Schedules a rescue of tokens sent by other means (72 hours). DEFAULT_ADMIN_ROLE.
    /// @param token The token (USDC only above outstanding obligations, checked at execution).
    /// @param to The recipient (non-zero).
    /// @param amount The amount.
    function scheduleRescue(address token, address to, uint256 amount) external;

    /// @notice Executes a scheduled rescue once its timelock has passed. DEFAULT_ADMIN_ROLE.
    /// @param token The token.
    /// @param to The recipient.
    /// @param amount The amount.
    function executeRescue(address token, address to, uint256 amount) external;

    /// @notice Cancels a scheduled rescue. DEFAULT_ADMIN_ROLE.
    /// @param token The token.
    /// @param to The recipient.
    /// @param amount The amount.
    function cancelRescue(address token, address to, uint256 amount) external;
}
