// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFlockedEscrow} from "../src/interfaces/IFlockedEscrow.sol";
import {EscrowBase} from "./utils/EscrowBase.sol";

/// @notice CON-5: the challenge window, veto in both directions, and `finalize`.
contract EscrowChallengeTest is EscrowBase {
    bytes32 internal constant EVIDENCE = keccak256("watcher mismatch report");

    function _status(uint256 id) internal view returns (IFlockedEscrow.Status) {
        return escrow.getRound(id).status;
    }

    // ---------------------------------------------------------------- veto a settlement

    function test_veto_settleProposalBecomesRefundedReason5() public {
        Fixture memory f = _proposed(2, 5, 1);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.ProposalVetoed(f.roundId, EVIDENCE);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.RoundRefunded(f.roundId, 5);
        vm.prank(guardian);
        escrow.veto(f.roundId, EVIDENCE);

        assertEq(uint8(_status(f.roundId)), uint8(IFlockedEscrow.Status.Refunded));
        assertEq(escrow.getRound(f.roundId).refundReason, 5);

        // Full refund to everyone, including the would-be winners and VOID entrants; no fees credited.
        _warpClaimsOpen(f.roundId);
        vm.prank(f.option0[0]);
        escrow.claimRefund(f.roundId);
        vm.prank(f.option1[0]);
        escrow.claimRefund(f.roundId);
        vm.prank(f.voids[0]);
        escrow.claimRefund(f.roundId);
        assertEq(usdc.balanceOf(f.option0[0]), 5e6);
        assertEq(escrow.withdrawable(treasury), 0);
        assertEq(escrow.withdrawable(creator), 0);

        // And no settlement claim is possible.
        bytes32[] memory p = _proof(f, f.option0[0], 0);
        vm.prank(f.option0[1]);
        vm.expectRevert(
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, f.roundId, IFlockedEscrow.Status.Refunded)
        );
        escrow.claim(f.roundId, IFlockedEscrow.Kind.Win, p);
    }

    function test_veto_lastSecondOfWindow() public {
        Fixture memory f = _proposed(2, 5, 0);
        vm.warp(escrow.getRound(f.roundId).claimsOpenAt - 1);
        vm.prank(guardian);
        escrow.veto(f.roundId, EVIDENCE);
        assertEq(uint8(_status(f.roundId)), uint8(IFlockedEscrow.Status.Refunded));
    }

    function test_veto_revertsAtClaimsOpenAt() public {
        Fixture memory f = _proposed(2, 5, 0);
        _warpClaimsOpen(f.roundId);
        vm.prank(guardian);
        vm.expectRevert(IFlockedEscrow.ChallengeWindowOver.selector);
        escrow.veto(f.roundId, EVIDENCE);
    }

    function test_veto_revertsOnOpenAndTerminalRounds() public {
        uint256 id = _createDefault();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, id, IFlockedEscrow.Status.Open));
        escrow.veto(id, EVIDENCE);

        Fixture memory f = _proposed(2, 5, 0);
        _warpClaimsOpen(f.roundId);
        escrow.finalize(f.roundId);
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, f.roundId, IFlockedEscrow.Status.Settled)
        );
        escrow.veto(f.roundId, EVIDENCE);
    }

    // ---------------------------------------------------------------- veto a refund proposal

    function test_veto_refundProposalReturnsToOpenAndCanBeReproposed() public {
        Fixture memory f = _populate(_cfg(), 2, 5, 1);
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, 4, 4, 0, bytes32(0), keccak256("wrong tie")); // a false tie

        vm.prank(guardian);
        escrow.veto(f.roundId, EVIDENCE);
        IFlockedEscrow.Round memory rd = escrow.getRound(f.roundId);
        assertEq(uint8(rd.status), uint8(IFlockedEscrow.Status.Open));
        assertEq(rd.refundReason, 0);
        assertEq(rd.claimsOpenAt, 0);
        assertEq(rd.bundleHash, bytes32(0));
        assertEq(rd.n0 + rd.n1 + rd.nVoid, 0);
        assertEq(rd.entryCount, 8, "entries kept");

        // Still closed to entries; the operator proposes again.
        vm.prank(operator);
        escrow.propose(f.roundId, 2, 5, 1, _root(f), keccak256("bundle"));
        assertEq(uint8(_status(f.roundId)), uint8(IFlockedEscrow.Status.SettleProposed));
    }

    function test_veto_refundProposalThenTimeoutBackstop() public {
        Fixture memory f = _populate(_cfg(), 2, 5, 0);
        uint256 closesAt = escrow.getRound(f.roundId).cfg.closesAt;
        vm.warp(closesAt + 72 hours - 1);
        vm.prank(operator);
        escrow.propose(f.roundId, 0, 7, 0, bytes32(0), keccak256("one-sided"));
        vm.prank(guardian);
        escrow.veto(f.roundId, EVIDENCE);

        vm.warp(closesAt + 72 hours);
        vm.prank(operator);
        vm.expectRevert(IFlockedEscrow.ProposalWindowClosed.selector);
        escrow.propose(f.roundId, 2, 5, 0, _root(f), keccak256("bundle"));
        escrow.refundTimeout(f.roundId);
        assertEq(escrow.getRound(f.roundId).refundReason, 6);
    }

    // ---------------------------------------------------------------- finalize

    function test_finalize_revertsDuringWindow() public {
        Fixture memory f = _proposed(2, 5, 0);
        vm.warp(escrow.getRound(f.roundId).claimsOpenAt - 1);
        vm.expectRevert(IFlockedEscrow.ChallengeWindowOpen.selector);
        escrow.finalize(f.roundId);
    }

    function test_finalize_settleCreditsTreasuryFeePlusDustAndCreatorFee() public {
        // cap 1 so a rebate and dust exist: s = 1e6, n0 = 1 winner, n1 = 9 losers.
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.capMultiple = 1;
        cfg.stake = 1e6;
        Fixture memory f = _populate(cfg, 1, 9, 0);
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, 1, 9, 0, _root(f), keccak256("bundle"));
        _warpClaimsOpen(f.roundId);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.RoundFinalized(f.roundId, IFlockedEscrow.Status.Settled);
        vm.prank(stranger);
        escrow.finalize(f.roundId);

        assertEq(uint8(_status(f.roundId)), uint8(IFlockedEscrow.Status.Settled));
        assertEq(escrow.withdrawable(treasury), 450_000 + 8);
        assertEq(escrow.withdrawable(creator), 90_000);
        assertEq(usdc.balanceOf(address(escrow)), 10e6, "nothing paid at finalize");

        vm.expectRevert(
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, f.roundId, IFlockedEscrow.Status.Settled)
        );
        escrow.finalize(f.roundId);
    }

    function test_finalize_creatorIsTreasuryAccumulates() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.creator = treasury;
        Fixture memory f = _populate(cfg, 2, 5, 0);
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, 2, 5, 0, _root(f), keccak256("bundle"));
        _warpClaimsOpen(f.roundId);
        escrow.finalize(f.roundId);
        IFlockedEscrow.Round memory rd = escrow.getRound(f.roundId);
        assertEq(escrow.withdrawable(treasury), uint256(rd.fee) + rd.creatorFee + rd.dust);
    }

    function test_finalize_zeroFeesCreditsNothing() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.feeBps = 0;
        cfg.creatorBps = 0;
        Fixture memory f = _populate(cfg, 2, 4, 0); // D = 20e6, w = 10e6, R = 0
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, 2, 4, 0, _root(f), keccak256("bundle"));
        _warpClaimsOpen(f.roundId);
        escrow.finalize(f.roundId);
        assertEq(escrow.withdrawable(treasury), 0);
        assertEq(escrow.withdrawable(creator), 0);
    }

    function test_finalize_refundProposal() public {
        Fixture memory f = _populate(_cfg(), 3, 3, 0);
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, 3, 3, 0, bytes32(0), keccak256("tie"));
        _warpClaimsOpen(f.roundId);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.RoundFinalized(f.roundId, IFlockedEscrow.Status.Refunded);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.RoundRefunded(f.roundId, 3);
        escrow.finalize(f.roundId);
        assertEq(uint8(_status(f.roundId)), uint8(IFlockedEscrow.Status.Refunded));
        assertEq(escrow.withdrawable(treasury), 0);
    }

    function test_finalize_revertsOnOpenRound() public {
        uint256 id = _createDefault();
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, id, IFlockedEscrow.Status.Open));
        escrow.finalize(id);
    }
}
