// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";

import {FlockedAnchor} from "../src/FlockedAnchor.sol";
import {IFlockedAnchor} from "../src/interfaces/IFlockedAnchor.sol";

/// @notice Shared deployment and batch helpers for the anchor tests.
abstract contract AnchorBase is Test {
    uint64 internal constant GENESIS = 1692803367; // drand quicknet
    uint64 internal constant PERIOD = 3;
    uint256 internal constant START = 1_760_000_000;

    uint8 internal constant ALREADY_WRITTEN = 1;
    uint8 internal constant NOT_LOCKED = 2;
    uint8 internal constant OUTSIDE_WINDOW = 3;
    uint8 internal constant BEACON_BOUNDS = 4;

    FlockedAnchor internal anchor;

    address internal admin = makeAddr("admin");
    address internal anchorer = makeAddr("anchorer");
    address internal stranger = makeAddr("stranger");
    uint256 internal receiptPk = uint256(keccak256("flocked.test.receipt-signer"));
    address internal receiptSigner;

    /// @dev One `lock` item.
    struct Item {
        bytes32 key;
        uint64 closesAt;
        uint64 beaconRound;
        bytes32 questionHash;
        bytes32 configHash;
    }

    function setUp() public virtual {
        vm.warp(START);
        receiptSigner = vm.addr(receiptPk);
        anchor = new FlockedAnchor(admin, anchorer, receiptSigner, GENESIS, PERIOD);
    }

    // ---------------------------------------------------------------- keys and items

    function _key(uint256 i) internal view returns (bytes32) {
        return anchor.roundKey(bytes16(uint128(i + 1)), 0);
    }

    function _beaconTime(uint64 r) internal pure returns (uint256) {
        return uint256(GENESIS) + (uint256(r) - 1) * PERIOD;
    }

    /// @dev Smallest drand round whose beacon time is >= t.
    function _beaconRoundAt(uint256 t) internal pure returns (uint64) {
        return uint64((t - GENESIS + PERIOD - 1) / PERIOD + 1);
    }

    /// @dev A valid item: closes in an hour, beacon about two minutes after close.
    function _item(uint256 i) internal view returns (Item memory it) {
        it.key = _key(i);
        it.closesAt = uint64(block.timestamp + 1 hours);
        it.beaconRound = _beaconRoundAt(uint256(it.closesAt) + 2 minutes);
        it.questionHash = keccak256(abi.encode("question", i));
        it.configHash = keccak256(abi.encode("config", i));
    }

    // ---------------------------------------------------------------- batches

    function _lock(Item[] memory items) internal {
        uint256 n = items.length;
        bytes32[] memory keys = new bytes32[](n);
        uint64[] memory closes = new uint64[](n);
        uint64[] memory beacons = new uint64[](n);
        bytes32[] memory qs = new bytes32[](n);
        bytes32[] memory cs = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            (keys[i], closes[i], beacons[i], qs[i], cs[i]) =
            (items[i].key, items[i].closesAt, items[i].beaconRound, items[i].questionHash, items[i].configHash);
        }
        vm.prank(anchorer);
        anchor.lock(keys, closes, beacons, qs, cs);
    }

    function _lock(Item memory it) internal {
        Item[] memory items = new Item[](1);
        items[0] = it;
        _lock(items);
    }

    function _commit(bytes32 key, bytes32 root, uint32 entryCount, uint64 totalStake) internal {
        bytes32[] memory keys = new bytes32[](1);
        bytes32[] memory roots = new bytes32[](1);
        uint32[] memory counts = new uint32[](1);
        uint64[] memory stakes = new uint64[](1);
        (keys[0], roots[0], counts[0], stakes[0]) = (key, root, entryCount, totalStake);
        vm.prank(anchorer);
        anchor.commit(keys, roots, counts, stakes);
    }

    // ---------------------------------------------------------------- logs

    /// @dev The `Skipped(key, reason)` events in `logs`, in order, as (key, reason) pairs.
    function _skips(Vm.Log[] memory logs) internal view returns (bytes32[] memory keys, uint8[] memory reasons) {
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (_isSkipped(logs[i])) n++;
        }
        keys = new bytes32[](n);
        reasons = new uint8[](n);
        n = 0;
        for (uint256 i; i < logs.length; i++) {
            if (!_isSkipped(logs[i])) continue;
            keys[n] = logs[i].topics[1];
            reasons[n] = abi.decode(logs[i].data, (uint8));
            n++;
        }
    }

    function _isSkipped(Vm.Log memory l) internal view returns (bool) {
        return l.emitter == address(anchor) && l.topics[0] == IFlockedAnchor.Skipped.selector;
    }

    function _count(Vm.Log[] memory logs, bytes32 topic0) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(anchor) && logs[i].topics[0] == topic0) n++;
        }
    }
}
