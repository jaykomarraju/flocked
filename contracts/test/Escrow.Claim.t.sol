// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFlockedEscrow} from "../src/interfaces/IFlockedEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {EscrowBase} from "./utils/EscrowBase.sol";
import {TestMerkle} from "./utils/TestMerkle.sol";

/// @notice CON-6: claims, per-kind claim limits, and `withdraw` with a creator that cannot receive USDC.
contract EscrowClaimTest is EscrowBase {
    bytes32 internal constant BUNDLE = keccak256("bundle");

    /// @dev cap 1 with s = 1e6 so wins, rebates, dust and VOID refunds all appear.
    function _rebateCfg() internal view returns (IFlockedEscrow.RoundConfig memory cfg) {
        cfg = _cfg();
        cfg.capMultiple = 1;
        cfg.stake = 1e6;
    }

    function _proposeFixture(Fixture memory f) internal {
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(
            f.roundId, uint32(f.option0.length), uint32(f.option1.length), uint32(f.voids.length), _root(f), BUNDLE
        );
    }

    // ---------------------------------------------------------------- happy path

    function test_claim_everyKindPaysDerivedAmountAndDrainsRound() public {
        Fixture memory f = _populate(_rebateCfg(), 2, 9, 2);
        _proposeFixture(f);
        _warpClaimsOpen(f.roundId);
        IFlockedEscrow.Round memory rd = escrow.getRound(f.roundId);
        // Lp = 9e6; F = 450_000; C = 90_000; D = 8_460_000; w = 1e6; R = 6_460_000; r = 717_777; dust = 7.
        assertEq(rd.winPayout, 2e6);
        assertEq(rd.rebatePayout, 717_777);
        assertEq(rd.dust, 7);

        address w0 = f.option0[0];
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IFlockedEscrow.Claimed(f.roundId, w0, IFlockedEscrow.Kind.Win, 2e6);
        _claim(f, w0, 0); // finalizes first
        assertEq(uint8(escrow.getRound(f.roundId).status), uint8(IFlockedEscrow.Status.Settled));
        assertEq(usdc.balanceOf(w0), 2e6);

        _claim(f, f.option0[1], 0);
        for (uint256 i; i < f.option1.length; i++) {
            _claim(f, f.option1[i], 1);
            assertEq(usdc.balanceOf(f.option1[i]), 717_777);
        }
        for (uint256 i; i < f.voids.length; i++) {
            _claim(f, f.voids[i], 2);
            assertEq(usdc.balanceOf(f.voids[i]), 1e6);
        }
        vm.prank(treasury);
        escrow.withdraw();
        vm.prank(creator);
        escrow.withdraw();
        assertEq(usdc.balanceOf(treasury), 450_000 + 7);
        assertEq(usdc.balanceOf(creator), 90_000);
        assertEq(usdc.balanceOf(address(escrow)), 0, "every unit paid out");
        assertEq(escrow.totalObligations(), 0);

        rd = escrow.getRound(f.roundId);
        assertEq(rd.winClaims, 2);
        assertEq(rd.rebateClaims, 9);
        assertEq(rd.voidClaims, 2);
    }

    function test_claim_revertsDuringWindow() public {
        Fixture memory f = _proposed(2, 5, 0);
        bytes32[] memory p = _proof(f, f.option0[0], 0);
        vm.prank(f.option0[0]);
        vm.expectRevert(
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, f.roundId, IFlockedEscrow.Status.SettleProposed)
        );
        escrow.claim(f.roundId, IFlockedEscrow.Kind.Win, p);
    }

    function test_claim_revertsOnInvalidProofOrWrongKind() public {
        Fixture memory f = _proposed(2, 5, 1);
        _warpClaimsOpen(f.roundId);
        address w0 = f.option0[0];
        bytes32[] memory p = _proof(f, w0, 0);

        vm.prank(w0);
        vm.expectRevert(IFlockedEscrow.InvalidProof.selector);
        escrow.claim(f.roundId, IFlockedEscrow.Kind.VoidRefund, p);

        // A loser cannot use a winner's proof.
        vm.prank(f.option1[0]);
        vm.expectRevert(IFlockedEscrow.InvalidProof.selector);
        escrow.claim(f.roundId, IFlockedEscrow.Kind.Win, p);
    }

    function test_claim_revertsDoubleClaim() public {
        Fixture memory f = _proposed(2, 5, 0);
        _warpClaimsOpen(f.roundId);
        _claim(f, f.option0[0], 0);
        bytes32[] memory p = _proof(f, f.option0[0], 0);
        vm.prank(f.option0[0]);
        vm.expectRevert(IFlockedEscrow.AlreadyClaimed.selector);
        escrow.claim(f.roundId, IFlockedEscrow.Kind.Win, p);
    }

    function test_claim_revertsForNonEntrantEvenWithValidLeaf() public {
        // The operator slips a non-entrant into the payout tree.
        Fixture memory f = _populate(_cfg(), 2, 5, 0);
        address outsider = _newPlayer();
        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = TestMerkle.leaf(f.roundId, f.option0[0], 0);
        leaves[1] = TestMerkle.leaf(f.roundId, f.option0[1], 0);
        leaves[2] = TestMerkle.leaf(f.roundId, outsider, 0);
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, 2, 5, 0, TestMerkle.root(leaves), BUNDLE);
        _warpClaimsOpen(f.roundId);

        bytes32[] memory p = TestMerkle.proof(leaves, 2);
        vm.prank(outsider);
        vm.expectRevert(IFlockedEscrow.NotEntrant.selector);
        escrow.claim(f.roundId, IFlockedEscrow.Kind.Win, p);
    }

    function test_claim_zeroRebateReverts() public {
        // r = 0 in the default config, so a rebate leaf (were one posted) pays nothing.
        Fixture memory f = _populate(_cfg(), 2, 5, 0);
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = TestMerkle.leaf(f.roundId, f.option0[0], 0);
        leaves[1] = TestMerkle.leaf(f.roundId, f.option1[0], 1);
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, 2, 5, 0, TestMerkle.root(leaves), BUNDLE);
        _warpClaimsOpen(f.roundId);
        assertEq(escrow.getRound(f.roundId).rebatePayout, 0);

        bytes32[] memory p = TestMerkle.proof(leaves, 1);
        vm.prank(f.option1[0]);
        vm.expectRevert(IFlockedEscrow.NothingToClaim.selector);
        escrow.claim(f.roundId, IFlockedEscrow.Kind.Rebate, p);
    }

    // ---------------------------------------------------------------- per-kind limits

    /// @dev A malicious root listing every entrant under every kind.
    function _allKindsTree(Fixture memory f) internal pure returns (bytes32[] memory leaves, address[] memory accts) {
        uint256 n = f.option0.length + f.option1.length + f.voids.length;
        accts = new address[](n);
        uint256 k;
        for (uint256 i; i < f.option0.length; i++) {
            accts[k++] = f.option0[i];
        }
        for (uint256 i; i < f.option1.length; i++) {
            accts[k++] = f.option1[i];
        }
        for (uint256 i; i < f.voids.length; i++) {
            accts[k++] = f.voids[i];
        }
        leaves = new bytes32[](n * 3);
        for (uint256 i; i < n; i++) {
            for (uint8 kind; kind < 3; kind++) {
                leaves[i * 3 + kind] = TestMerkle.leaf(f.roundId, accts[i], kind);
            }
        }
    }

    function _claimFromTree(uint256 roundId, bytes32[] memory leaves, uint256 accountIndex, address a, uint8 kind)
        internal
    {
        bytes32[] memory p = TestMerkle.proof(leaves, accountIndex * 3 + kind);
        vm.prank(a);
        escrow.claim(roundId, IFlockedEscrow.Kind(kind), p);
    }

    function test_claim_perKindLimitsCapTotalAtPostedTally() public {
        // Tally: 2 win (option 0), 4 lose, 1 VOID. 7 entrants, each with all three leaves.
        Fixture memory f = _populate(_rebateCfg(), 2, 4, 1);
        (bytes32[] memory leaves, address[] memory accts) = _allKindsTree(f);
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, 2, 4, 1, TestMerkle.root(leaves), BUNDLE);
        _warpClaimsOpen(f.roundId);

        // Win: accounts 0 and 1 succeed, account 2 hits the N_M = 2 cap.
        _claimFromTree(f.roundId, leaves, 0, accts[0], 0);
        _claimFromTree(f.roundId, leaves, 1, accts[1], 0);
        bytes32[] memory p = TestMerkle.proof(leaves, 2 * 3 + 0);
        vm.prank(accts[2]);
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.ClaimLimitReached.selector, IFlockedEscrow.Kind.Win));
        escrow.claim(f.roundId, IFlockedEscrow.Kind.Win, p);

        // VoidRefund: account 2 takes the single nVoid slot; account 3 is refused.
        _claimFromTree(f.roundId, leaves, 2, accts[2], 2);
        p = TestMerkle.proof(leaves, 3 * 3 + 2);
        vm.prank(accts[3]);
        vm.expectRevert(
            abi.encodeWithSelector(IFlockedEscrow.ClaimLimitReached.selector, IFlockedEscrow.Kind.VoidRefund)
        );
        escrow.claim(f.roundId, IFlockedEscrow.Kind.VoidRefund, p);

        // Rebate: accounts 3..6 fill N_L = 4.
        for (uint256 i = 3; i < 7; i++) {
            _claimFromTree(f.roundId, leaves, i, accts[i], 1);
        }
        IFlockedEscrow.Round memory rd = escrow.getRound(f.roundId);
        assertEq(rd.winClaims, 2);
        assertEq(rd.rebateClaims, 4);
        assertEq(rd.voidClaims, 1);

        // Everything paid matches the derived totals; fees remain for the treasury and creator.
        uint256 paid = 2 * uint256(rd.winPayout) + 4 * uint256(rd.rebatePayout) + rd.cfg.stake;
        assertEq(usdc.balanceOf(address(escrow)), rd.roundBalance - paid);
        assertEq(escrow.totalObligations(), uint256(rd.fee) + rd.creatorFee + rd.dust);
    }

    function test_claim_rebateLimitWithExtraLeaves() public {
        // Tally says 1 winner, 2 losers, but the root gives every entrant a rebate leaf.
        Fixture memory f = _populate(_rebateCfg(), 1, 2, 0);
        (bytes32[] memory leaves, address[] memory accts) = _allKindsTree(f);
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, 1, 2, 0, TestMerkle.root(leaves), BUNDLE);
        _warpClaimsOpen(f.roundId);
        _claimFromTree(f.roundId, leaves, 0, accts[0], 1);
        _claimFromTree(f.roundId, leaves, 1, accts[1], 1);
        bytes32[] memory p = TestMerkle.proof(leaves, 2 * 3 + 1);
        vm.prank(accts[2]);
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.ClaimLimitReached.selector, IFlockedEscrow.Kind.Rebate));
        escrow.claim(f.roundId, IFlockedEscrow.Kind.Rebate, p);
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdraw_creatorThatCannotReceiveNeverBlocksRound() public {
        MockUSDC(address(usdc)).setBlocked(creator, true);
        Fixture memory f = _populate(_rebateCfg(), 2, 9, 1);
        _proposeFixture(f);
        _warpClaimsOpen(f.roundId);

        // Finalize and every claim succeed although the creator is blocklisted.
        escrow.finalize(f.roundId);
        _claim(f, f.option0[0], 0);
        _claim(f, f.option0[1], 0);
        for (uint256 i; i < f.option1.length; i++) {
            _claim(f, f.option1[i], 1);
        }
        _claim(f, f.voids[0], 2);

        vm.prank(treasury);
        escrow.withdraw();
        assertEq(usdc.balanceOf(treasury), 450_000 + 7);

        // Only the creator's own pull fails, and the credit stays owed.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, creator));
        escrow.withdraw();
        assertEq(escrow.withdrawable(creator), 90_000);
        assertEq(escrow.totalObligations(), 90_000);
        assertEq(usdc.balanceOf(address(escrow)), 90_000);

        // Once unblocked, the creator can withdraw.
        MockUSDC(address(usdc)).setBlocked(creator, false);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.Withdrawn(creator, 90_000);
        vm.prank(creator);
        escrow.withdraw();
        assertEq(usdc.balanceOf(creator), 90_000);
        assertEq(escrow.withdrawable(creator), 0);
    }

    function test_withdraw_keepsBalanceForOldTreasuryAfterRotation() public {
        Fixture memory f = _proposed(2, 5, 0);
        _warpClaimsOpen(f.roundId);
        escrow.finalize(f.roundId);
        uint256 owed = escrow.withdrawable(treasury);
        assertGt(owed, 0);

        address newTreasury = makeAddr("newTreasury");
        vm.startPrank(admin);
        escrow.scheduleTreasury(newTreasury);
        vm.warp(block.timestamp + 72 hours);
        escrow.executeTreasury(newTreasury);
        vm.stopPrank();

        vm.prank(treasury);
        escrow.withdraw();
        assertEq(usdc.balanceOf(treasury), owed);
    }
}
