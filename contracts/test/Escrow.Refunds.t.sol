// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFlockedEscrow} from "../src/interfaces/IFlockedEscrow.sol";
import {EscrowBase} from "./utils/EscrowBase.sol";

/// @notice CON-3: `voidRound` only before close; `refundTooFew` only when `entryCount < minEntrants`; refund claims.
contract EscrowRefundsTest is EscrowBase {
    function _status(uint256 id) internal view returns (IFlockedEscrow.Status) {
        return escrow.getRound(id).status;
    }

    // ---------------------------------------------------------------- voidRound

    function test_voidRound_byOperatorBeforeOpen() public {
        uint256 id = _createDefault();
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.RoundRefunded(id, 4);
        vm.prank(operator);
        escrow.voidRound(id);
        assertEq(uint8(_status(id)), uint8(IFlockedEscrow.Status.Refunded));
        assertEq(escrow.getRound(id).refundReason, 4);
    }

    function test_voidRound_byGuardianJustBeforeClose() public {
        uint256 id = _createDefault();
        _warpOpen(id);
        address[] memory ps = _enterMany(id, 2);
        vm.warp(escrow.getRound(id).cfg.closesAt - 1);
        vm.prank(guardian);
        escrow.voidRound(id);
        assertEq(uint8(_status(id)), uint8(IFlockedEscrow.Status.Refunded));

        for (uint256 i; i < ps.length; i++) {
            vm.prank(ps[i]);
            escrow.claimRefund(id);
            assertEq(usdc.balanceOf(ps[i]), 5e6);
        }
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalObligations(), 0);
    }

    function test_voidRound_revertsAtOrAfterClose() public {
        uint256 id = _createDefault();
        vm.warp(escrow.getRound(id).cfg.closesAt);
        vm.prank(guardian);
        vm.expectRevert(IFlockedEscrow.RoundClosed.selector);
        escrow.voidRound(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        vm.expectRevert(IFlockedEscrow.RoundClosed.selector);
        escrow.voidRound(id);
    }

    function test_voidRound_revertsForOtherRoles() public {
        uint256 id = _createDefault();
        address[3] memory who = [admin, pauser, stranger];
        for (uint256 i; i < who.length; i++) {
            vm.prank(who[i]);
            vm.expectRevert(IFlockedEscrow.NotOperatorOrGuardian.selector);
            escrow.voidRound(id);
        }
    }

    // ---------------------------------------------------------------- refundTooFew

    function test_refundTooFew_afterCloseWithTooFew() public {
        uint256 id = _createDefault(); // minEntrants 3
        _warpOpen(id);
        address[] memory ps = _enterMany(id, 2);
        vm.warp(escrow.getRound(id).cfg.closesAt);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.RoundRefunded(id, 1);
        vm.prank(stranger);
        escrow.refundTooFew(id);
        assertEq(uint8(_status(id)), uint8(IFlockedEscrow.Status.Refunded));
        assertEq(escrow.getRound(id).refundReason, 1);

        vm.prank(ps[0]);
        escrow.claimRefund(id);
        assertEq(usdc.balanceOf(ps[0]), 5e6);
    }

    function test_refundTooFew_zeroEntries() public {
        uint256 id = _createDefault();
        vm.warp(escrow.getRound(id).cfg.closesAt);
        escrow.refundTooFew(id);
        assertEq(uint8(_status(id)), uint8(IFlockedEscrow.Status.Refunded));
    }

    function test_refundTooFew_revertsBeforeClose() public {
        uint256 id = _createDefault();
        vm.warp(escrow.getRound(id).cfg.closesAt - 1);
        vm.expectRevert(IFlockedEscrow.RoundNotClosed.selector);
        escrow.refundTooFew(id);
    }

    function test_refundTooFew_revertsWithEnoughEntrants() public {
        uint256 id = _createDefault();
        _warpOpen(id);
        _enterMany(id, 3);
        vm.warp(escrow.getRound(id).cfg.closesAt);
        vm.expectRevert(IFlockedEscrow.EnoughEntrants.selector);
        escrow.refundTooFew(id);
    }

    function test_refundTooFew_revertsWhenNotOpen() public {
        uint256 id = _createDefault();
        _warpOpen(id);
        _enterMany(id, 2);
        _warpBeacon(id);
        vm.prank(operator);
        escrow.propose(id, 1, 0, 1, bytes32(0), keccak256("b"));
        vm.expectRevert(
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, id, IFlockedEscrow.Status.RefundProposed)
        );
        escrow.refundTooFew(id);
    }

    // ---------------------------------------------------------------- claimRefund

    function test_claimRefund_paysStakeOnce() public {
        uint256 id = _createDefault();
        _warpOpen(id);
        address p = _enterNew(id);
        vm.prank(operator);
        escrow.voidRound(id);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IFlockedEscrow.RefundClaimed(id, p, 5e6);
        vm.prank(p);
        escrow.claimRefund(id);
        assertTrue(escrow.hasClaimed(id, p));
        assertEq(escrow.getRound(id).refundClaims, 1);

        vm.prank(p);
        vm.expectRevert(IFlockedEscrow.AlreadyClaimed.selector);
        escrow.claimRefund(id);
    }

    function test_claimRefund_revertsForNonEntrant() public {
        uint256 id = _createDefault();
        vm.prank(operator);
        escrow.voidRound(id);
        vm.prank(stranger);
        vm.expectRevert(IFlockedEscrow.NotEntrant.selector);
        escrow.claimRefund(id);
    }

    function test_claimRefund_revertsOnOpenRound() public {
        uint256 id = _createDefault();
        _warpOpen(id);
        address p = _enterNew(id);
        vm.prank(p);
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, id, IFlockedEscrow.Status.Open));
        escrow.claimRefund(id);
    }

    function test_claimRefund_finalizesDueRefundProposal() public {
        uint256 id = _createDefault();
        _warpOpen(id);
        address[] memory ps = _enterMany(id, 4);
        _warpBeacon(id);
        vm.prank(operator);
        escrow.propose(id, 2, 2, 0, bytes32(0), keccak256("b")); // tie: reason 3

        vm.prank(ps[0]);
        vm.expectRevert(
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, id, IFlockedEscrow.Status.RefundProposed)
        );
        escrow.claimRefund(id);

        _warpClaimsOpen(id);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.RoundFinalized(id, IFlockedEscrow.Status.Refunded);
        vm.prank(ps[0]);
        escrow.claimRefund(id);
        assertEq(uint8(_status(id)), uint8(IFlockedEscrow.Status.Refunded));
        assertEq(escrow.getRound(id).refundReason, 3);
        assertEq(usdc.balanceOf(ps[0]), 5e6);
    }

    function test_claimRefund_paysVoidEntrantsToo() public {
        // After a refund proposal every entrant, VOID or not, gets the stake back.
        uint256 id = _createDefault();
        _warpOpen(id);
        address[] memory ps = _enterMany(id, 3);
        _warpBeacon(id);
        vm.prank(operator);
        escrow.propose(id, 0, 1, 2, bytes32(0), keccak256("b")); // too few valid: reason 1
        _warpClaimsOpen(id);
        for (uint256 i; i < 3; i++) {
            vm.prank(ps[i]);
            escrow.claimRefund(id);
        }
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.getRound(id).refundClaims, 3);
    }
}
