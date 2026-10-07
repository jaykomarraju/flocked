// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin-contracts/access/IAccessControl.sol";

import {FlockedAnchor} from "../src/FlockedAnchor.sol";
import {IFlockedAnchor} from "../src/interfaces/IFlockedAnchor.sol";
import {AnchorBase} from "./AnchorBase.t.sol";

/// @notice CON-9: write-once lock, commitment and manifest per round key; the commitment window
///         `closesAt <= now < beaconTime` and the manifest after the beacon; skip-and-emit for invalid batch items.
contract AnchorTest is AnchorBase {
    // ---------------------------------------------------------------- constructor and keys

    function test_constructor_setsRolesAndParams() public {
        assertTrue(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(anchor.hasRole(anchor.ANCHOR_ROLE(), anchorer));
        assertFalse(anchor.hasRole(anchor.ANCHOR_ROLE(), admin));
        assertEq(anchor.getRoleAdmin(anchor.ANCHOR_ROLE()), anchor.DEFAULT_ADMIN_ROLE());
        assertEq(anchor.receiptSigner(), receiptSigner);
        assertEq(anchor.GENESIS(), GENESIS);
        assertEq(anchor.PERIOD(), PERIOD);
        assertEq(anchor.MIN_BEACON_DELAY(), 60);
        assertEq(anchor.MAX_BEACON_DELAY(), 600);

        // The receipt signer's history starts at deployment.
        vm.expectEmit(false, false, false, true);
        emit IFlockedAnchor.ReceiptSignerSet(receiptSigner, uint64(block.timestamp));
        new FlockedAnchor(admin, anchorer, receiptSigner, GENESIS, PERIOD);

        // A zero receipt signer starts with receipts disabled.
        FlockedAnchor disabled = new FlockedAnchor(admin, anchorer, address(0), GENESIS, PERIOD);
        assertEq(disabled.receiptSigner(), address(0));
    }

    function test_constructor_rejectsZeroValues() public {
        vm.expectRevert(IFlockedAnchor.ZeroAddress.selector);
        new FlockedAnchor(address(0), anchorer, receiptSigner, GENESIS, PERIOD);
        vm.expectRevert(IFlockedAnchor.ZeroAddress.selector);
        new FlockedAnchor(admin, address(0), receiptSigner, GENESIS, PERIOD);
        vm.expectRevert(IFlockedAnchor.InvalidDrandParams.selector);
        new FlockedAnchor(admin, anchorer, receiptSigner, 0, PERIOD);
        vm.expectRevert(IFlockedAnchor.InvalidDrandParams.selector);
        new FlockedAnchor(admin, anchorer, receiptSigner, GENESIS, 0);
    }

    function test_roundKey_isAbiEncodedIdAndMode() public view {
        bytes16 id = bytes16(keccak256("round"));
        assertEq(anchor.roundKey(id, 0), keccak256(abi.encode(id, uint8(0))));
        assertEq(anchor.roundKey(id, 1), keccak256(abi.encode(id, uint8(1))));
        assertTrue(anchor.roundKey(id, 0) != anchor.roundKey(id, 1));
    }

    function test_beaconTime() public {
        assertEq(anchor.beaconTime(1), GENESIS);
        assertEq(anchor.beaconTime(1000), GENESIS + 999 * PERIOD);
        vm.expectRevert(IFlockedAnchor.InvalidBeaconRound.selector);
        anchor.beaconTime(0);
    }

    // ---------------------------------------------------------------- lock

    function test_lock_writesOnceAndEmits() public {
        Item memory it = _item(0);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Locked(it.key, it.closesAt, it.beaconRound, it.questionHash, it.configHash);
        _lock(it);

        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(it.key);
        assertEq(a.closesAt, it.closesAt);
        assertEq(a.beaconRound, it.beaconRound);
        assertEq(a.lockedAt, block.timestamp);
        assertEq(a.questionHash, it.questionHash);
        assertEq(a.configHash, it.configHash);
        assertEq(a.committedAt, 0);
        assertEq(a.manifestAnchoredAt, 0);

        // A second lock for the key, with different values, is skipped and changes nothing.
        Item memory again = _item(7);
        again.key = it.key;
        vm.warp(block.timestamp + 1);
        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(it.key, ALREADY_WRITTEN);
        _lock(again);
        assertEq(_count(vm.getRecordedLogs(), IFlockedAnchor.Locked.selector), 0);
        assertEq(keccak256(abi.encode(anchor.getAnchor(it.key))), keccak256(abi.encode(a)));
    }

    function test_lock_beaconBoundEdges() public {
        // Pick closesAt so that beaconTime(r) lands exactly on each edge.
        uint64 r = _beaconRoundAt(block.timestamp + 2 hours);
        uint256 bt = _beaconTime(r);
        uint64[4] memory closes = [
            uint64(bt - 60), // beacon exactly MIN_BEACON_DELAY after close: valid
            uint64(bt - 600), // exactly MAX_BEACON_DELAY: valid
            uint64(bt - 59), // one second short of the minimum
            uint64(bt - 601) // one second past the maximum
        ];
        Item[] memory items = new Item[](5);
        for (uint256 i; i < 4; i++) {
            items[i] = _item(i);
            items[i].closesAt = closes[i];
            items[i].beaconRound = r;
        }
        items[4] = _item(4);
        items[4].beaconRound = 0; // drand has no round 0

        vm.recordLogs();
        _lock(items);
        (bytes32[] memory keys, uint8[] memory reasons) = _skips(vm.getRecordedLogs());
        assertEq(keys.length, 3);
        assertEq(keys[0], items[2].key);
        assertEq(keys[1], items[3].key);
        assertEq(keys[2], items[4].key);
        for (uint256 i; i < 3; i++) {
            assertEq(reasons[i], BEACON_BOUNDS);
        }
        assertGt(anchor.getAnchor(items[0].key).lockedAt, 0);
        assertGt(anchor.getAnchor(items[1].key).lockedAt, 0);
        for (uint256 i = 2; i < 5; i++) {
            assertEq(anchor.getAnchor(items[i].key).lockedAt, 0);
        }
    }

    function test_lock_onlyBeforeClose() public {
        Item memory it = _item(0);
        vm.warp(it.closesAt);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(it.key, OUTSIDE_WINDOW);
        _lock(it);
        assertEq(anchor.getAnchor(it.key).lockedAt, 0);

        vm.warp(it.closesAt - 1);
        _lock(it);
        assertEq(anchor.getAnchor(it.key).lockedAt, it.closesAt - 1);
    }

    function test_lock_skipReasonOrder() public {
        // Already written beats every other reason; beacon bounds beat the close-time window.
        Item memory it = _item(0);
        _lock(it);
        Item memory bad = it;
        bad.beaconRound = 0;
        vm.warp(it.closesAt);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(it.key, ALREADY_WRITTEN);
        _lock(bad);

        Item memory late = _item(1);
        late.closesAt = uint64(block.timestamp); // closed, and its beacon is long past
        late.beaconRound = 1;
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(late.key, BEACON_BOUNDS);
        _lock(late);
    }

    function test_lock_mixedBatchAppliesValidItemsInOrder() public {
        Item memory pre = _item(9);
        _lock(pre);

        Item[] memory items = new Item[](6);
        items[0] = _item(0); // valid
        items[1] = pre; // already locked
        items[2] = _item(2);
        items[2].beaconRound = items[2].beaconRound + 400; // beacon 20 min after close
        items[3] = _item(3);
        items[3].closesAt = uint64(block.timestamp); // already closed
        items[3].beaconRound = _beaconRoundAt(block.timestamp + 2 minutes);
        items[4] = _item(4); // valid
        items[5] = _item(4); // same key again in the same batch
        items[5].questionHash = keccak256("other");

        vm.recordLogs();
        _lock(items);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, IFlockedAnchor.Locked.selector), 2);
        (bytes32[] memory keys, uint8[] memory reasons) = _skips(logs);
        assertEq(keys.length, 4);
        (bytes32[4] memory wantKeys, uint8[4] memory wantReasons) = (
            [items[1].key, items[2].key, items[3].key, items[5].key],
            [ALREADY_WRITTEN, BEACON_BOUNDS, OUTSIDE_WINDOW, ALREADY_WRITTEN]
        );
        for (uint256 i; i < 4; i++) {
            assertEq(keys[i], wantKeys[i]);
            assertEq(reasons[i], wantReasons[i]);
        }
        assertGt(anchor.getAnchor(items[0].key).lockedAt, 0);
        assertEq(anchor.getAnchor(items[4].key).questionHash, items[4].questionHash); // the first one won
        assertEq(anchor.getAnchor(items[2].key).lockedAt, 0);
        assertEq(anchor.getAnchor(items[3].key).lockedAt, 0);
    }

    function test_lock_lengthMismatchRevertsWholeCall() public {
        bytes32[] memory k2 = new bytes32[](2);
        (k2[0], k2[1]) = (_key(0), _key(1));
        uint64[] memory u2 = new uint64[](2);
        uint64[] memory u1 = new uint64[](1);
        bytes32[] memory b2 = new bytes32[](2);
        bytes32[] memory b1 = new bytes32[](1);
        Item memory it = _item(0);
        (u2[0], u2[1]) = (it.closesAt, it.closesAt);
        uint64[] memory r2 = new uint64[](2);
        (r2[0], r2[1]) = (it.beaconRound, it.beaconRound);

        vm.startPrank(anchorer);
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.lock(k2, u1, r2, b2, b2);
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.lock(k2, u2, u1, b2, b2);
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.lock(k2, u2, r2, b1, b2);
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.lock(k2, u2, r2, b2, b1);
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.lock(new bytes32[](3), u2, r2, b2, b2);
        // Nothing was written, and the same arrays with matching lengths lock both keys.
        assertEq(anchor.getAnchor(k2[0]).lockedAt, 0);
        anchor.lock(k2, u2, r2, b2, b2);
        vm.stopPrank();
        assertGt(anchor.getAnchor(k2[1]).lockedAt, 0);
    }

    function test_lock_emptyBatchIsANoOp() public {
        vm.recordLogs();
        vm.prank(anchorer);
        anchor.lock(new bytes32[](0), new uint64[](0), new uint64[](0), new bytes32[](0), new bytes32[](0));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    // ---------------------------------------------------------------- commit

    function test_commit_windowEdges() public {
        Item[] memory items = new Item[](4);
        for (uint256 i; i < 4; i++) {
            items[i] = _item(i);
        }
        _lock(items);
        uint256 closesAt = items[0].closesAt;
        uint256 bt = _beaconTime(items[0].beaconRound);

        vm.warp(closesAt - 1);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(items[0].key, OUTSIDE_WINDOW);
        _commit(items[0].key, keccak256("root0"), 10, 100);
        assertEq(anchor.getAnchor(items[0].key).committedAt, 0);

        vm.warp(closesAt); // first valid second
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Committed(items[0].key, keccak256("root0"), 10, 100);
        _commit(items[0].key, keccak256("root0"), 10, 100);

        vm.warp(bt - 1); // last valid second
        _commit(items[1].key, keccak256("root1"), 11, 110);

        vm.warp(bt); // a block stamped at the beacon time is rejected
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(items[2].key, OUTSIDE_WINDOW);
        _commit(items[2].key, keccak256("root2"), 12, 120);

        vm.warp(bt + 1 days);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(items[3].key, OUTSIDE_WINDOW);
        _commit(items[3].key, keccak256("root3"), 13, 130);

        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(items[1].key);
        assertEq(a.committedAt, bt - 1);
        assertEq(a.commitmentRoot, keccak256("root1"));
        assertEq(a.entryCount, 11);
        assertEq(a.totalStake, 110);
        assertEq(anchor.getAnchor(items[2].key).committedAt, 0);
        assertEq(anchor.getAnchor(items[3].key).committedAt, 0);
    }

    function test_commit_requiresLock() public {
        bytes32 key = _key(0);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(key, NOT_LOCKED);
        _commit(key, keccak256("root"), 1, 1);
        assertEq(anchor.getAnchor(key).committedAt, 0);
    }

    function test_commit_writesOnce() public {
        Item memory it = _item(0);
        _lock(it);
        vm.warp(it.closesAt);
        _commit(it.key, keccak256("root"), 5, 50);
        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(it.key);

        vm.warp(it.closesAt + 1);
        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(it.key, ALREADY_WRITTEN);
        _commit(it.key, keccak256("other"), 6, 60);
        assertEq(_count(vm.getRecordedLogs(), IFlockedAnchor.Committed.selector), 0);
        assertEq(keccak256(abi.encode(anchor.getAnchor(it.key))), keccak256(abi.encode(a)));
    }

    function test_commit_zeroRootStillCountsAsWritten() public {
        Item memory it = _item(0);
        _lock(it);
        vm.warp(it.closesAt);
        _commit(it.key, bytes32(0), 0, 0);
        assertEq(anchor.getAnchor(it.key).committedAt, it.closesAt);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.Skipped(it.key, ALREADY_WRITTEN);
        _commit(it.key, keccak256("late"), 1, 1);
    }

    function test_commit_mixedBatch() public {
        Item[] memory items = new Item[](2);
        items[0] = _item(0);
        items[1] = _item(1);
        items[1].closesAt = items[0].closesAt + 30 minutes; // still open when the first commits
        items[1].beaconRound = _beaconRoundAt(uint256(items[1].closesAt) + 2 minutes);
        _lock(items);
        vm.warp(items[0].closesAt);
        _commit(items[0].key, keccak256("done"), 1, 1);

        uint256 n = 5;
        bytes32[] memory keys = new bytes32[](n);
        bytes32[] memory roots = new bytes32[](n);
        uint32[] memory counts = new uint32[](n);
        uint64[] memory stakes = new uint64[](n);
        Item memory fresh = _item(2);
        fresh.closesAt = uint64(block.timestamp + 1); // locked now, closes in a second
        fresh.beaconRound = _beaconRoundAt(block.timestamp + 2 minutes);
        _lock(fresh);
        vm.warp(block.timestamp + 1);
        keys[0] = fresh.key; // valid
        keys[1] = items[0].key; // already committed
        keys[2] = _key(99); // never locked
        keys[3] = items[1].key; // not closed yet
        keys[4] = fresh.key; // duplicate within the batch
        for (uint256 i; i < n; i++) {
            (roots[i], counts[i], stakes[i]) = (keccak256(abi.encode(i)), uint32(i), uint64(i * 10));
        }

        vm.recordLogs();
        vm.prank(anchorer);
        anchor.commit(keys, roots, counts, stakes);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, IFlockedAnchor.Committed.selector), 1);
        (bytes32[] memory sk, uint8[] memory sr) = _skips(logs);
        assertEq(sk.length, 4);
        uint8[4] memory want = [ALREADY_WRITTEN, NOT_LOCKED, OUTSIDE_WINDOW, ALREADY_WRITTEN];
        for (uint256 i; i < 4; i++) {
            assertEq(sk[i], keys[i + 1]);
            assertEq(sr[i], want[i]);
        }
        assertEq(anchor.getAnchor(fresh.key).commitmentRoot, roots[0]);
        assertEq(anchor.getAnchor(items[0].key).commitmentRoot, keccak256("done"));
        assertEq(anchor.getAnchor(items[1].key).committedAt, 0);
    }

    function test_commit_lengthMismatchRevertsWholeCall() public {
        Item memory it = _item(0);
        _lock(it);
        vm.warp(it.closesAt);
        bytes32[] memory k1 = new bytes32[](1);
        k1[0] = it.key;
        vm.startPrank(anchorer);
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.commit(k1, new bytes32[](2), new uint32[](1), new uint64[](1));
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.commit(k1, new bytes32[](1), new uint32[](0), new uint64[](1));
        vm.expectRevert(IFlockedAnchor.LengthMismatch.selector);
        anchor.commit(k1, new bytes32[](1), new uint32[](1), new uint64[](2));
        vm.stopPrank();
        assertEq(anchor.getAnchor(it.key).committedAt, 0);
    }

    // ---------------------------------------------------------------- anchorManifest

    function test_anchorManifest_onlyAtOrAfterBeaconAndOnce() public {
        Item memory it = _item(0);
        _lock(it);
        uint256 bt = _beaconTime(it.beaconRound);
        bytes32 m = keccak256("manifest");

        vm.warp(bt - 1);
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.BeaconNotReached.selector, it.key, bt));
        anchor.anchorManifest(it.key, m);

        // No commitment is needed: a Free mode refunded for a missing commitment still gets its manifest.
        vm.warp(bt);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit IFlockedAnchor.ManifestAnchored(it.key, m);
        vm.prank(anchorer);
        anchor.anchorManifest(it.key, m);
        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(it.key);
        assertEq(a.manifestHash, m);
        assertEq(a.manifestAnchoredAt, bt);
        assertEq(a.committedAt, 0);

        vm.warp(bt + 1);
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.ManifestAlreadyAnchored.selector, it.key));
        anchor.anchorManifest(it.key, keccak256("other"));
        assertEq(anchor.getAnchor(it.key).manifestHash, m);
    }

    function test_anchorManifest_requiresLockAndNonZeroHash() public {
        Item memory it = _item(0);
        vm.startPrank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.NotLocked.selector, it.key));
        anchor.anchorManifest(it.key, keccak256("m"));
        vm.stopPrank();
        _lock(it);
        vm.warp(_beaconTime(it.beaconRound));
        vm.prank(anchorer);
        vm.expectRevert(IFlockedAnchor.ZeroManifestHash.selector);
        anchor.anchorManifest(it.key, bytes32(0));
    }

    function test_fullLifecycle_eachKindOncePerKey() public {
        Item memory it = _item(0);
        _lock(it);
        vm.warp(it.closesAt + 10);
        _commit(it.key, keccak256("root"), 3, 30);
        vm.warp(_beaconTime(it.beaconRound) + 5);
        vm.prank(anchorer);
        anchor.anchorManifest(it.key, keccak256("manifest"));

        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(it.key);
        assertEq(a.lockedAt, START);
        assertEq(a.committedAt, it.closesAt + 10);
        assertEq(a.manifestAnchoredAt, _beaconTime(it.beaconRound) + 5);

        // Every kind is now written; every further write is skipped or reverts, and nothing changes.
        _lock(it);
        _commit(it.key, keccak256("root2"), 4, 40);
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.ManifestAlreadyAnchored.selector, it.key));
        anchor.anchorManifest(it.key, keccak256("manifest2"));
        assertEq(keccak256(abi.encode(anchor.getAnchor(it.key))), keccak256(abi.encode(a)));
    }

    // ---------------------------------------------------------------- access

    function test_anchorFunctions_onlyAnchorRole() public {
        bytes32 role = anchor.ANCHOR_ROLE();
        bytes32 key = _key(0);
        bytes memory err = abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, role);
        vm.startPrank(admin);
        vm.expectRevert(err);
        anchor.lock(new bytes32[](0), new uint64[](0), new uint64[](0), new bytes32[](0), new bytes32[](0));
        vm.expectRevert(err);
        anchor.commit(new bytes32[](0), new bytes32[](0), new uint32[](0), new uint64[](0));
        vm.expectRevert(err);
        anchor.anchorManifest(key, keccak256("m"));
        vm.stopPrank();
    }
}
