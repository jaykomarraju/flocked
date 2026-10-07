// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFlockedEscrow} from "../src/interfaces/IFlockedEscrow.sol";
import {StakesMath} from "../src/lib/StakesMath.sol";
import {EscrowBase} from "./utils/EscrowBase.sol";

/// @notice CON-4: `propose` tally checks and derived amounts.
contract EscrowProposeTest is EscrowBase {
    bytes32 internal constant BUNDLE = keccak256("bundle");
    bytes32 internal constant ROOT = keccak256("root");

    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _createDefault(); // stake 5 USDC, 5% + 1%, cap 10, minEntrants 3
        _warpOpen(id);
        _enterMany(id, 10);
        _warpBeacon(id);
    }

    function _propose(uint32 n0, uint32 n1, uint32 nVoid, bytes32 root, bytes32 bundle) internal {
        vm.prank(operator);
        escrow.propose(id, n0, n1, nVoid, root, bundle);
    }

    function _expectProposeRevert(uint32 n0, uint32 n1, uint32 nVoid, bytes32 root, bytes32 bundle, bytes memory err)
        internal
    {
        vm.expectRevert(err);
        _propose(n0, n1, nVoid, root, bundle);
    }

    // ---------------------------------------------------------------- timing

    function test_propose_revertsBeforeBeaconTime() public {
        vm.warp(block.timestamp - 1);
        _expectProposeRevert(3, 6, 1, ROOT, BUNDLE, abi.encodeWithSelector(IFlockedEscrow.BeaconNotReached.selector));
    }

    function test_propose_allowedAtBeaconTimeAndUntilTimeout() public {
        uint256 closesAt = escrow.getRound(id).cfg.closesAt;
        vm.warp(closesAt + 72 hours);
        _expectProposeRevert(
            3, 6, 1, ROOT, BUNDLE, abi.encodeWithSelector(IFlockedEscrow.ProposalWindowClosed.selector)
        );
        vm.warp(closesAt + 72 hours - 1);
        _propose(3, 6, 1, ROOT, BUNDLE);
        assertEq(uint8(escrow.getRound(id).status), uint8(IFlockedEscrow.Status.SettleProposed));
    }

    // ---------------------------------------------------------------- tally checks

    function test_propose_revertsWhenTallyDoesNotMatchEntryCount() public {
        bytes memory err = abi.encodeWithSelector(IFlockedEscrow.TallyMismatch.selector);
        _expectProposeRevert(3, 6, 0, ROOT, BUNDLE, err);
        _expectProposeRevert(3, 6, 2, ROOT, BUNDLE, err);
        _expectProposeRevert(type(uint32).max, type(uint32).max, type(uint32).max, ROOT, BUNDLE, err);
    }

    function test_propose_revertsOnZeroBundleHash() public {
        _expectProposeRevert(3, 6, 1, ROOT, bytes32(0), abi.encodeWithSelector(IFlockedEscrow.ZeroBundleHash.selector));
        _expectProposeRevert(
            5, 5, 0, bytes32(0), bytes32(0), abi.encodeWithSelector(IFlockedEscrow.ZeroBundleHash.selector)
        );
    }

    function test_propose_settleNeedsPayoutRoot() public {
        _expectProposeRevert(
            3, 6, 1, bytes32(0), BUNDLE, abi.encodeWithSelector(IFlockedEscrow.ZeroPayoutRoot.selector)
        );
    }

    function test_propose_refundNeedsZeroPayoutRoot() public {
        bytes memory err = abi.encodeWithSelector(IFlockedEscrow.PayoutRootMustBeZero.selector);
        _expectProposeRevert(1, 1, 8, ROOT, BUNDLE, err); // reason 1
        _expectProposeRevert(10, 0, 0, ROOT, BUNDLE, err); // reason 2
        _expectProposeRevert(5, 5, 0, ROOT, BUNDLE, err); // reason 3
    }

    function test_propose_revertsWhenNotOpen() public {
        _propose(3, 6, 1, ROOT, BUNDLE);
        _expectProposeRevert(
            3,
            6,
            1,
            ROOT,
            BUNDLE,
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, id, IFlockedEscrow.Status.SettleProposed)
        );
    }

    // ---------------------------------------------------------------- refund proposals

    function _assertRefundProposal(uint32 n0, uint32 n1, uint32 nVoid, uint8 reason) internal {
        uint64 claimsOpenAt = uint64(block.timestamp + 2 hours);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.OutcomeProposed(
            id, IFlockedEscrow.Status.RefundProposed, n0, n1, nVoid, bytes32(0), BUNDLE, claimsOpenAt
        );
        uint256 balBefore = usdc.balanceOf(address(escrow));
        _propose(n0, n1, nVoid, bytes32(0), BUNDLE);
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        assertEq(uint8(rd.status), uint8(IFlockedEscrow.Status.RefundProposed));
        assertEq(rd.refundReason, reason);
        assertEq(rd.winner, 255);
        assertEq(rd.claimsOpenAt, claimsOpenAt);
        assertEq(rd.winPayout, 0);
        assertEq(rd.fee, 0);
        assertEq(usdc.balanceOf(address(escrow)), balBefore, "no USDC moves at proposal");
    }

    function test_propose_refundReason1_tooFewValid() public {
        _assertRefundProposal(1, 1, 8, 1);
    }

    function test_propose_refundReason1_zeroValid() public {
        _assertRefundProposal(0, 0, 10, 1);
    }

    function test_propose_refundReason2_oneSided() public {
        _assertRefundProposal(0, 9, 1, 2);
    }

    function test_propose_refundReason2_otherSide() public {
        _assertRefundProposal(10, 0, 0, 2);
    }

    function test_propose_refundReason3_tie() public {
        _assertRefundProposal(4, 4, 2, 3);
    }

    function test_propose_minEntrantsBoundary() public {
        // minEntrants = 3: n0 + n1 = 2 refunds (reason 1), n0 + n1 = 3 settles.
        _assertRefundProposal(1, 1, 8, 1);
        vm.prank(guardian);
        escrow.veto(id, keccak256("redo"));
        _propose(1, 2, 7, ROOT, BUNDLE);
        assertEq(uint8(escrow.getRound(id).status), uint8(IFlockedEscrow.Status.SettleProposed));
    }

    // ---------------------------------------------------------------- settle proposals

    function test_propose_settleDerivesClosedForm() public {
        // n0 = 3 wins (smaller), n1 = 6 loses, 1 VOID. s = 5e6.
        // Lp = 30e6; F = 1.5e6; C = 0.3e6; D = 28.2e6; w = min(9.4e6, 50e6) = 9.4e6; R = 0; r = 0; dust = 0.
        uint64 claimsOpenAt = uint64(block.timestamp + 2 hours);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.OutcomeProposed(
            id, IFlockedEscrow.Status.SettleProposed, 3, 6, 1, ROOT, BUNDLE, claimsOpenAt
        );
        _propose(3, 6, 1, ROOT, BUNDLE);

        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        assertEq(uint8(rd.status), uint8(IFlockedEscrow.Status.SettleProposed));
        assertEq(rd.winner, 0);
        assertEq(rd.n0, 3);
        assertEq(rd.n1, 6);
        assertEq(rd.nVoid, 1);
        assertEq(rd.payoutRoot, ROOT);
        assertEq(rd.bundleHash, BUNDLE);
        assertEq(rd.claimsOpenAt, claimsOpenAt);
        assertEq(rd.winPayout, 14.4e6);
        assertEq(rd.rebatePayout, 0);
        assertEq(rd.fee, 1.5e6);
        assertEq(rd.creatorFee, 0.3e6);
        assertEq(rd.dust, 0);
        assertEq(rd.refundReason, 0);
        // Invariant: 3 * 14.4 + 0 + 1 * 5 + 1.5 + 0.3 + 0 = 50 = roundBalance.
        assertEq(3 * uint256(rd.winPayout) + 5e6 + rd.fee + rd.creatorFee + rd.dust, rd.roundBalance);
    }

    function test_propose_settleWinnerIsOption1WhenSmaller() public {
        _propose(8, 1, 1, ROOT, BUNDLE);
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        assertEq(rd.winner, 1);
        // Lp = 40e6; F = 2e6; C = 0.4e6; D = 37.6e6; cap = 50e6 so w = 37.6e6; R = 0.
        assertEq(rd.winPayout, 5e6 + 37.6e6);
        assertEq(rd.rebatePayout, 0);
    }

    function test_propose_matchesStakesMath() public {
        _propose(2, 7, 1, ROOT, BUNDLE);
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        StakesMath.Outcome memory o = _outcome(id, 2, 7, 1);
        assertEq(rd.winner, o.winner);
        assertEq(rd.winPayout, o.winPayout);
        assertEq(rd.rebatePayout, o.rebatePayout);
        assertEq(rd.fee, o.fee);
        assertEq(rd.creatorFee, o.creatorFee);
        assertEq(rd.dust, o.dust);
        assertEq(rd.roundBalance, o.roundBalance);
    }

    function test_propose_capBindsAndRebates() public {
        // A round with cap 1 so the cap binds: n0 = 1 winner, n1 = 9 losers.
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.capMultiple = 1;
        cfg.stake = 1e6;
        uint256 rid = _create(cfg);
        _warpOpen(rid);
        _enterMany(rid, 10);
        _warpBeacon(rid);
        vm.prank(operator);
        escrow.propose(rid, 1, 9, 0, ROOT, BUNDLE);
        IFlockedEscrow.Round memory rd = escrow.getRound(rid);
        // Lp = 9e6; F = 450_000; C = 90_000; D = 8_460_000; w = min(8_460_000, 1e6) = 1e6;
        // R = 7_460_000; r = floor(7_460_000 / 9) = 828_888; dust = 7_460_000 - 7_459_992 = 8.
        assertEq(rd.winPayout, 2e6);
        assertEq(rd.rebatePayout, 828_888);
        assertEq(rd.fee, 450_000);
        assertEq(rd.creatorFee, 90_000);
        assertEq(rd.dust, 8);
        assertEq(uint256(rd.winPayout) + 9 * uint256(rd.rebatePayout) + rd.fee + rd.creatorFee + rd.dust, 10e6);
    }

    function test_propose_noUsdcMoves() public {
        uint256 bal = usdc.balanceOf(address(escrow));
        uint256 obligations = escrow.totalObligations();
        _propose(3, 6, 1, ROOT, BUNDLE);
        assertEq(usdc.balanceOf(address(escrow)), bal);
        assertEq(escrow.totalObligations(), obligations);
        assertEq(escrow.withdrawable(treasury), 0);
    }
}
