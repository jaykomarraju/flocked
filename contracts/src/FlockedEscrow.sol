// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl, IAccessControl} from "@openzeppelin-contracts/access/AccessControl.sol";
import {AccessControlEnumerable} from "@openzeppelin-contracts/access/extensions/AccessControlEnumerable.sol";
import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin-contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin-contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin-contracts/utils/cryptography/MerkleProof.sol";
import {Pausable} from "@openzeppelin-contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin-contracts/utils/ReentrancyGuard.sol";

import {IFlockedEscrow} from "./interfaces/IFlockedEscrow.sol";
import {StakesMath} from "./lib/StakesMath.sol";

/// @title FlockedEscrow
/// @notice Holds all Stakes-mode USDC with per-round accounting. Every outcome is a proposal checked against a posted
///         tally and is final only after a 2-hour challenge window. Money can only move to a round's entrants, its
///         frozen creator and the treasury.
contract FlockedEscrow is IFlockedEscrow, AccessControlEnumerable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Roles and constants
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant ENTRY_TICKET_TYPEHASH =
        keccak256("EntryTicket(uint256 roundId,address wallet,bytes32 personTag,uint64 expiry)");

    uint256 public constant MIN_BEACON_DELAY = 60 seconds;
    uint256 public constant MAX_BEACON_DELAY = 10 minutes;
    uint256 public constant MAX_ROUND_DURATION = 3 days;
    uint256 public constant CHALLENGE_WINDOW = 2 hours;
    uint256 public constant REFUND_TIMEOUT = 72 hours;

    uint256 public constant MIN_STAKE = 1e6; // 1 USDC
    uint256 public constant MAX_STAKE = 100e6; // 100 USDC
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant MAX_CREATOR_BPS = 100;
    uint256 public constant MIN_CAP_MULTIPLE = 1;
    uint256 public constant MAX_CAP_MULTIPLE = 10;

    uint256 public constant MIN_CIPHERTEXT = 64;
    uint256 public constant MAX_CIPHERTEXT = 2048;

    uint256 public constant ADMIN_TIMELOCK = 72 hours;
    uint256 public constant GUARDIAN_TIMELOCK = 7 days;

    bytes32 public constant ACTION_TICKET_SIGNER = keccak256("TICKET_SIGNER");
    bytes32 public constant ACTION_TREASURY = keccak256("TREASURY");
    bytes32 public constant ACTION_OPERATOR_GRANT = keccak256("OPERATOR_GRANT");
    bytes32 public constant ACTION_GUARDIAN = keccak256("GUARDIAN_REPLACEMENT");
    bytes32 public constant ACTION_RESCUE = keccak256("RESCUE");

    uint8 internal constant REASON_VOIDED = 4;
    uint8 internal constant REASON_VETOED = 5;
    uint8 internal constant REASON_TIMEOUT = 6;

    /// @notice The only accepted token.
    IERC20 public immutable usdc;
    /// @notice drand chain genesis time (quicknet: 1692803367).
    uint64 public immutable GENESIS;
    /// @notice drand round period in seconds (quicknet: 3).
    uint64 public immutable PERIOD;

    // ---------------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IFlockedEscrow
    address public ticketSigner;
    /// @inheritdoc IFlockedEscrow
    address public treasury;
    /// @inheritdoc IFlockedEscrow
    uint256 public roundCount;
    /// @inheritdoc IFlockedEscrow
    uint256 public totalObligations;

    mapping(uint256 roundId => Round) internal _rounds;
    /// @inheritdoc IFlockedEscrow
    mapping(uint256 roundId => mapping(address account => bool)) public hasEntered;
    /// @inheritdoc IFlockedEscrow
    mapping(uint256 roundId => mapping(bytes32 personTag => bool)) public personTagUsed;
    /// @inheritdoc IFlockedEscrow
    mapping(uint256 roundId => mapping(address account => bool)) public hasClaimed;
    /// @inheritdoc IFlockedEscrow
    mapping(address account => uint256) public withdrawable;
    /// @inheritdoc IFlockedEscrow
    mapping(bytes32 id => uint256) public timelockReadyAt;

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    /// @param usdc_ The USDC token.
    /// @param admin DEFAULT_ADMIN_ROLE (admin multisig).
    /// @param guardian GUARDIAN_ROLE (guardian multisig, its own role admin).
    /// @param operator OPERATOR_ROLE (backend key).
    /// @param pauser PAUSER_ROLE.
    /// @param ticketSigner_ Initial ticket signer; zero starts with entries disabled.
    /// @param treasury_ Treasury credited with fees and dust.
    /// @param drandGenesis drand chain genesis time.
    /// @param drandPeriod drand round period in seconds.
    constructor(
        IERC20 usdc_,
        address admin,
        address guardian,
        address operator,
        address pauser,
        address ticketSigner_,
        address treasury_,
        uint64 drandGenesis,
        uint64 drandPeriod
    ) EIP712("Flocked", "1") {
        if (
            address(usdc_) == address(0) || admin == address(0) || guardian == address(0) || operator == address(0)
                || pauser == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        if (drandGenesis == 0 || drandPeriod == 0) revert InvalidDrandParams();

        usdc = usdc_;
        GENESIS = drandGenesis;
        PERIOD = drandPeriod;

        _setRoleAdmin(GUARDIAN_ROLE, GUARDIAN_ROLE);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(PAUSER_ROLE, pauser);

        ticketSigner = ticketSigner_;
        treasury = treasury_;
        emit TicketSignerSet(address(0), ticketSigner_);
        emit TreasurySet(address(0), treasury_);
    }

    // ---------------------------------------------------------------------------------------------
    // Round lifecycle
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IFlockedEscrow
    function createRound(RoundConfig calldata cfg) external onlyRole(OPERATOR_ROLE) returns (uint256 roundId) {
        if (!(block.timestamp < cfg.opensAt && cfg.opensAt < cfg.closesAt)) revert InvalidSchedule();
        if (uint256(cfg.closesAt) > uint256(cfg.opensAt) + MAX_ROUND_DURATION) revert InvalidSchedule();
        if (cfg.stake < MIN_STAKE || cfg.stake > MAX_STAKE) revert StakeOutOfRange();
        if (cfg.feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (cfg.creatorBps > MAX_CREATOR_BPS) revert CreatorFeeTooHigh();
        if (cfg.capMultiple < MIN_CAP_MULTIPLE || cfg.capMultiple > MAX_CAP_MULTIPLE) revert CapMultipleOutOfRange();
        if (cfg.minEntrants == 0) revert ZeroMinEntrants();
        if (cfg.creator == address(0)) revert ZeroAddress();
        uint256 bt = beaconTime(cfg.beaconRound);
        if (bt < uint256(cfg.closesAt) + MIN_BEACON_DELAY || bt > uint256(cfg.closesAt) + MAX_BEACON_DELAY) {
            revert BeaconOutOfRange();
        }

        roundId = ++roundCount;
        Round storage rd = _rounds[roundId];
        rd.cfg = cfg;
        rd.status = Status.Open;
        rd.winner = StakesMath.NO_WINNER;
        emit RoundCreated(roundId, cfg);
    }

    /// @inheritdoc IFlockedEscrow
    function voidRound(uint256 roundId) external {
        if (!hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotOperatorOrGuardian();
        }
        Round storage rd = _existing(roundId);
        _requireStatus(roundId, rd, Status.Open);
        if (block.timestamp >= rd.cfg.closesAt) revert RoundClosed();
        _refund(roundId, rd, REASON_VOIDED);
    }

    /// @inheritdoc IFlockedEscrow
    function enter(uint256 roundId, bytes calldata ciphertext, EntryTicket calldata ticket, bytes calldata ticketSig)
        external
        nonReentrant
        whenNotPaused
    {
        _enter(roundId, ciphertext, ticket, ticketSig);
    }

    /// @inheritdoc IFlockedEscrow
    function enterWithPermit(
        uint256 roundId,
        bytes calldata ciphertext,
        EntryTicket calldata ticket,
        bytes calldata ticketSig,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused {
        // A front-run permit must not block the entry; the pull below still needs the allowance.
        try IERC20Permit(address(usdc))
            .permit(msg.sender, address(this), _rounds[roundId].cfg.stake, deadline, v, r, s) {}
            catch {}
        _enter(roundId, ciphertext, ticket, ticketSig);
    }

    /// @inheritdoc IFlockedEscrow
    function refundTooFew(uint256 roundId) external {
        Round storage rd = _existing(roundId);
        _requireStatus(roundId, rd, Status.Open);
        if (block.timestamp < rd.cfg.closesAt) revert RoundNotClosed();
        if (rd.entryCount >= rd.cfg.minEntrants) revert EnoughEntrants();
        _refund(roundId, rd, StakesMath.REASON_TOO_FEW);
    }

    /// @inheritdoc IFlockedEscrow
    function propose(uint256 roundId, uint32 n0, uint32 n1, uint32 nVoid, bytes32 payoutRoot, bytes32 bundleHash)
        external
        onlyRole(OPERATOR_ROLE)
    {
        Round storage rd = _existing(roundId);
        _requireStatus(roundId, rd, Status.Open);
        if (block.timestamp < beaconTime(rd.cfg.beaconRound)) revert BeaconNotReached();
        if (block.timestamp >= uint256(rd.cfg.closesAt) + REFUND_TIMEOUT) revert ProposalWindowClosed();
        if (uint256(n0) + n1 + nVoid != rd.entryCount) revert TallyMismatch();
        if (bundleHash == bytes32(0)) revert ZeroBundleHash();

        StakesMath.Outcome memory o = StakesMath.compute(
            rd.cfg.stake, rd.cfg.feeBps, rd.cfg.creatorBps, rd.cfg.capMultiple, rd.cfg.minEntrants, n0, n1, nVoid
        );

        if (o.status == StakesMath.STATUS_REFUND) {
            if (payoutRoot != bytes32(0)) revert PayoutRootMustBeZero();
            rd.status = Status.RefundProposed;
            rd.refundReason = o.refundReason;
        } else {
            if (payoutRoot == bytes32(0)) revert ZeroPayoutRoot();
            rd.status = Status.SettleProposed;
            rd.winner = o.winner;
            // All amounts are bounded by roundBalance (a uint128), so the casts cannot truncate.
            rd.winPayout = uint128(o.winPayout);
            rd.rebatePayout = uint128(o.rebatePayout);
            rd.fee = uint128(o.fee);
            rd.creatorFee = uint128(o.creatorFee);
            rd.dust = uint128(o.dust);
        }
        rd.n0 = n0;
        rd.n1 = n1;
        rd.nVoid = nVoid;
        rd.payoutRoot = payoutRoot;
        rd.bundleHash = bundleHash;
        // casting to 'uint64' is safe because timestamps stay far below 2^64 seconds
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 claimsOpenAt = uint64(block.timestamp + CHALLENGE_WINDOW);
        rd.claimsOpenAt = claimsOpenAt;

        emit OutcomeProposed(roundId, rd.status, n0, n1, nVoid, payoutRoot, bundleHash, claimsOpenAt);
    }

    /// @inheritdoc IFlockedEscrow
    function veto(uint256 roundId, bytes32 evidenceHash) external onlyRole(GUARDIAN_ROLE) {
        Round storage rd = _existing(roundId);
        Status st = rd.status;
        if (st != Status.SettleProposed && st != Status.RefundProposed) revert WrongStatus(roundId, st);
        if (block.timestamp >= rd.claimsOpenAt) revert ChallengeWindowOver();

        emit ProposalVetoed(roundId, evidenceHash);
        if (st == Status.SettleProposed) {
            _refund(roundId, rd, REASON_VETOED);
        } else {
            // Back to Open: the operator must propose again; the timeout remains the backstop.
            rd.status = Status.Open;
            rd.refundReason = 0;
            rd.n0 = 0;
            rd.n1 = 0;
            rd.nVoid = 0;
            rd.payoutRoot = bytes32(0);
            rd.bundleHash = bytes32(0);
            rd.claimsOpenAt = 0;
        }
    }

    /// @inheritdoc IFlockedEscrow
    function finalize(uint256 roundId) external {
        Round storage rd = _existing(roundId);
        Status st = rd.status;
        if (st != Status.SettleProposed && st != Status.RefundProposed) revert WrongStatus(roundId, st);
        if (block.timestamp < rd.claimsOpenAt) revert ChallengeWindowOpen();
        _finalize(roundId, rd);
    }

    /// @inheritdoc IFlockedEscrow
    function refundTimeout(uint256 roundId) external {
        Round storage rd = _existing(roundId);
        _requireStatus(roundId, rd, Status.Open);
        if (block.timestamp < uint256(rd.cfg.closesAt) + REFUND_TIMEOUT) revert TimeoutNotReached();
        _refund(roundId, rd, REASON_TIMEOUT);
    }

    // ---------------------------------------------------------------------------------------------
    // Claims and withdrawals
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IFlockedEscrow
    function claim(uint256 roundId, Kind kind, bytes32[] calldata proof) external nonReentrant {
        Round storage rd = _existing(roundId);
        _finalizeIfDue(roundId, rd);
        _requireStatus(roundId, rd, Status.Settled);
        _requireClaimable(roundId);

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(roundId, msg.sender, uint8(kind)))));
        if (!MerkleProof.verifyCalldata(proof, rd.payoutRoot, leaf)) revert InvalidProof();

        uint256 amount;
        if (kind == Kind.Win) {
            if (rd.winClaims >= (rd.winner == 0 ? rd.n0 : rd.n1)) revert ClaimLimitReached(kind);
            rd.winClaims++;
            amount = rd.winPayout;
        } else if (kind == Kind.Rebate) {
            if (rd.rebateClaims >= (rd.winner == 0 ? rd.n1 : rd.n0)) revert ClaimLimitReached(kind);
            rd.rebateClaims++;
            amount = rd.rebatePayout;
        } else {
            if (rd.voidClaims >= rd.nVoid) revert ClaimLimitReached(kind);
            rd.voidClaims++;
            amount = rd.cfg.stake;
        }
        if (amount == 0) revert NothingToClaim();

        hasClaimed[roundId][msg.sender] = true;
        totalObligations -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Claimed(roundId, msg.sender, kind, amount);
    }

    /// @inheritdoc IFlockedEscrow
    function claimRefund(uint256 roundId) external nonReentrant {
        Round storage rd = _existing(roundId);
        _finalizeIfDue(roundId, rd);
        _requireStatus(roundId, rd, Status.Refunded);
        _requireClaimable(roundId);

        uint256 amount = rd.cfg.stake;
        hasClaimed[roundId][msg.sender] = true;
        rd.refundClaims++;
        totalObligations -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit RefundClaimed(roundId, msg.sender, amount);
    }

    /// @inheritdoc IFlockedEscrow
    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        withdrawable[msg.sender] = 0;
        totalObligations -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Pause
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IFlockedEscrow
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @inheritdoc IFlockedEscrow
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IFlockedEscrow
    function getRound(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    /// @inheritdoc IFlockedEscrow
    function beaconTime(uint64 r) public view returns (uint256) {
        if (r == 0) revert InvalidBeaconRound();
        return uint256(GENESIS) + (uint256(r) - 1) * PERIOD;
    }

    /// @inheritdoc IFlockedEscrow
    function operationId(bytes32 action, bytes memory data) public pure returns (bytes32) {
        return keccak256(abi.encode(action, data));
    }

    /// @notice The EIP-712 domain separator (name "Flocked", version "1", `block.chainid`, this contract).
    /// @return The separator.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 digest the ticket signer signs for `ticket`; also the `ticketHash` in `Entered`.
    /// @param ticket The entry ticket.
    /// @return The digest.
    function ticketDigest(EntryTicket calldata ticket) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(ENTRY_TICKET_TYPEHASH, ticket.roundId, ticket.wallet, ticket.personTag, ticket.expiry))
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Roles and timelocks
    // ---------------------------------------------------------------------------------------------

    /// @notice Grants a role. OPERATOR_ROLE can only be granted through `scheduleOperatorGrant`.
    /// @param role The role.
    /// @param account The account.
    function grantRole(bytes32 role, address account) public override(AccessControl, IAccessControl) {
        if (role == OPERATOR_ROLE) revert TimelockRequired();
        super.grantRole(role, account);
    }

    /// @inheritdoc IFlockedEscrow
    function setTicketSigner(address newSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSigner != address(0)) revert TimelockRequired();
        emit TicketSignerSet(ticketSigner, address(0));
        ticketSigner = address(0);
    }

    /// @inheritdoc IFlockedEscrow
    function scheduleTicketSigner(address newSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSigner == address(0)) revert ZeroAddress();
        _schedule(ACTION_TICKET_SIGNER, abi.encode(newSigner), ADMIN_TIMELOCK);
    }

    /// @inheritdoc IFlockedEscrow
    function executeTicketSigner(address newSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consume(ACTION_TICKET_SIGNER, abi.encode(newSigner));
        emit TicketSignerSet(ticketSigner, newSigner);
        ticketSigner = newSigner;
    }

    /// @inheritdoc IFlockedEscrow
    function cancelTicketSigner(address newSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancel(ACTION_TICKET_SIGNER, abi.encode(newSigner));
    }

    /// @inheritdoc IFlockedEscrow
    function scheduleTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        _schedule(ACTION_TREASURY, abi.encode(newTreasury), ADMIN_TIMELOCK);
    }

    /// @inheritdoc IFlockedEscrow
    function executeTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consume(ACTION_TREASURY, abi.encode(newTreasury));
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @inheritdoc IFlockedEscrow
    function cancelTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancel(ACTION_TREASURY, abi.encode(newTreasury));
    }

    /// @inheritdoc IFlockedEscrow
    function scheduleOperatorGrant(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        _schedule(ACTION_OPERATOR_GRANT, abi.encode(account), ADMIN_TIMELOCK);
    }

    /// @inheritdoc IFlockedEscrow
    function executeOperatorGrant(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consume(ACTION_OPERATOR_GRANT, abi.encode(account));
        _grantRole(OPERATOR_ROLE, account);
    }

    /// @inheritdoc IFlockedEscrow
    function cancelOperatorGrant(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancel(ACTION_OPERATOR_GRANT, abi.encode(account));
    }

    /// @inheritdoc IFlockedEscrow
    function scheduleGuardianReplacement(address newGuardian) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newGuardian == address(0)) revert ZeroAddress();
        _schedule(ACTION_GUARDIAN, abi.encode(newGuardian), GUARDIAN_TIMELOCK);
    }

    /// @inheritdoc IFlockedEscrow
    function executeGuardianReplacement(address newGuardian) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consume(ACTION_GUARDIAN, abi.encode(newGuardian));
        for (uint256 i = getRoleMemberCount(GUARDIAN_ROLE); i > 0; i--) {
            _revokeRole(GUARDIAN_ROLE, getRoleMember(GUARDIAN_ROLE, i - 1));
        }
        _grantRole(GUARDIAN_ROLE, newGuardian);
        emit GuardianReplaced(newGuardian);
    }

    /// @inheritdoc IFlockedEscrow
    function cancelGuardianReplacement(address newGuardian) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancel(ACTION_GUARDIAN, abi.encode(newGuardian));
    }

    /// @inheritdoc IFlockedEscrow
    function scheduleRescue(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        _schedule(ACTION_RESCUE, abi.encode(token, to, amount), ADMIN_TIMELOCK);
    }

    /// @inheritdoc IFlockedEscrow
    function executeRescue(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        _consume(ACTION_RESCUE, abi.encode(token, to, amount));
        if (token == address(usdc)) {
            uint256 bal = usdc.balanceOf(address(this));
            uint256 surplus = bal > totalObligations ? bal - totalObligations : 0;
            if (amount > surplus) revert RescueExceedsSurplus(amount, surplus);
        }
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    /// @inheritdoc IFlockedEscrow
    function cancelRescue(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancel(ACTION_RESCUE, abi.encode(token, to, amount));
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _enter(uint256 roundId, bytes calldata ciphertext, EntryTicket calldata ticket, bytes calldata ticketSig)
        internal
    {
        Round storage rd = _rounds[roundId];
        _requireStatus(roundId, rd, Status.Open);
        if (block.timestamp < rd.cfg.opensAt) revert RoundNotYetOpen();
        if (block.timestamp >= rd.cfg.closesAt) revert RoundClosed();

        if (ciphertext.length < MIN_CIPHERTEXT || ciphertext.length > MAX_CIPHERTEXT) {
            revert CiphertextLength(ciphertext.length);
        }
        bytes32 digest = _verifyTicket(roundId, ticket, ticketSig);
        _recordEntry(roundId, rd, ticket.personTag);
        emit Entered(roundId, msg.sender, ticket.personTag, digest, ciphertext);
    }

    /// @dev Checks the ticket against the current signer, this round and the caller; returns its EIP-712 digest.
    function _verifyTicket(uint256 roundId, EntryTicket calldata ticket, bytes calldata ticketSig)
        internal
        view
        returns (bytes32 digest)
    {
        address signer = ticketSigner;
        if (signer == address(0)) revert TicketSignerDisabled();
        if (ticket.roundId != roundId) revert TicketRoundMismatch();
        if (ticket.wallet != msg.sender) revert TicketWalletMismatch();
        if (block.timestamp > ticket.expiry) revert TicketExpired();
        if (ticket.personTag == bytes32(0)) revert ZeroPersonTag();
        digest = ticketDigest(ticket);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, ticketSig);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert InvalidTicketSignature();
    }

    /// @dev Dedupes the caller and person tag, records the entry and pulls exactly the stake.
    function _recordEntry(uint256 roundId, Round storage rd, bytes32 personTag) internal {
        if (hasEntered[roundId][msg.sender]) revert AlreadyEntered();
        if (personTagUsed[roundId][personTag]) revert PersonTagUsed();

        uint128 stake = rd.cfg.stake;
        hasEntered[roundId][msg.sender] = true;
        personTagUsed[roundId][personTag] = true;
        rd.entryCount++;
        rd.roundBalance += stake;
        totalObligations += stake;

        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), stake);
        if (usdc.balanceOf(address(this)) - before != stake) revert StakeTransferMismatch();
    }

    function _finalizeIfDue(uint256 roundId, Round storage rd) internal {
        Status st = rd.status;
        if ((st == Status.SettleProposed || st == Status.RefundProposed) && block.timestamp >= rd.claimsOpenAt) {
            _finalize(roundId, rd);
        }
    }

    function _finalize(uint256 roundId, Round storage rd) internal {
        if (rd.status == Status.SettleProposed) {
            rd.status = Status.Settled;
            _credit(treasury, uint256(rd.fee) + rd.dust);
            _credit(rd.cfg.creator, rd.creatorFee);
            emit RoundFinalized(roundId, Status.Settled);
        } else {
            rd.status = Status.Refunded;
            emit RoundFinalized(roundId, Status.Refunded);
            emit RoundRefunded(roundId, rd.refundReason);
        }
    }

    function _refund(uint256 roundId, Round storage rd, uint8 reason) internal {
        rd.status = Status.Refunded;
        rd.refundReason = reason;
        emit RoundRefunded(roundId, reason);
    }

    /// @dev Moves an amount already counted in `totalObligations` from a round to an account's balance.
    function _credit(address account, uint256 amount) internal {
        if (amount == 0) return;
        withdrawable[account] += amount;
        emit Credited(account, amount);
    }

    function _requireClaimable(uint256 roundId) internal view {
        if (!hasEntered[roundId][msg.sender]) revert NotEntrant();
        if (hasClaimed[roundId][msg.sender]) revert AlreadyClaimed();
    }

    function _existing(uint256 roundId) internal view returns (Round storage rd) {
        rd = _rounds[roundId];
        if (rd.status == Status.None) revert RoundNotFound(roundId);
    }

    function _requireStatus(uint256 roundId, Round storage rd, Status expected) internal view {
        if (rd.status != expected) revert WrongStatus(roundId, rd.status);
    }

    function _schedule(bytes32 action, bytes memory data, uint256 delay) internal {
        bytes32 id = operationId(action, data);
        if (timelockReadyAt[id] != 0) revert AlreadyScheduled(id);
        uint256 readyAt = block.timestamp + delay;
        timelockReadyAt[id] = readyAt;
        emit TimelockScheduled(id, action, data, readyAt);
    }

    function _consume(bytes32 action, bytes memory data) internal {
        bytes32 id = operationId(action, data);
        uint256 readyAt = timelockReadyAt[id];
        if (readyAt == 0) revert NotScheduled(id);
        if (block.timestamp < readyAt) revert TimelockNotReady(id, readyAt);
        delete timelockReadyAt[id];
        emit TimelockExecuted(id, action, data);
    }

    function _cancel(bytes32 action, bytes memory data) internal {
        bytes32 id = operationId(action, data);
        if (timelockReadyAt[id] == 0) revert NotScheduled(id);
        delete timelockReadyAt[id];
        emit TimelockCancelled(id, action, data);
    }
}
