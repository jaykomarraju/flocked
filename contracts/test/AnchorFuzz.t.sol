// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Test.sol";

import {IFlockedAnchor} from "../src/interfaces/IFlockedAnchor.sol";
import {AnchorBase} from "./AnchorBase.t.sol";

/// @notice CON-9 fuzz: every lock, commit and manifest outcome matches a reference model of the beacon bounds, the
///         time windows and write-once, including mixed batches with repeated keys.
contract AnchorFuzzTest is AnchorBase {
    uint256 internal constant POOL = 4;

    /// @dev A beacon round near `closesAt`: from a little before it to well past MAX_BEACON_DELAY, or zero.
    function _beaconNear(uint256 closesAt, uint256 seed) internal pure returns (uint64) {
        if (seed % 16 == 0) return 0;
        int256 r = int256(uint256(_beaconRoundAt(closesAt))) + int256(seed % 260) - 10;
        return r < 1 ? 1 : uint64(uint256(r));
    }

    function _bounds(uint256 closesAt, uint64 r) internal pure returns (bool) {
        if (r == 0) return false;
        uint256 bt = _beaconTime(r);
        return bt >= closesAt + 60 && bt <= closesAt + 600;
    }

    function testFuzz_lock_matchesModel(uint256 closeSeed, uint256 beaconSeed) public {
        Item memory it = _item(0);
        it.closesAt = uint64(bound(closeSeed, START - 1 days, START + 2 days));
        it.beaconRound = _beaconNear(it.closesAt, beaconSeed);

        uint8 want;
        if (!_bounds(it.closesAt, it.beaconRound)) want = BEACON_BOUNDS;
        else if (block.timestamp >= it.closesAt) want = OUTSIDE_WINDOW;

        vm.recordLogs();
        _lock(it);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (, uint8[] memory reasons) = _skips(logs);
        if (want == 0) {
            assertEq(reasons.length, 0);
            assertEq(_count(logs, IFlockedAnchor.Locked.selector), 1);
            assertEq(anchor.getAnchor(it.key).lockedAt, block.timestamp);
        } else {
            assertEq(reasons.length, 1);
            assertEq(reasons[0], want);
            assertEq(anchor.getAnchor(it.key).lockedAt, 0);
        }
    }

    function testFuzz_commit_window(uint256 beaconSeed, uint256 t) public {
        Item memory it = _item(0);
        it.beaconRound = _beaconRoundAt(uint256(it.closesAt) + 60 + beaconSeed % 539); // beacon time <= close + 600
        _lock(it);
        uint256 bt = _beaconTime(it.beaconRound);
        t = bound(t, block.timestamp, bt + 1 hours);
        vm.warp(t);

        _commit(it.key, keccak256(abi.encode(t)), 3, 30);
        bool inWindow = it.closesAt <= t && t < bt;
        assertEq(anchor.getAnchor(it.key).committedAt, inWindow ? t : 0);
    }

    function testFuzz_anchorManifest_window(uint256 t) public {
        Item memory it = _item(0);
        _lock(it);
        uint256 bt = _beaconTime(it.beaconRound);
        t = bound(t, block.timestamp, bt + 1 days);
        vm.warp(t);
        vm.prank(anchorer);
        if (t < bt) vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.BeaconNotReached.selector, it.key, bt));
        anchor.anchorManifest(it.key, keccak256("m"));
        assertEq(anchor.getAnchor(it.key).manifestAnchoredAt, t < bt ? 0 : t);
    }

    /// @dev Random lock batches over a small key pool, then a random commit batch; each item's outcome (written, or
    ///      skipped with the right reason, in order) matches the model.
    function testFuzz_batches_matchModel(uint256 seed) public {
        uint256 n = 1 + seed % 10;
        Item[] memory items = new Item[](n);
        bool[POOL] memory locked;
        uint8[] memory want = new uint8[](n);
        for (uint256 i; i < n; i++) {
            uint256 s = uint256(keccak256(abi.encode(seed, i)));
            uint256 k = s % POOL;
            items[i] = _item(k);
            items[i].closesAt = uint64(block.timestamp - 5 minutes + (s >> 8) % 2 hours);
            items[i].beaconRound = _beaconNear(items[i].closesAt, s >> 32);
            if (locked[k]) {
                want[i] = ALREADY_WRITTEN;
            } else if (!_bounds(items[i].closesAt, items[i].beaconRound)) {
                want[i] = BEACON_BOUNDS;
            } else if (block.timestamp >= items[i].closesAt) {
                want[i] = OUTSIDE_WINDOW;
            } else {
                locked[k] = true;
            }
        }
        vm.recordLogs();
        _lock(items);
        _checkSkips(vm.getRecordedLogs(), items, want);

        // Commit a batch of every pool key at a random time.
        uint256 t = block.timestamp + (seed >> 128) % 3 hours;
        vm.warp(t);
        bytes32[] memory keys = new bytes32[](POOL + 1);
        uint8[] memory cWant = new uint8[](POOL + 1);
        for (uint256 i; i <= POOL; i++) {
            uint256 k = i % POOL; // the last item repeats key 0
            keys[i] = _key(k);
            IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(keys[i]);
            if (i == POOL && cWant[0] == 0 && locked[0]) cWant[i] = ALREADY_WRITTEN;
            else if (!locked[k]) cWant[i] = NOT_LOCKED;
            else if (t < a.closesAt || t >= _beaconTime(a.beaconRound)) cWant[i] = OUTSIDE_WINDOW;
        }
        vm.recordLogs();
        vm.prank(anchorer);
        anchor.commit(keys, new bytes32[](POOL + 1), new uint32[](POOL + 1), new uint64[](POOL + 1));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bytes32[] memory sk, uint8[] memory sr) = _skips(logs);
        uint256 j;
        uint256 written;
        for (uint256 i; i <= POOL; i++) {
            if (cWant[i] == 0) {
                written++;
                continue;
            }
            assertEq(sk[j], keys[i]);
            assertEq(sr[j], cWant[i]);
            j++;
        }
        assertEq(sk.length, j);
        assertEq(_count(logs, IFlockedAnchor.Committed.selector), written);
    }

    function _checkSkips(Vm.Log[] memory logs, Item[] memory items, uint8[] memory want) internal view {
        (bytes32[] memory sk, uint8[] memory sr) = _skips(logs);
        uint256 j;
        uint256 written;
        for (uint256 i; i < items.length; i++) {
            if (want[i] == 0) {
                written++;
                continue;
            }
            assertEq(sk[j], items[i].key);
            assertEq(sr[j], want[i]);
            j++;
        }
        assertEq(sk.length, j);
        assertEq(_count(logs, IFlockedAnchor.Locked.selector), written);
    }

    function testFuzz_lengthMismatch_reverts(uint8 a, uint8 b) public {
        uint256 na = a % 6;
        uint256 nb = b % 6;
        vm.assume(na != nb);
        vm.startPrank(anchorer);
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.commit(new bytes32[](na), new bytes32[](na), new uint32[](nb), new uint64[](na));
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.lock(new bytes32[](na), new uint64[](na), new uint64[](na), new bytes32[](nb), new bytes32[](na));
        vm.stopPrank();
    }
}
