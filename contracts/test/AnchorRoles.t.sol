// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin-contracts/access/IAccessControl.sol";

import {IFlockedAnchor} from "../src/interfaces/IFlockedAnchor.sol";
import {AnchorBase} from "./AnchorBase.t.sol";

/// @notice Anchor roles and timelocks, mirroring the escrow (P1.3): receipt-signer changes and ANCHOR_ROLE grants
///         wait 72 hours; revocation and disabling the receipt signer are immediate.
contract AnchorRolesTest is AnchorBase {
    address internal newAnchorer = makeAddr("newAnchorer");
    address internal newSigner = makeAddr("newSigner");

    function _id(bytes32 action, address account) internal view returns (bytes32) {
        return anchor.operationId(action, abi.encode(account));
    }

    // ---------------------------------------------------------------- ANCHOR_ROLE

    function test_anchorGrant_requiresTimelock() public {
        bytes32 role = anchor.ANCHOR_ROLE();
        bytes32 action = anchor.ACTION_ANCHOR_GRANT();
        bytes32 opId = _id(action, newAnchorer);

        vm.startPrank(admin);
        vm.expectRevert(IFlockedAnchor.TimelockRequired.selector);
        anchor.grantRole(role, newAnchorer);
        vm.expectRevert(IFlockedAnchor.ZeroAddress.selector);
        anchor.scheduleAnchorGrant(address(0));

        uint256 readyAt = block.timestamp + 72 hours;
        vm.expectEmit(true, true, false, true, address(anchor));
        emit IFlockedAnchor.TimelockScheduled(opId, action, abi.encode(newAnchorer), readyAt);
        anchor.scheduleAnchorGrant(newAnchorer);
        assertEq(anchor.timelockReadyAt(opId), readyAt);
        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.AlreadyScheduled.selector, opId));
        anchor.scheduleAnchorGrant(newAnchorer);

        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.TimelockNotReady.selector, opId, readyAt));
        anchor.executeAnchorGrant(newAnchorer);
        vm.warp(readyAt);
        vm.expectEmit(true, true, false, true, address(anchor));
        emit IFlockedAnchor.TimelockExecuted(opId, action, abi.encode(newAnchorer));
        anchor.executeAnchorGrant(newAnchorer);
        assertTrue(anchor.hasRole(role, newAnchorer));
        assertEq(anchor.timelockReadyAt(opId), 0);

        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.NotScheduled.selector, opId));
        anchor.executeAnchorGrant(newAnchorer);
        vm.stopPrank();

        // The new anchorer can write.
        Item memory it = _item(0);
        it.closesAt = uint64(block.timestamp + 1 hours);
        it.beaconRound = _beaconRoundAt(uint256(it.closesAt) + 2 minutes);
        bytes32[] memory k = new bytes32[](1);
        uint64[] memory c = new uint64[](1);
        uint64[] memory r = new uint64[](1);
        bytes32[] memory h = new bytes32[](1);
        (k[0], c[0], r[0]) = (it.key, it.closesAt, it.beaconRound);
        vm.prank(newAnchorer);
        anchor.lock(k, c, r, h, h);
        assertGt(anchor.getAnchor(it.key).lockedAt, 0);
    }

    function test_anchorGrant_cancel() public {
        bytes32 action = anchor.ACTION_ANCHOR_GRANT();
        bytes32 opId = _id(action, newAnchorer);
        vm.startPrank(admin);
        anchor.scheduleAnchorGrant(newAnchorer);
        vm.expectEmit(true, true, false, true, address(anchor));
        emit IFlockedAnchor.TimelockCancelled(opId, action, abi.encode(newAnchorer));
        anchor.cancelAnchorGrant(newAnchorer);
        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.NotScheduled.selector, opId));
        anchor.cancelAnchorGrant(newAnchorer);
        vm.warp(block.timestamp + 72 hours);
        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.NotScheduled.selector, opId));
        anchor.executeAnchorGrant(newAnchorer);
        vm.stopPrank();
        assertFalse(anchor.hasRole(anchor.ANCHOR_ROLE(), newAnchorer));
    }

    function test_anchorRevocation_isImmediate() public {
        bytes32 role = anchor.ANCHOR_ROLE();
        vm.prank(admin);
        anchor.revokeRole(role, anchorer);
        vm.prank(anchorer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anchorer, role)
        );
        anchor.anchorManifest(bytes32(uint256(1)), keccak256("m"));
    }

    // ---------------------------------------------------------------- receipt signer

    function test_receiptSigner_rotationIsTimelocked() public {
        bytes32 action = anchor.ACTION_RECEIPT_SIGNER();
        bytes32 opId = _id(action, newSigner);
        vm.startPrank(admin);
        vm.expectRevert(IFlockedAnchor.TimelockRequired.selector);
        anchor.setReceiptSigner(newSigner);
        vm.expectRevert(IFlockedAnchor.ZeroAddress.selector);
        anchor.scheduleReceiptSigner(address(0));

        anchor.scheduleReceiptSigner(newSigner);
        uint256 readyAt = block.timestamp + 72 hours;
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.TimelockNotReady.selector, opId, readyAt));
        anchor.executeReceiptSigner(newSigner);
        assertEq(anchor.receiptSigner(), receiptSigner);

        vm.warp(readyAt);
        vm.expectEmit(false, false, false, true, address(anchor));
        emit IFlockedAnchor.ReceiptSignerSet(newSigner, uint64(readyAt));
        anchor.executeReceiptSigner(newSigner);
        vm.stopPrank();
        assertEq(anchor.receiptSigner(), newSigner);
    }

    function test_receiptSigner_disableIsImmediate() public {
        vm.expectEmit(false, false, false, true, address(anchor));
        emit IFlockedAnchor.ReceiptSignerSet(address(0), uint64(block.timestamp));
        vm.prank(admin);
        anchor.setReceiptSigner(address(0));
        assertEq(anchor.receiptSigner(), address(0));

        // Re-enabling goes through the timelock.
        vm.startPrank(admin);
        anchor.scheduleReceiptSigner(receiptSigner);
        vm.warp(block.timestamp + 72 hours);
        anchor.executeReceiptSigner(receiptSigner);
        vm.stopPrank();
        assertEq(anchor.receiptSigner(), receiptSigner);
    }

    function test_receiptSigner_cancel() public {
        vm.startPrank(admin);
        anchor.scheduleReceiptSigner(newSigner);
        anchor.cancelReceiptSigner(newSigner);
        vm.warp(block.timestamp + 72 hours);
        vm.expectRevert(
            abi.encodeWithSelector(IFlockedAnchor.NotScheduled.selector, _id(anchor.ACTION_RECEIPT_SIGNER(), newSigner))
        );
        anchor.executeReceiptSigner(newSigner);
        vm.stopPrank();
        assertEq(anchor.receiptSigner(), receiptSigner);
    }

    function test_adminFunctions_onlyAdmin() public {
        bytes32 adminRole = anchor.DEFAULT_ADMIN_ROLE();
        bytes32 anchorRole = anchor.ANCHOR_ROLE();
        bytes memory err =
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, anchorer, adminRole);
        vm.startPrank(anchorer);
        vm.expectRevert(err);
        anchor.setReceiptSigner(address(0));
        vm.expectRevert(err);
        anchor.scheduleReceiptSigner(newSigner);
        vm.expectRevert(err);
        anchor.executeReceiptSigner(newSigner);
        vm.expectRevert(err);
        anchor.cancelReceiptSigner(newSigner);
        vm.expectRevert(err);
        anchor.scheduleAnchorGrant(newAnchorer);
        vm.expectRevert(err);
        anchor.executeAnchorGrant(newAnchorer);
        vm.expectRevert(err);
        anchor.cancelAnchorGrant(newAnchorer);
        vm.expectRevert(err);
        anchor.revokeRole(anchorRole, anchorer);
        vm.stopPrank();
    }

    function test_otherRoles_grantImmediately() public {
        bytes32 adminRole = anchor.DEFAULT_ADMIN_ROLE();
        address admin2 = makeAddr("admin2");
        vm.prank(admin);
        anchor.grantRole(adminRole, admin2);
        assertTrue(anchor.hasRole(adminRole, admin2));
    }
}
