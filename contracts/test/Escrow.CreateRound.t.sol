// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin-contracts/access/IAccessControl.sol";

import {IFlockedEscrow} from "../src/interfaces/IFlockedEscrow.sol";
import {EscrowBase} from "./utils/EscrowBase.sol";

/// @notice CON-1: every `createRound` validation and launch ceiling.
contract EscrowCreateRoundTest is EscrowBase {
    function _expectCreateRevert(IFlockedEscrow.RoundConfig memory cfg, bytes4 err) internal {
        vm.prank(operator);
        vm.expectRevert(err);
        escrow.createRound(cfg);
    }

    function test_createRound_assignsCounterIdsAndStoresConfig() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.RoundCreated(1, cfg);
        uint256 id1 = _create(cfg);
        uint256 id2 = _create(cfg);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(escrow.roundCount(), 2);

        IFlockedEscrow.Round memory rd = escrow.getRound(id1);
        assertEq(uint8(rd.status), uint8(IFlockedEscrow.Status.Open));
        assertEq(rd.cfg.stake, cfg.stake);
        assertEq(rd.cfg.creator, creator);
        assertEq(rd.cfg.questionHash, cfg.questionHash);
        assertEq(rd.cfg.beaconRound, cfg.beaconRound);
        assertEq(rd.winner, 255);
        assertEq(rd.entryCount, 0);
        assertEq(rd.roundBalance, 0);
    }

    function test_createRound_revertsForNonOperator() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        bytes32 role = escrow.OPERATOR_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        escrow.createRound(cfg);
    }

    function test_createRound_revertsWhenOpensAtNotInFuture() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.opensAt = uint64(block.timestamp);
        _expectCreateRevert(cfg, IFlockedEscrow.InvalidSchedule.selector);
    }

    function test_createRound_revertsWhenClosesAtNotAfterOpensAt() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.closesAt = cfg.opensAt;
        _expectCreateRevert(cfg, IFlockedEscrow.InvalidSchedule.selector);
    }

    function test_createRound_maxRoundDurationBoundary() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.closesAt = cfg.opensAt + 3 days + 1;
        cfg.beaconRound = _beaconRoundAt(cfg.closesAt + 2 minutes);
        _expectCreateRevert(cfg, IFlockedEscrow.InvalidSchedule.selector);

        cfg.closesAt = cfg.opensAt + 3 days;
        cfg.beaconRound = _beaconRoundAt(cfg.closesAt + 2 minutes);
        _create(cfg);
    }

    function test_createRound_stakeCeilings() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.stake = 1e6 - 1;
        _expectCreateRevert(cfg, IFlockedEscrow.StakeOutOfRange.selector);
        cfg.stake = 100e6 + 1;
        _expectCreateRevert(cfg, IFlockedEscrow.StakeOutOfRange.selector);
        cfg.stake = 1e6;
        _create(cfg);
        cfg.stake = 100e6;
        _create(cfg);
    }

    function test_createRound_feeCeilings() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.feeBps = 501;
        _expectCreateRevert(cfg, IFlockedEscrow.FeeTooHigh.selector);
        cfg.feeBps = 500;
        cfg.creatorBps = 101;
        _expectCreateRevert(cfg, IFlockedEscrow.CreatorFeeTooHigh.selector);
        cfg.creatorBps = 100;
        _create(cfg);
        cfg.feeBps = 0;
        cfg.creatorBps = 0;
        _create(cfg);
    }

    function test_createRound_capMultipleCeilings() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.capMultiple = 0;
        _expectCreateRevert(cfg, IFlockedEscrow.CapMultipleOutOfRange.selector);
        cfg.capMultiple = 11;
        _expectCreateRevert(cfg, IFlockedEscrow.CapMultipleOutOfRange.selector);
        cfg.capMultiple = 1;
        _create(cfg);
        cfg.capMultiple = 10;
        _create(cfg);
    }

    function test_createRound_revertsOnZeroMinEntrants() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.minEntrants = 0;
        _expectCreateRevert(cfg, IFlockedEscrow.ZeroMinEntrants.selector);
        cfg.minEntrants = 1;
        _create(cfg);
    }

    function test_createRound_revertsOnZeroCreator() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.creator = address(0);
        _expectCreateRevert(cfg, IFlockedEscrow.ZeroAddress.selector);
    }

    function test_createRound_revertsOnBeaconRoundZero() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.beaconRound = 0;
        _expectCreateRevert(cfg, IFlockedEscrow.InvalidBeaconRound.selector);
    }

    function test_createRound_beaconDelayBoundaries() public {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        // GENESIS + (r - 1) * PERIOD: pick the round exactly at closesAt + 60 s, if aligned, else the next one.
        uint64 rMin = _beaconRoundAt(cfg.closesAt + 60);
        uint64 rMax = uint64((uint256(cfg.closesAt) + 600 - GENESIS) / PERIOD + 1);

        cfg.beaconRound = rMin - 1; // < closesAt + 60
        _expectCreateRevert(cfg, IFlockedEscrow.BeaconOutOfRange.selector);
        cfg.beaconRound = rMax + 1; // > closesAt + 600
        _expectCreateRevert(cfg, IFlockedEscrow.BeaconOutOfRange.selector);
        cfg.beaconRound = rMin;
        _create(cfg);
        cfg.beaconRound = rMax;
        _create(cfg);
    }

    function test_createRound_beaconExactlyAtBounds() public {
        // Align closesAt so beacon times land exactly on closesAt + 60 and closesAt + 600.
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        uint256 aligned = GENESIS + ((uint256(cfg.closesAt) - GENESIS) / PERIOD) * PERIOD;
        cfg.closesAt = uint64(aligned);
        cfg.beaconRound = uint64((aligned + 60 - GENESIS) / PERIOD + 1);
        assertEq(escrow.beaconTime(cfg.beaconRound), aligned + 60);
        _create(cfg);
        cfg.beaconRound = uint64((aligned + 600 - GENESIS) / PERIOD + 1);
        assertEq(escrow.beaconTime(cfg.beaconRound), aligned + 600);
        _create(cfg);
    }

    function test_beaconTime_formula() public view {
        assertEq(escrow.beaconTime(1), GENESIS);
        assertEq(escrow.beaconTime(2), GENESIS + PERIOD);
        assertEq(escrow.beaconTime(1_000_001), GENESIS + 1_000_000 * uint256(PERIOD));
    }

    function test_beaconTime_revertsOnZero() public {
        vm.expectRevert(IFlockedEscrow.InvalidBeaconRound.selector);
        escrow.beaconTime(0);
    }
}
