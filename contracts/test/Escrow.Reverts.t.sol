// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin-contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";

import {FlockedEscrow} from "../src/FlockedEscrow.sol";
import {IFlockedEscrow} from "../src/interfaces/IFlockedEscrow.sol";
import {EscrowBase} from "./utils/EscrowBase.sol";

/// @notice CON-1: constructor checks, unknown rounds, wrong-status calls and role checks.
contract EscrowRevertsTest is EscrowBase {
    function _deployWith(address[6] memory a, uint64 g, uint64 p) internal returns (FlockedEscrow) {
        return new FlockedEscrow(IERC20(a[0]), a[1], a[2], a[3], a[4], signer, a[5], g, p);
    }

    function test_constructor_revertsOnZeroAddresses() public {
        address[6] memory good = [address(usdc), admin, guardian, operator, pauser, treasury];
        for (uint256 i; i < 6; i++) {
            address[6] memory a = good;
            a[i] = address(0);
            vm.expectRevert(IFlockedEscrow.ZeroAddress.selector);
            _deployWith(a, GENESIS, PERIOD);
        }
    }

    function test_constructor_revertsOnZeroDrandParams() public {
        address[6] memory good = [address(usdc), admin, guardian, operator, pauser, treasury];
        vm.expectRevert(IFlockedEscrow.InvalidDrandParams.selector);
        _deployWith(good, 0, PERIOD);
        vm.expectRevert(IFlockedEscrow.InvalidDrandParams.selector);
        _deployWith(good, GENESIS, 0);
    }

    function test_constructor_setsRolesAndParams() public view {
        assertTrue(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(escrow.hasRole(escrow.GUARDIAN_ROLE(), guardian));
        assertEq(escrow.guardian(), guardian);
        assertEq(escrow.getRoleMemberCount(escrow.GUARDIAN_ROLE()), 1);
        assertTrue(escrow.hasRole(escrow.OPERATOR_ROLE(), operator));
        assertTrue(escrow.hasRole(escrow.PAUSER_ROLE(), pauser));
        assertEq(escrow.getRoleAdmin(escrow.GUARDIAN_ROLE()), escrow.GUARDIAN_ROLE());
        assertEq(escrow.getRoleAdmin(escrow.OPERATOR_ROLE()), escrow.DEFAULT_ADMIN_ROLE());
        assertEq(escrow.ticketSigner(), signer);
        assertEq(escrow.treasury(), treasury);
        assertEq(address(escrow.usdc()), address(usdc));
        assertEq(escrow.GENESIS(), GENESIS);
        assertEq(escrow.PERIOD(), PERIOD);
        assertEq(escrow.roundCount(), 0);
    }

    function test_constructor_allowsDisabledSigner() public {
        FlockedEscrow e =
            new FlockedEscrow(usdc, admin, guardian, operator, pauser, address(0), treasury, GENESIS, PERIOD);
        assertEq(e.ticketSigner(), address(0));
    }

    function test_unknownRound_reverts() public {
        uint256 id = 42;
        bytes memory notFound = abi.encodeWithSelector(IFlockedEscrow.RoundNotFound.selector, id);

        vm.prank(operator);
        vm.expectRevert(notFound);
        escrow.voidRound(id);

        vm.prank(operator);
        vm.expectRevert(notFound);
        escrow.propose(id, 1, 0, 0, bytes32(0), bytes32(uint256(1)));

        vm.prank(guardian);
        vm.expectRevert(notFound);
        escrow.veto(id, bytes32(0));

        vm.expectRevert(notFound);
        escrow.finalize(id);
        vm.expectRevert(notFound);
        escrow.refundTooFew(id);
        vm.expectRevert(notFound);
        escrow.refundTimeout(id);
        vm.expectRevert(notFound);
        escrow.claim(id, IFlockedEscrow.Kind.Win, new bytes32[](0));
        vm.expectRevert(notFound);
        escrow.claimRefund(id);

        // enter reports the empty round's status rather than a separate not-found error.
        IFlockedEscrow.EntryTicket memory t = _ticket(id, stranger);
        bytes memory sig = _sign(t);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, id, IFlockedEscrow.Status.None));
        escrow.enter(id, _ct(64), t, sig);
    }

    function test_wrongStatus_onRefundedRound() public {
        uint256 id = _createDefault();
        vm.prank(operator);
        escrow.voidRound(id);
        bytes memory wrong =
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, id, IFlockedEscrow.Status.Refunded);

        vm.prank(operator);
        vm.expectRevert(wrong);
        escrow.voidRound(id);

        vm.warp(escrow.beaconTime(escrow.getRound(id).cfg.beaconRound));
        vm.prank(operator);
        vm.expectRevert(wrong);
        escrow.propose(id, 0, 0, 0, bytes32(0), bytes32(uint256(1)));

        vm.prank(guardian);
        vm.expectRevert(wrong);
        escrow.veto(id, bytes32(0));

        vm.expectRevert(wrong);
        escrow.finalize(id);
        vm.expectRevert(wrong);
        escrow.refundTooFew(id);

        vm.warp(escrow.getRound(id).cfg.closesAt + 72 hours);
        vm.expectRevert(wrong);
        escrow.refundTimeout(id);
        vm.expectRevert(wrong);
        escrow.claim(id, IFlockedEscrow.Kind.Win, new bytes32[](0));
    }

    function test_roleChecks() public {
        uint256 id = _createDefault();

        vm.expectRevert(IFlockedEscrow.NotOperatorOrGuardian.selector);
        vm.prank(stranger);
        escrow.voidRound(id);

        bytes32 opRole = escrow.OPERATOR_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, opRole)
        );
        vm.prank(stranger);
        escrow.propose(id, 0, 0, 0, bytes32(0), bytes32(uint256(1)));

        bytes32 gRole = escrow.GUARDIAN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, operator, gRole)
        );
        vm.prank(operator);
        escrow.veto(id, bytes32(0));

        bytes32 pRole = escrow.PAUSER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, pRole)
        );
        vm.prank(stranger);
        escrow.pause();
        bytes32 aRole = escrow.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, aRole)
        );
        vm.prank(stranger);
        escrow.unpause();
    }

    function test_withdraw_revertsWithNothingCredited() public {
        vm.expectRevert(IFlockedEscrow.NothingToClaim.selector);
        vm.prank(stranger);
        escrow.withdraw();
    }
}
