// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFlockedEscrow} from "../../src/interfaces/IFlockedEscrow.sol";
import {StakesMath} from "../../src/lib/StakesMath.sol";
import {EscrowBase} from "../utils/EscrowBase.sol";

/// @notice CON-11: fuzz `propose`, plus the closed-form invariant and bounds over wide inputs.
contract ProposeFuzzTest is EscrowBase {
    uint256 internal constant ENTRANTS = 12;
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _createDefault(); // minEntrants 3
        _warpOpen(id);
        _enterMany(id, ENTRANTS);
        _warpBeacon(id);
    }

    function testFuzz_propose_tally(uint32 n0, uint32 n1, uint32 nVoid, bytes32 root) public {
        vm.assume(root != bytes32(0));
        bool sums = uint256(n0) + n1 + nVoid == ENTRANTS;
        StakesMath.Outcome memory o;
        if (sums) o = _outcome(id, n0, n1, nVoid);
        bool settles = sums && o.status == StakesMath.STATUS_SETTLE;

        if (!sums) vm.expectRevert(IFlockedEscrow.TallyMismatch.selector);
        else if (!settles) vm.expectRevert(IFlockedEscrow.PayoutRootMustBeZero.selector);
        vm.prank(operator);
        escrow.propose(id, n0, n1, nVoid, root, keccak256("bundle"));
        if (!settles) return;

        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        assertEq(uint8(rd.status), uint8(IFlockedEscrow.Status.SettleProposed));
        assertEq(rd.winner, o.winner);
        assertEq(rd.winPayout, o.winPayout);
        assertEq(rd.rebatePayout, o.rebatePayout);
        assertEq(rd.fee + rd.creatorFee + rd.dust, o.fee + o.creatorFee + o.dust);
    }

    function testFuzz_propose_refundTally(uint256 n0, uint256 nVoid) public {
        // Every split that sums to the entry count with a zero root either refunds or demands a root.
        n0 = bound(n0, 0, ENTRANTS);
        nVoid = bound(nVoid, 0, ENTRANTS - n0);
        uint256 n1 = ENTRANTS - n0 - nVoid;
        StakesMath.Outcome memory o = _outcome(id, n0, n1, nVoid);
        if (o.status == StakesMath.STATUS_SETTLE) vm.expectRevert(IFlockedEscrow.ZeroPayoutRoot.selector);
        vm.prank(operator);
        escrow.propose(id, uint32(n0), uint32(n1), uint32(nVoid), bytes32(0), keccak256("bundle"));
        if (o.status == StakesMath.STATUS_REFUND) {
            IFlockedEscrow.Round memory rd = escrow.getRound(id);
            assertEq(uint8(rd.status), uint8(IFlockedEscrow.Status.RefundProposed));
            assertEq(rd.refundReason, o.refundReason);
        }
    }

    function testFuzz_propose_timing(uint256 t) public {
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        uint256 bt = escrow.beaconTime(rd.cfg.beaconRound);
        uint256 deadline = uint256(rd.cfg.closesAt) + 72 hours;
        t = bound(t, rd.cfg.opensAt, deadline + 1 days);
        vm.warp(t);
        if (t < bt) vm.expectRevert(IFlockedEscrow.BeaconNotReached.selector);
        else if (t >= deadline) vm.expectRevert(IFlockedEscrow.ProposalWindowClosed.selector);
        vm.prank(operator);
        escrow.propose(id, 3, 8, 1, keccak256("root"), keccak256("bundle"));
    }

    function testFuzz_stakesMath_invariantAndBounds(
        uint256 s,
        uint256 feeBps,
        uint256 creatorBps,
        uint256 cap,
        uint256 minEntrants,
        uint256 n0,
        uint256 n1,
        uint256 nVoid
    ) public pure {
        s = bound(s, 1, 100e6);
        feeBps = bound(feeBps, 0, 500);
        creatorBps = bound(creatorBps, 0, 100);
        cap = bound(cap, 1, 10);
        minEntrants = bound(minEntrants, 1, 1_000);
        n0 = bound(n0, 0, type(uint32).max);
        n1 = bound(n1, 0, type(uint32).max);
        nVoid = bound(nVoid, 0, type(uint32).max);
        StakesMath.Outcome memory o = StakesMath.compute(s, feeBps, creatorBps, cap, minEntrants, n0, n1, nVoid);
        assertEq(o.roundBalance, (n0 + n1 + nVoid) * s);
        if (o.status == StakesMath.STATUS_REFUND) {
            assertEq(o.refundReason, StakesMath.refundReason(minEntrants, n0, n1));
            assertGt(o.refundReason, 0);
            assertEq(o.winner, 255);
            return;
        }
        (uint256 nM, uint256 nL) = o.winner == 0 ? (n0, n1) : (n1, n0);
        assertLt(nM, nL, "winner has the smaller headcount");
        assertEq(nM * o.winPayout + nL * o.rebatePayout + nVoid * s + o.fee + o.creatorFee + o.dust, o.roundBalance);
        assertLe(o.w, cap * s);
        assertLe(o.r, s);
        assertLt(o.dust, nL);
        assertGe(o.winPayout, s);
        assertLe(o.winPayout, (1 + cap) * s);
    }
}
