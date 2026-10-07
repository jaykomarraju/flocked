// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFlockedEscrow} from "../../src/interfaces/IFlockedEscrow.sol";
import {EscrowBase} from "../utils/EscrowBase.sol";

/// @notice CON-11: fuzz `claim`. Every honest settlement pays out to the last base unit, in any order.
contract ClaimFuzzTest is EscrowBase {
    function testFuzz_claim_fullSettlementDrainsExactly(
        uint256 n0,
        uint256 n1,
        uint256 nVoid,
        uint256 stake,
        uint256 cap,
        uint256 feeBps,
        uint256 creatorBps,
        uint256 seed
    ) public {
        n0 = bound(n0, 1, 15);
        n1 = bound(n1, 1, 15);
        vm.assume(n0 != n1);
        nVoid = bound(nVoid, 0, 4);
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.stake = uint128(bound(stake, 1e6, 100e6));
        cfg.capMultiple = uint8(bound(cap, 1, 10));
        cfg.feeBps = uint16(bound(feeBps, 0, 500));
        cfg.creatorBps = uint16(bound(creatorBps, 0, 100));
        cfg.minEntrants = 2;

        Fixture memory f = _populate(cfg, uint32(n0), uint32(n1), uint32(nVoid));
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, uint32(n0), uint32(n1), uint32(nVoid), _root(f), keccak256("bundle"));
        _warpClaimsOpen(f.roundId);

        // Claim every leaf in a seed-shuffled order.
        uint256 len = f.leaves.length;
        uint256[] memory order = new uint256[](len);
        for (uint256 i; i < len; i++) {
            order[i] = i;
        }
        for (uint256 i = len; i > 1; i--) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % i;
            (order[i - 1], order[j]) = (order[j], order[i - 1]);
        }
        for (uint256 i; i < len; i++) {
            address a = f.leafAccounts[order[i]];
            uint8 kind = f.leafKinds[order[i]];
            uint256 before = usdc.balanceOf(a);
            _claim(f, a, kind);
            uint256 expected = kind == 0 ? f.outcome.winPayout : kind == 1 ? f.outcome.r : cfg.stake;
            assertEq(usdc.balanceOf(a) - before, expected);
        }
        if (escrow.withdrawable(treasury) > 0) {
            vm.prank(treasury);
            escrow.withdraw();
        }
        if (escrow.withdrawable(creator) > 0) {
            vm.prank(creator);
            escrow.withdraw();
        }
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalObligations(), 0);
    }

    function testFuzz_claim_forgedProofFails(bytes32[] memory proof, uint8 kindRaw) public {
        Fixture memory f = _proposed(2, 5, 1);
        _warpClaimsOpen(f.roundId);
        IFlockedEscrow.Kind kind = IFlockedEscrow.Kind(bound(kindRaw, 0, 2));
        // Losers have no leaf (r = 0 here), so no proof can work for them.
        vm.prank(f.option1[0]);
        vm.expectRevert(IFlockedEscrow.InvalidProof.selector);
        escrow.claim(f.roundId, kind, proof);
    }
}
