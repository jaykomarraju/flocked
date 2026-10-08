// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IFlockedAnchor
/// @notice Write-once onchain anchors for Free rounds: the lock leaf at question lock, the commitment root before the
///         beacon, and the settlement manifest after it. The first block is the spec's interface verbatim; the pinned
///         views, timelocked admin functions and custom errors follow it (docs/plan/wave-2.md, P2.2).
interface IFlockedAnchor {
    // ---------------------------------------------------------------------------------------------
    // Spec interface (Product_Spec.md, "Smart contract", "Contract: FlockedAnchor")
    // ---------------------------------------------------------------------------------------------

    // roundKey = keccak256(abi.encode(roundId, mode))
    event Locked(
        bytes32 indexed roundKey, uint64 closesAt, uint64 beaconRound, bytes32 questionHash, bytes32 configHash
    );
    event Committed(bytes32 indexed roundKey, bytes32 commitmentRoot, uint32 entryCount, uint64 totalStake);
    event ManifestAnchored(bytes32 indexed roundKey, bytes32 manifestHash);
    event ReceiptSignerSet(address signer, uint64 validFrom);
    event Skipped(bytes32 indexed roundKey, uint8 reason);

    /// @notice Writes each round key's lock leaf, once. ANCHOR_ROLE.
    /// @dev Per item, in this order: already locked → `Skipped(key, 1)`; `beaconRound == 0` or
    ///      `beaconTime(beaconRound)` outside `[closesAt + MIN_BEACON_DELAY, closesAt + MAX_BEACON_DELAY]` →
    ///      `Skipped(key, 4)`; `block.timestamp >= closesAt` → `Skipped(key, 3)`. Valid items still apply.
    ///      Arrays of different lengths revert the whole call.
    /// @param roundKeys `roundKey(roundId, mode)` per item.
    /// @param closesAts The round's close time.
    /// @param beaconRounds The drand round the picks are encrypted to.
    /// @param questionHashes keccak256 of the canonical prompt and both options.
    /// @param configHashes Hash of the round config (stake range, cap, minEntrants, creator award, beaconDelay).
    function lock(
        bytes32[] calldata roundKeys,
        uint64[] calldata closesAts,
        uint64[] calldata beaconRounds,
        bytes32[] calldata questionHashes,
        bytes32[] calldata configHashes
    ) external;

    /// @notice Writes each round key's commitment root, once, between close and the beacon. ANCHOR_ROLE.
    /// @dev Per item, in this order: already committed → `Skipped(key, 1)`; not locked → `Skipped(key, 2)`;
    ///      outside `closesAt <= block.timestamp < beaconTime(beaconRound)` → `Skipped(key, 3)`. Valid items still
    ///      apply. Arrays of different lengths revert the whole call.
    /// @param roundKeys `roundKey(roundId, mode)` per item.
    /// @param roots Merkle root over the round's committed receipt leaves.
    /// @param entryCounts Number of leaves.
    /// @param totalStakes Sum of the leaves' stakes (points).
    function commit(
        bytes32[] calldata roundKeys,
        bytes32[] calldata roots,
        uint32[] calldata entryCounts,
        uint64[] calldata totalStakes
    ) external;

    /// @notice Anchors a locked round key's settlement manifest hash, once, at or after its beacon time. ANCHOR_ROLE.
    /// @dev Not a batch, so it reverts instead of skipping: `ZeroManifestHash`, `ManifestAlreadyAnchored`,
    ///      `NotLocked`, `BeaconNotReached`.
    /// @param roundKey `roundKey(roundId, mode)`.
    /// @param manifestHash keccak256 of the verification bundle manifest (non-zero).
    function anchorManifest(bytes32 roundKey, bytes32 manifestHash) external;

    /// @notice The current receipt signer; zero means receipts are disabled.
    /// @return The signer address.
    function receiptSigner() external view returns (address);

    // ---------------------------------------------------------------------------------------------
    // Pinned additions (docs/plan/wave-2.md, P2.2)
    // ---------------------------------------------------------------------------------------------

    /// @notice An entry receipt (EIP-712 type `Receipt`, domain "Flocked" / "1" / `block.chainid` / this contract).
    struct Receipt {
        bytes16 roundId;
        uint8 mode;
        bytes32 userIdHash; // keccak256(abi.encode(roundId, userId))
        uint64 stake;
        bytes32 commitment; // keccak256 of the client's ciphertext
        uint32 seq; // the entry's sequence number in the round
        uint64 closesAt;
        uint64 beaconRound;
    }

    /// @notice Everything anchored for one round key. A `*At` of zero means that kind is not written yet.
    struct RoundAnchor {
        uint64 closesAt;
        uint64 beaconRound;
        uint64 lockedAt;
        uint64 committedAt;
        bytes32 questionHash;
        bytes32 configHash;
        bytes32 commitmentRoot;
        uint32 entryCount;
        uint64 totalStake;
        uint64 manifestAnchoredAt;
        bytes32 manifestHash;
    }

    event TimelockScheduled(bytes32 indexed id, bytes32 indexed action, bytes data, uint256 readyAt);
    event TimelockExecuted(bytes32 indexed id, bytes32 indexed action, bytes data);
    event TimelockCancelled(bytes32 indexed id, bytes32 indexed action, bytes data);

    error ZeroAddress();
    error InvalidDrandParams();
    error InvalidBeaconRound();
    error LengthMismatch();
    error ZeroManifestHash();
    error ManifestAlreadyAnchored(bytes32 roundKey);
    error NotLocked(bytes32 roundKey);
    error BeaconNotReached(bytes32 roundKey, uint256 beaconTime);
    error TimelockRequired();
    error AlreadyScheduled(bytes32 id);
    error NotScheduled(bytes32 id);
    error TimelockNotReady(bytes32 id, uint256 readyAt);

    /// @notice Everything anchored for `key`.
    /// @param key The round key.
    /// @return The lock leaf, commitment and manifest, with the time each was written (zero if not yet).
    function getAnchor(bytes32 key) external view returns (RoundAnchor memory);

    /// @notice `keccak256(abi.encode(roundId, mode))`.
    /// @param roundId The round's 16-byte ID.
    /// @param mode The mode.
    /// @return The round key.
    function roundKey(bytes16 roundId, uint8 mode) external pure returns (bytes32);

    /// @notice Unix time at which drand round `r` is published: `GENESIS + (r - 1) * PERIOD`.
    /// @param r The drand round (must be >= 1).
    /// @return The beacon time in seconds.
    function beaconTime(uint64 r) external view returns (uint256);

    /// @notice The EIP-712 digest the receipt signer signs for `receipt`.
    /// @param receipt The receipt.
    /// @return The digest.
    function receiptDigest(Receipt calldata receipt) external view returns (bytes32);

    /// @notice Whether `signature` is the current receipt signer's signature over `receipt`.
    /// @dev Checks against the current signer only; older receipts are checked against the `ReceiptSignerSet`
    ///      history. False when receipts are disabled or the signature is malformed.
    /// @param receipt The receipt.
    /// @param signature A 65-byte ECDSA signature.
    /// @return True if valid.
    function verifyReceipt(Receipt calldata receipt, bytes calldata signature) external view returns (bool);

    /// @notice The EIP-712 domain separator (name "Flocked", version "1", `block.chainid`, this contract).
    /// @return The separator.
    function domainSeparator() external view returns (bytes32);

    /// @notice Unix time at which a scheduled operation can execute, or zero if not scheduled.
    /// @param id The operation ID from `operationId`.
    /// @return The ready time.
    function timelockReadyAt(bytes32 id) external view returns (uint256);

    /// @notice The ID of a timelocked operation.
    /// @param action The action tag (for example `keccak256("RECEIPT_SIGNER")`).
    /// @param data The ABI-encoded parameters.
    /// @return The operation ID.
    function operationId(bytes32 action, bytes memory data) external pure returns (bytes32);

    /// @notice Disables receipts immediately. Only `address(0)` is accepted; other signers need the timelock.
    ///         DEFAULT_ADMIN_ROLE.
    /// @param newSigner Must be `address(0)`.
    function setReceiptSigner(address newSigner) external;

    /// @notice Schedules a new receipt signer (72 hours). DEFAULT_ADMIN_ROLE.
    /// @param newSigner The new signer (non-zero).
    function scheduleReceiptSigner(address newSigner) external;

    /// @notice Sets a scheduled receipt signer once its timelock has passed. DEFAULT_ADMIN_ROLE.
    /// @param newSigner The scheduled signer.
    function executeReceiptSigner(address newSigner) external;

    /// @notice Cancels a scheduled receipt signer. DEFAULT_ADMIN_ROLE.
    /// @param newSigner The scheduled signer.
    function cancelReceiptSigner(address newSigner) external;

    /// @notice Schedules an ANCHOR_ROLE grant (72 hours). DEFAULT_ADMIN_ROLE. Revocation is immediate.
    /// @param account The account to grant.
    function scheduleAnchorGrant(address account) external;

    /// @notice Grants a scheduled ANCHOR_ROLE once its timelock has passed. DEFAULT_ADMIN_ROLE.
    /// @param account The scheduled account.
    function executeAnchorGrant(address account) external;

    /// @notice Cancels a scheduled ANCHOR_ROLE grant. DEFAULT_ADMIN_ROLE.
    /// @param account The scheduled account.
    function cancelAnchorGrant(address account) external;
}
