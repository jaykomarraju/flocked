// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin-contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin-contracts/utils/cryptography/EIP712.sol";

import {IFlockedAnchor} from "./interfaces/IFlockedAnchor.sol";

/// @title FlockedAnchor
/// @notice Write-once anchors for Free rounds. Per round key it stores one lock leaf (before close), one commitment
///         root (between close and the beacon) and one manifest hash (after the beacon). Batches skip invalid items
///         with a `Skipped` event and apply the rest. Also publishes the receipt signer the client checks receipts
///         against.
contract FlockedAnchor is IFlockedAnchor, AccessControl, EIP712 {
    // ---------------------------------------------------------------------------------------------
    // Roles and constants
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");

    bytes32 public constant RECEIPT_TYPEHASH = keccak256(
        "Receipt(bytes16 roundId,uint8 mode,bytes32 userIdHash,uint64 stake,bytes32 commitment,uint32 seq,uint64 closesAt,uint64 beaconRound)"
    );

    /// @notice Same beacon-delay bounds as `FlockedEscrow.createRound`.
    uint256 public constant MIN_BEACON_DELAY = 60 seconds;
    uint256 public constant MAX_BEACON_DELAY = 10 minutes;

    uint256 public constant ADMIN_TIMELOCK = 72 hours;

    bytes32 public constant ACTION_RECEIPT_SIGNER = keccak256("RECEIPT_SIGNER");
    bytes32 public constant ACTION_ANCHOR_GRANT = keccak256("ANCHOR_GRANT");

    /// @notice `Skipped` reasons.
    uint8 public constant SKIP_ALREADY_WRITTEN = 1;
    uint8 public constant SKIP_NOT_LOCKED = 2;
    uint8 public constant SKIP_OUTSIDE_WINDOW = 3;
    uint8 public constant SKIP_BEACON_BOUNDS = 4;

    /// @notice drand chain genesis time (quicknet: 1692803367).
    uint64 public immutable GENESIS;
    /// @notice drand round period in seconds (quicknet: 3).
    uint64 public immutable PERIOD;

    // ---------------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IFlockedAnchor
    address public receiptSigner;
    /// @inheritdoc IFlockedAnchor
    mapping(bytes32 id => uint256) public timelockReadyAt;

    mapping(bytes32 roundKey => RoundAnchor) internal _anchors;

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    /// @param admin DEFAULT_ADMIN_ROLE (admin multisig).
    /// @param anchorer ANCHOR_ROLE (the AnchorDO's key).
    /// @param receiptSigner_ Initial receipt signer; zero starts with receipts disabled.
    /// @param drandGenesis drand chain genesis time.
    /// @param drandPeriod drand round period in seconds.
    constructor(address admin, address anchorer, address receiptSigner_, uint64 drandGenesis, uint64 drandPeriod)
        EIP712("Flocked", "1")
    {
        if (admin == address(0) || anchorer == address(0)) revert ZeroAddress();
        if (drandGenesis == 0 || drandPeriod == 0) revert InvalidDrandParams();

        GENESIS = drandGenesis;
        PERIOD = drandPeriod;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ANCHOR_ROLE, anchorer);
        _setReceiptSigner(receiptSigner_);
    }

    // ---------------------------------------------------------------------------------------------
    // Anchoring
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IFlockedAnchor
    function lock(
        bytes32[] calldata roundKeys,
        uint64[] calldata closesAts,
        uint64[] calldata beaconRounds,
        bytes32[] calldata questionHashes,
        bytes32[] calldata configHashes
    ) external onlyRole(ANCHOR_ROLE) {
        uint256 n = roundKeys.length;
        if (closesAts.length != n || beaconRounds.length != n || questionHashes.length != n || configHashes.length != n)
        {
            revert LengthMismatch();
        }
        for (uint256 i; i < n; i++) {
            _lock(roundKeys[i], closesAts[i], beaconRounds[i], questionHashes[i], configHashes[i]);
        }
    }

    /// @inheritdoc IFlockedAnchor
    function commit(
        bytes32[] calldata roundKeys,
        bytes32[] calldata roots,
        uint32[] calldata entryCounts,
        uint64[] calldata totalStakes
    ) external onlyRole(ANCHOR_ROLE) {
        uint256 n = roundKeys.length;
        if (roots.length != n || entryCounts.length != n || totalStakes.length != n) revert LengthMismatch();
        for (uint256 i; i < n; i++) {
            _commit(roundKeys[i], roots[i], entryCounts[i], totalStakes[i]);
        }
    }

    /// @inheritdoc IFlockedAnchor
    function anchorManifest(bytes32 key, bytes32 manifestHash) external onlyRole(ANCHOR_ROLE) {
        if (manifestHash == bytes32(0)) revert ZeroManifestHash();
        RoundAnchor storage a = _anchors[key];
        if (a.manifestAnchoredAt != 0) revert ManifestAlreadyAnchored(key);
        if (a.lockedAt == 0) revert NotLocked(key);
        uint256 bt = beaconTime(a.beaconRound);
        if (block.timestamp < bt) revert BeaconNotReached(key, bt);

        a.manifestAnchoredAt = _now();
        a.manifestHash = manifestHash;
        emit ManifestAnchored(key, manifestHash);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IFlockedAnchor
    function getAnchor(bytes32 key) external view returns (RoundAnchor memory) {
        return _anchors[key];
    }

    /// @inheritdoc IFlockedAnchor
    function roundKey(bytes16 roundId, uint8 mode) external pure returns (bytes32) {
        return keccak256(abi.encode(roundId, mode));
    }

    /// @inheritdoc IFlockedAnchor
    function beaconTime(uint64 r) public view returns (uint256) {
        if (r == 0) revert InvalidBeaconRound();
        return uint256(GENESIS) + (uint256(r) - 1) * PERIOD;
    }

    /// @inheritdoc IFlockedAnchor
    function receiptDigest(Receipt calldata receipt) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RECEIPT_TYPEHASH,
                    receipt.roundId,
                    receipt.mode,
                    receipt.userIdHash,
                    receipt.stake,
                    receipt.commitment,
                    receipt.seq,
                    receipt.closesAt,
                    receipt.beaconRound
                )
            )
        );
    }

    /// @inheritdoc IFlockedAnchor
    function verifyReceipt(Receipt calldata receipt, bytes calldata signature) external view returns (bool) {
        address signer = receiptSigner;
        if (signer == address(0)) return false;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(receiptDigest(receipt), signature);
        return err == ECDSA.RecoverError.NoError && recovered == signer;
    }

    /// @inheritdoc IFlockedAnchor
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @inheritdoc IFlockedAnchor
    function operationId(bytes32 action, bytes memory data) public pure returns (bytes32) {
        return keccak256(abi.encode(action, data));
    }

    // ---------------------------------------------------------------------------------------------
    // Roles and timelocks
    // ---------------------------------------------------------------------------------------------

    /// @notice Grants a role. ANCHOR_ROLE can only be granted through `scheduleAnchorGrant`.
    /// @param role The role.
    /// @param account The account.
    function grantRole(bytes32 role, address account) public override {
        if (role == ANCHOR_ROLE) revert TimelockRequired();
        super.grantRole(role, account);
    }

    /// @inheritdoc IFlockedAnchor
    function setReceiptSigner(address newSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSigner != address(0)) revert TimelockRequired();
        _setReceiptSigner(address(0));
    }

    /// @inheritdoc IFlockedAnchor
    function scheduleReceiptSigner(address newSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSigner == address(0)) revert ZeroAddress();
        _schedule(ACTION_RECEIPT_SIGNER, abi.encode(newSigner));
    }

    /// @inheritdoc IFlockedAnchor
    function executeReceiptSigner(address newSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consume(ACTION_RECEIPT_SIGNER, abi.encode(newSigner));
        _setReceiptSigner(newSigner);
    }

    /// @inheritdoc IFlockedAnchor
    function cancelReceiptSigner(address newSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancel(ACTION_RECEIPT_SIGNER, abi.encode(newSigner));
    }

    /// @inheritdoc IFlockedAnchor
    function scheduleAnchorGrant(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        _schedule(ACTION_ANCHOR_GRANT, abi.encode(account));
    }

    /// @inheritdoc IFlockedAnchor
    function executeAnchorGrant(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consume(ACTION_ANCHOR_GRANT, abi.encode(account));
        _grantRole(ANCHOR_ROLE, account);
    }

    /// @inheritdoc IFlockedAnchor
    function cancelAnchorGrant(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancel(ACTION_ANCHOR_GRANT, abi.encode(account));
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _lock(bytes32 key, uint64 closesAt, uint64 beaconRound, bytes32 questionHash, bytes32 configHash)
        internal
    {
        RoundAnchor storage a = _anchors[key];
        if (a.lockedAt != 0) return _skip(key, SKIP_ALREADY_WRITTEN);
        if (!_beaconInBounds(closesAt, beaconRound)) return _skip(key, SKIP_BEACON_BOUNDS);
        if (block.timestamp >= closesAt) return _skip(key, SKIP_OUTSIDE_WINDOW);

        a.closesAt = closesAt;
        a.beaconRound = beaconRound;
        a.lockedAt = _now();
        a.questionHash = questionHash;
        a.configHash = configHash;
        emit Locked(key, closesAt, beaconRound, questionHash, configHash);
    }

    function _commit(bytes32 key, bytes32 root, uint32 entryCount, uint64 totalStake) internal {
        RoundAnchor storage a = _anchors[key];
        if (a.committedAt != 0) return _skip(key, SKIP_ALREADY_WRITTEN);
        if (a.lockedAt == 0) return _skip(key, SKIP_NOT_LOCKED);
        // A commitment in a block stamped at or after the locked beacon time is rejected.
        if (block.timestamp < a.closesAt || block.timestamp >= beaconTime(a.beaconRound)) {
            return _skip(key, SKIP_OUTSIDE_WINDOW);
        }

        a.committedAt = _now();
        a.commitmentRoot = root;
        a.entryCount = entryCount;
        a.totalStake = totalStake;
        emit Committed(key, root, entryCount, totalStake);
    }

    /// @dev `closesAt + MIN_BEACON_DELAY <= beaconTime(beaconRound) <= closesAt + MAX_BEACON_DELAY`, as in the escrow.
    function _beaconInBounds(uint64 closesAt, uint64 beaconRound) internal view returns (bool) {
        if (beaconRound == 0) return false;
        uint256 bt = beaconTime(beaconRound);
        return bt >= uint256(closesAt) + MIN_BEACON_DELAY && bt <= uint256(closesAt) + MAX_BEACON_DELAY;
    }

    function _skip(bytes32 key, uint8 reason) internal {
        emit Skipped(key, reason);
    }

    function _setReceiptSigner(address newSigner) internal {
        receiptSigner = newSigner;
        emit ReceiptSignerSet(newSigner, _now());
    }

    function _now() internal view returns (uint64) {
        // casting to 'uint64' is safe because timestamps stay far below 2^64 seconds
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }

    function _schedule(bytes32 action, bytes memory data) internal {
        bytes32 id = operationId(action, data);
        if (timelockReadyAt[id] != 0) revert AlreadyScheduled(id);
        uint256 readyAt = block.timestamp + ADMIN_TIMELOCK;
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
