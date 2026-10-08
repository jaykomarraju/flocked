// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";

import {FlockedAnchor} from "../src/FlockedAnchor.sol";
import {IFlockedAnchor} from "../src/interfaces/IFlockedAnchor.sol";
import {AnchorBase} from "./AnchorBase.t.sol";

/// @notice Drives the anchor with random lock and commit batches and manifest calls over a small key pool, so keys
///         collide and time windows open and close. It records every write event and the first value written.
contract AnchorHandler is Test {
    FlockedAnchor public immutable anchor;
    address internal immutable anchorer;

    uint256 public constant POOL = 6;
    bytes32[POOL] public keys;

    /// @notice Write events seen per key and kind (0 lock, 1 commit, 2 manifest).
    mapping(bytes32 => uint256[3]) internal _writes;
    /// @notice The stored anchor right after the first write of each kind.
    mapping(bytes32 => mapping(uint256 => bytes32)) public firstWrite;
    mapping(bytes32 => uint256) public calls;

    constructor(FlockedAnchor anchor_, address anchorer_) {
        anchor = anchor_;
        anchorer = anchorer_;
        for (uint256 i; i < POOL; i++) {
            keys[i] = anchor_.roundKey(bytes16(uint128(i + 1)), uint8(i % 2));
        }
    }

    function writes(bytes32 key, uint256 kind) external view returns (uint256) {
        return _writes[key][kind];
    }

    // ---------------------------------------------------------------- actions

    function lockBatch(uint256 seed) external {
        calls["lock"]++;
        uint256 n = 1 + seed % 5;
        bytes32[] memory ks = new bytes32[](n);
        uint64[] memory closes = new uint64[](n);
        uint64[] memory beacons = new uint64[](n);
        bytes32[] memory qs = new bytes32[](n);
        bytes32[] memory cs = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            uint256 s = uint256(keccak256(abi.encode(seed, i)));
            ks[i] = keys[s % POOL];
            closes[i] = uint64(block.timestamp - 2 minutes + (s >> 8) % 30 minutes);
            // Beacon from 30 s to about 11 min after close: in and out of bounds.
            uint256 bt = uint256(closes[i]) + 30 + (s >> 40) % 640;
            beacons[i] = uint64((bt - anchor.GENESIS() + anchor.PERIOD() - 1) / anchor.PERIOD() + 1);
            qs[i] = keccak256(abi.encode("q", s));
            cs[i] = keccak256(abi.encode("c", s));
        }
        vm.recordLogs();
        vm.prank(anchorer);
        anchor.lock(ks, closes, beacons, qs, cs);
        _tally(vm.getRecordedLogs());
    }

    function commitBatch(uint256 seed) external {
        calls["commit"]++;
        uint256 n = 1 + seed % 5;
        bytes32[] memory ks = new bytes32[](n);
        bytes32[] memory roots = new bytes32[](n);
        uint32[] memory counts = new uint32[](n);
        uint64[] memory stakes = new uint64[](n);
        for (uint256 i; i < n; i++) {
            uint256 s = uint256(keccak256(abi.encode(seed, i, "commit")));
            ks[i] = keys[s % POOL];
            roots[i] = s % 7 == 0 ? bytes32(0) : keccak256(abi.encode("root", s));
            counts[i] = uint32(s >> 8);
            stakes[i] = uint64(s >> 40);
        }
        vm.recordLogs();
        vm.prank(anchorer);
        anchor.commit(ks, roots, counts, stakes);
        _tally(vm.getRecordedLogs());
    }

    /// @dev Calls `anchorManifest`, expecting a revert exactly when the model says the call is invalid.
    function anchorManifest(uint256 seed) external {
        calls["manifest"]++;
        bytes32 key = keys[seed % POOL];
        bytes32 m = keccak256(abi.encode("manifest", seed));
        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(key);
        bool valid = a.lockedAt != 0 && a.manifestAnchoredAt == 0 && block.timestamp >= anchor.beaconTime(a.beaconRound);
        vm.recordLogs();
        vm.prank(anchorer);
        if (!valid) vm.expectRevert();
        anchor.anchorManifest(key, m);
        _tally(vm.getRecordedLogs());
    }

    function warp(uint256 dt) external {
        calls["warp"]++;
        vm.warp(block.timestamp + bound(dt, 1, 4 minutes)); // short steps, so commit windows get hit
    }

    // ---------------------------------------------------------------- internals

    function _tally(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; i++) {
            bytes32 t = logs[i].topics[0];
            uint256 kind;
            if (t == IFlockedAnchor.Locked.selector) kind = 0;
            else if (t == IFlockedAnchor.Committed.selector) kind = 1;
            else if (t == IFlockedAnchor.ManifestAnchored.selector) kind = 2;
            else continue;
            bytes32 key = logs[i].topics[1];
            if (++_writes[key][kind] == 1) firstWrite[key][kind] = _snapshot(key, kind);
        }
    }

    /// @notice The stored fields of one kind, hashed.
    function _snapshot(bytes32 key, uint256 kind) public view returns (bytes32) {
        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(key);
        if (kind == 0) {
            return keccak256(abi.encode(a.closesAt, a.beaconRound, a.lockedAt, a.questionHash, a.configHash));
        }
        if (kind == 1) return keccak256(abi.encode(a.committedAt, a.commitmentRoot, a.entryCount, a.totalStake));
        return keccak256(abi.encode(a.manifestAnchoredAt, a.manifestHash));
    }
}

/// @notice CON-9 invariant: each round key is written at most once per kind, the first write is never changed, and
///         every stored write sits inside its time window.
contract AnchorInvariantTest is StdInvariant, AnchorBase {
    AnchorHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new AnchorHandler(anchor, anchorer);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = AnchorHandler.lockBatch.selector;
        selectors[1] = AnchorHandler.commitBatch.selector;
        selectors[2] = AnchorHandler.anchorManifest.selector;
        selectors[3] = AnchorHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Each round key is written at most once per kind, and what was written first is still stored.
    function invariant_eachKeyWrittenAtMostOncePerKind() public view {
        for (uint256 i; i < handler.POOL(); i++) {
            bytes32 key = handler.keys(i);
            for (uint256 kind; kind < 3; kind++) {
                uint256 w = handler.writes(key, kind);
                assertLe(w, 1, "written twice");
                if (w == 1) assertEq(handler._snapshot(key, kind), handler.firstWrite(key, kind), "overwritten");
                else assertEq(handler._snapshot(key, kind), _emptySnapshot(kind), "written without an event");
            }
        }
    }

    /// @notice Every stored write respects the beacon bounds and its window: lock before close, commitment in
    ///         `[closesAt, beaconTime)`, manifest at or after the beacon; commitments and manifests need a lock.
    function invariant_writesInsideWindows() public view {
        for (uint256 i; i < handler.POOL(); i++) {
            IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(handler.keys(i));
            if (a.lockedAt == 0) {
                assertEq(a.committedAt, 0);
                assertEq(a.manifestAnchoredAt, 0);
                continue;
            }
            uint256 bt = anchor.beaconTime(a.beaconRound);
            assertLt(a.lockedAt, a.closesAt);
            assertGe(bt, uint256(a.closesAt) + anchor.MIN_BEACON_DELAY());
            assertLe(bt, uint256(a.closesAt) + anchor.MAX_BEACON_DELAY());
            if (a.committedAt != 0) {
                assertGe(a.committedAt, a.closesAt);
                assertLt(a.committedAt, bt);
            }
            if (a.manifestAnchoredAt != 0) assertGe(a.manifestAnchoredAt, bt);
        }
    }

    function _emptySnapshot(uint256 kind) internal pure returns (bytes32) {
        if (kind == 0) return keccak256(abi.encode(uint64(0), uint64(0), uint64(0), bytes32(0), bytes32(0)));
        if (kind == 1) return keccak256(abi.encode(uint64(0), bytes32(0), uint32(0), uint64(0)));
        return keccak256(abi.encode(uint64(0), bytes32(0)));
    }

    /// @dev Debug aid: `forge test --mc AnchorInvariantTest -vv` prints how many writes a run made.
    function afterInvariant() external view {
        uint256[3] memory total;
        for (uint256 i; i < handler.POOL(); i++) {
            for (uint256 kind; kind < 3; kind++) {
                total[kind] += handler.writes(handler.keys(i), kind);
            }
        }
        console.log("locks", total[0], "commits", total[1]);
        console.log("manifests", total[2]);
    }
}
