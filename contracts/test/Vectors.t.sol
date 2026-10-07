// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFlockedEscrow} from "../src/interfaces/IFlockedEscrow.sol";
import {StakesMath} from "../src/lib/StakesMath.sol";
import {EscrowBase} from "./utils/EscrowBase.sol";

/// @notice Checks `StakesMath` (and `propose`) against recorded stakes-closed-form vectors in the P1.1 format.
contract VectorsTest is EscrowBase {
    /// @dev Relative to the Foundry project root. W1-D points this at `../packages/settle/vectors/stakes-closed-form.json`.
    string internal constant VECTORS_PATH = "test/fixtures/stakes-closed-form.seed.json";

    /// @dev Vectors run through a real round only if they fit the launch ceilings and this many entrants.
    uint256 internal constant MAX_ONCHAIN_ENTRANTS = 200;

    struct Vector {
        string id;
        uint256 stake;
        uint256 feeBps;
        uint256 creatorBps;
        uint256 capMultiple;
        uint256 minEntrants;
        uint256 n0;
        uint256 n1;
        uint256 nVoid;
    }

    string internal json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(string.concat(vm.projectRoot(), "/", VECTORS_PATH));
    }

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, key));
    }

    function _count() internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".vectors[", vm.toString(n), "]"))) {
            n++;
        }
    }

    function _vector(uint256 i) internal view returns (Vector memory v, string memory base) {
        base = string.concat(".vectors[", vm.toString(i), "]");
        v.id = vm.parseJsonString(json, string.concat(base, ".id"));
        v.stake = _u(string.concat(base, ".stake"));
        v.feeBps = _u(string.concat(base, ".feeBps"));
        v.creatorBps = _u(string.concat(base, ".creatorBps"));
        v.capMultiple = _u(string.concat(base, ".capMultiple"));
        v.minEntrants = _u(string.concat(base, ".minEntrants"));
        v.n0 = _u(string.concat(base, ".n0"));
        v.n1 = _u(string.concat(base, ".n1"));
        v.nVoid = _u(string.concat(base, ".nVoid"));
    }

    function _compute(Vector memory v) internal pure returns (StakesMath.Outcome memory) {
        return StakesMath.compute(v.stake, v.feeBps, v.creatorBps, v.capMultiple, v.minEntrants, v.n0, v.n1, v.nVoid);
    }

    function _check(string memory base, string memory field, uint256 actual, string memory id) internal view {
        assertEq(actual, _u(string.concat(base, ".expected.", field)), string.concat(id, ": ", field));
    }

    function test_vectors_header() public view {
        assertEq(vm.parseJsonString(json, ".kind"), "stakes-closed-form");
        assertEq(vm.parseJsonString(json, ".formulaVersion"), "1");
        assertGe(_count(), 8);
    }

    function test_vectors_matchStakesMath() public view {
        uint256 n = _count();
        for (uint256 i; i < n; i++) {
            (Vector memory v, string memory b) = _vector(i);
            StakesMath.Outcome memory o = _compute(v);
            _check(b, "status", o.status, v.id);
            _check(b, "refundReason", o.refundReason, v.id);
            _check(b, "winner", o.winner, v.id);
            _check(b, "lossPool", o.lossPool, v.id);
            _check(b, "fee", o.fee, v.id);
            _check(b, "creatorFee", o.creatorFee, v.id);
            _check(b, "distributable", o.distributable, v.id);
            _check(b, "w", o.w, v.id);
            _check(b, "rebatePool", o.rebatePool, v.id);
            _check(b, "r", o.r, v.id);
            _check(b, "dust", o.dust, v.id);
            _check(b, "winPayout", o.winPayout, v.id);
            _check(b, "rebatePayout", o.rebatePayout, v.id);
            _check(b, "voidRefund", o.voidRefund, v.id);
            _check(b, "roundBalance", o.roundBalance, v.id);
        }
    }

    function _fitsOnchain(Vector memory v) internal pure returns (bool) {
        return v.stake >= 1e6 && v.stake <= 100e6 && v.feeBps <= 500 && v.creatorBps <= 100 && v.capMultiple >= 1
            && v.capMultiple <= 10 && v.minEntrants >= 1 && v.minEntrants <= type(uint32).max
            && v.n0 + v.n1 + v.nVoid <= MAX_ONCHAIN_ENTRANTS;
    }

    function test_vectors_throughPropose() public {
        uint256 n = _count();
        uint256 ran;
        for (uint256 i; i < n; i++) {
            (Vector memory v, string memory b) = _vector(i);
            if (!_fitsOnchain(v)) continue;
            _runOnchain(v, b);
            ran++;
        }
        assertGe(ran, 2, "at least two vectors through propose");
    }

    function _runOnchain(Vector memory v, string memory b) internal {
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.stake = uint128(v.stake);
        cfg.feeBps = uint16(v.feeBps);
        cfg.creatorBps = uint16(v.creatorBps);
        cfg.capMultiple = uint8(v.capMultiple);
        cfg.minEntrants = uint32(v.minEntrants);
        uint256 id = _create(cfg);
        _warpOpen(id);
        _enterMany(id, v.n0 + v.n1 + v.nVoid);
        _warpBeacon(id);

        bool settles = _u(string.concat(b, ".expected.status")) == 2;
        vm.prank(operator);
        escrow.propose(
            id,
            uint32(v.n0),
            uint32(v.n1),
            uint32(v.nVoid),
            settles ? keccak256(bytes(v.id)) : bytes32(0),
            keccak256("bundle")
        );

        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        _check(b, "status", uint8(rd.status), v.id);
        _check(b, "refundReason", rd.refundReason, v.id);
        _check(b, "winner", rd.winner, v.id);
        _check(b, "roundBalance", rd.roundBalance, v.id);
        _check(b, "voidRefund", rd.cfg.stake, v.id);
        if (settles) {
            _check(b, "winPayout", rd.winPayout, v.id);
            _check(b, "rebatePayout", rd.rebatePayout, v.id);
            _check(b, "fee", rd.fee, v.id);
            _check(b, "creatorFee", rd.creatorFee, v.id);
            _check(b, "dust", rd.dust, v.id);
        }

        uint256 treasuryBefore = escrow.withdrawable(treasury);
        uint256 creatorBefore = escrow.withdrawable(creator);
        _warpClaimsOpen(id);
        escrow.finalize(id);
        if (settles) {
            assertEq(
                escrow.withdrawable(treasury) - treasuryBefore,
                _u(string.concat(b, ".expected.fee")) + _u(string.concat(b, ".expected.dust")),
                string.concat(v.id, ": treasury credit")
            );
            _check(b, "creatorFee", escrow.withdrawable(creator) - creatorBefore, v.id);
        } else {
            assertEq(uint8(escrow.getRound(id).status), uint8(IFlockedEscrow.Status.Refunded));
        }
    }
}
