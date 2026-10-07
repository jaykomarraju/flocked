// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin-contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin-contracts/utils/Pausable.sol";

import {IFlockedEscrow} from "../src/interfaces/IFlockedEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {EscrowBase} from "./utils/EscrowBase.sol";

/// @notice CON-7: `refundTimeout`, pause behaviour, role timelocks (72 h; guardian 7 d; immediate revocations).
contract EscrowRolesTest is EscrowBase {
    address internal newOperator = makeAddr("newOperator");
    address internal newGuardian = makeAddr("newGuardian");

    function _id(bytes32 action, bytes memory data) internal view returns (bytes32) {
        return escrow.operationId(action, data);
    }

    function _notReady(bytes32 action, bytes memory data, uint256 readyAt) internal view returns (bytes memory) {
        return abi.encodeWithSelector(IFlockedEscrow.TimelockNotReady.selector, _id(action, data), readyAt);
    }

    // ---------------------------------------------------------------- refundTimeout

    function test_refundTimeout_onlyAfterCloseplus72h() public {
        Fixture memory f = _populate(_cfg(), 2, 5, 0);
        uint256 closesAt = escrow.getRound(f.roundId).cfg.closesAt;
        vm.warp(closesAt + 72 hours - 1);
        vm.expectRevert(IFlockedEscrow.TimeoutNotReached.selector);
        escrow.refundTimeout(f.roundId);

        vm.warp(closesAt + 72 hours);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IFlockedEscrow.RoundRefunded(f.roundId, 6);
        vm.prank(stranger);
        escrow.refundTimeout(f.roundId);
        assertEq(uint8(escrow.getRound(f.roundId).status), uint8(IFlockedEscrow.Status.Refunded));

        for (uint256 i; i < f.option0.length; i++) {
            vm.prank(f.option0[i]);
            escrow.claimRefund(f.roundId);
        }
        for (uint256 i; i < f.option1.length; i++) {
            vm.prank(f.option1[i]);
            escrow.claimRefund(f.roundId);
        }
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_refundTimeout_revertsOnProposedRound() public {
        Fixture memory f = _proposed(2, 5, 0);
        vm.warp(escrow.getRound(f.roundId).cfg.closesAt + 72 hours);
        vm.expectRevert(
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, f.roundId, IFlockedEscrow.Status.SettleProposed)
        );
        escrow.refundTimeout(f.roundId);
    }

    // ---------------------------------------------------------------- pause

    function test_pause_blocksEnterOnlyAndIsImmediate() public {
        // Round A gets settled while paused; round B gets refunded while paused.
        Fixture memory a = _populate(_cfg(), 2, 5, 0);
        Fixture memory b = _populate(_cfg(), 3, 3, 0);
        uint256 c = _createDefault();
        _warpOpen(c);

        vm.prank(pauser);
        escrow.pause();
        assertTrue(escrow.paused());

        address p = _newPlayer();
        _fund(p, 5e6);
        IFlockedEscrow.EntryTicket memory t = _ticket(c, p);
        bytes memory sig = _sign(t);
        vm.prank(p);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.enter(c, _ct(64), t, sig);

        // Void, propose, veto, finalize, claims, refunds and withdrawals all still work.
        vm.prank(guardian);
        escrow.voidRound(c);
        _warpBeacon(b.roundId);
        vm.startPrank(operator);
        escrow.propose(a.roundId, 2, 5, 0, _root(a), keccak256("a"));
        escrow.propose(b.roundId, 3, 3, 0, bytes32(0), keccak256("b"));
        vm.stopPrank();
        vm.prank(guardian);
        escrow.veto(b.roundId, keccak256("evidence"));
        vm.prank(operator);
        escrow.propose(b.roundId, 3, 3, 0, bytes32(0), keccak256("b2"));
        _warpClaimsOpen(b.roundId);
        escrow.finalize(a.roundId);
        _claim(a, a.option0[0], 0);
        vm.prank(b.option0[0]);
        escrow.claimRefund(b.roundId);
        vm.prank(treasury);
        escrow.withdraw();

        vm.prank(pauser);
        escrow.unpause();
        assertFalse(escrow.paused());
    }

    // ---------------------------------------------------------------- operator grants

    function test_operatorGrant_requiresTimelock() public {
        bytes32 role = escrow.OPERATOR_ROLE();
        vm.prank(admin);
        vm.expectRevert(IFlockedEscrow.TimelockRequired.selector);
        escrow.grantRole(role, newOperator);

        bytes memory data = abi.encode(newOperator);
        bytes32 action = escrow.ACTION_OPERATOR_GRANT();
        uint256 readyAt = block.timestamp + 72 hours;
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IFlockedEscrow.TimelockScheduled(_id(action, data), action, data, readyAt);
        vm.prank(admin);
        escrow.scheduleOperatorGrant(newOperator);
        assertEq(escrow.timelockReadyAt(_id(action, data)), readyAt);

        vm.warp(readyAt - 1);
        bytes memory notReady = _notReady(action, data, readyAt);
        vm.prank(admin);
        vm.expectRevert(notReady);
        escrow.executeOperatorGrant(newOperator);

        vm.warp(readyAt);
        vm.prank(admin);
        escrow.executeOperatorGrant(newOperator);
        assertTrue(escrow.hasRole(role, newOperator));
        assertEq(escrow.timelockReadyAt(_id(action, data)), 0);

        // Consumed: cannot execute twice.
        bytes memory notScheduled = abi.encodeWithSelector(IFlockedEscrow.NotScheduled.selector, _id(action, data));
        vm.prank(admin);
        vm.expectRevert(notScheduled);
        escrow.executeOperatorGrant(newOperator);
    }

    function test_operatorGrant_cancelAndReschedule() public {
        vm.startPrank(admin);
        escrow.scheduleOperatorGrant(newOperator);
        bytes32 opId = _id(escrow.ACTION_OPERATOR_GRANT(), abi.encode(newOperator));
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.AlreadyScheduled.selector, opId));
        escrow.scheduleOperatorGrant(newOperator);
        escrow.cancelOperatorGrant(newOperator);
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.NotScheduled.selector, opId));
        escrow.cancelOperatorGrant(newOperator);
        vm.warp(block.timestamp + 72 hours);
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.NotScheduled.selector, opId));
        escrow.executeOperatorGrant(newOperator);
        vm.expectRevert(IFlockedEscrow.ZeroAddress.selector);
        escrow.scheduleOperatorGrant(address(0));
        vm.stopPrank();
    }

    function test_operatorRevocation_isImmediate() public {
        bytes32 role = escrow.OPERATOR_ROLE();
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        vm.prank(admin);
        escrow.revokeRole(role, operator);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, operator, role)
        );
        escrow.createRound(cfg);
    }

    function test_timelockFunctions_onlyAdmin() public {
        bytes32 adminRole = escrow.DEFAULT_ADMIN_ROLE();
        bytes memory err =
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, operator, adminRole);
        vm.startPrank(operator);
        vm.expectRevert(err);
        escrow.scheduleOperatorGrant(operator);
        vm.expectRevert(err);
        escrow.executeOperatorGrant(operator);
        vm.expectRevert(err);
        escrow.cancelOperatorGrant(operator);
        vm.expectRevert(err);
        escrow.scheduleTicketSigner(operator);
        vm.expectRevert(err);
        escrow.executeTicketSigner(operator);
        vm.expectRevert(err);
        escrow.cancelTicketSigner(operator);
        vm.expectRevert(err);
        escrow.setTicketSigner(address(0));
        vm.expectRevert(err);
        escrow.scheduleTreasury(operator);
        vm.expectRevert(err);
        escrow.executeTreasury(operator);
        vm.expectRevert(err);
        escrow.cancelTreasury(operator);
        vm.expectRevert(err);
        escrow.scheduleGuardianReplacement(operator);
        vm.expectRevert(err);
        escrow.executeGuardianReplacement(operator);
        vm.expectRevert(err);
        escrow.cancelGuardianReplacement(operator);
        vm.expectRevert(err);
        escrow.scheduleRescue(address(usdc), operator, 1);
        vm.expectRevert(err);
        escrow.executeRescue(address(usdc), operator, 1);
        vm.expectRevert(err);
        escrow.cancelRescue(address(usdc), operator, 1);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- ticket signer

    function test_ticketSigner_disableIsImmediateAndRotationIsTimelocked() public {
        uint256 newPk = 0xC0FFEE;
        address newSigner = vm.addr(newPk);

        vm.startPrank(admin);
        vm.expectRevert(IFlockedEscrow.TimelockRequired.selector);
        escrow.setTicketSigner(newSigner);
        vm.expectEmit(true, true, false, false, address(escrow));
        emit IFlockedEscrow.TicketSignerSet(signer, address(0));
        escrow.setTicketSigner(address(0));
        assertEq(escrow.ticketSigner(), address(0));

        vm.expectRevert(IFlockedEscrow.ZeroAddress.selector);
        escrow.scheduleTicketSigner(address(0));
        escrow.scheduleTicketSigner(newSigner);
        uint256 readyAt = block.timestamp + 72 hours;
        vm.warp(readyAt - 1);
        bytes32 action = escrow.ACTION_TICKET_SIGNER();
        vm.expectRevert(_notReady(action, abi.encode(newSigner), readyAt));
        escrow.executeTicketSigner(newSigner);
        vm.warp(readyAt);
        escrow.executeTicketSigner(newSigner);
        vm.stopPrank();
        assertEq(escrow.ticketSigner(), newSigner);

        // Tickets from the old signer no longer verify; the new signer's do.
        uint256 id = _createDefault();
        _warpOpen(id);
        address p = _newPlayer();
        _fund(p, 5e6);
        IFlockedEscrow.EntryTicket memory t = _ticket(id, p);
        bytes memory oldSig = _sign(t);
        vm.prank(p);
        vm.expectRevert(IFlockedEscrow.InvalidTicketSignature.selector);
        escrow.enter(id, _ct(64), t, oldSig);
        bytes memory newSig = _signWith(newPk, address(escrow), t);
        vm.prank(p);
        escrow.enter(id, _ct(64), t, newSig);
    }

    function test_ticketSigner_cancel() public {
        vm.startPrank(admin);
        escrow.scheduleTicketSigner(stranger);
        escrow.cancelTicketSigner(stranger);
        vm.warp(block.timestamp + 72 hours);
        vm.expectRevert(
            abi.encodeWithSelector(
                IFlockedEscrow.NotScheduled.selector, _id(escrow.ACTION_TICKET_SIGNER(), abi.encode(stranger))
            )
        );
        escrow.executeTicketSigner(stranger);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- treasury

    function test_treasury_timelocked72h() public {
        address t2 = makeAddr("treasury2");
        vm.startPrank(admin);
        vm.expectRevert(IFlockedEscrow.ZeroAddress.selector);
        escrow.scheduleTreasury(address(0));
        escrow.scheduleTreasury(t2);
        uint256 readyAt = block.timestamp + 72 hours;
        vm.warp(readyAt - 1);
        bytes32 action = escrow.ACTION_TREASURY();
        vm.expectRevert(_notReady(action, abi.encode(t2), readyAt));
        escrow.executeTreasury(t2);
        vm.warp(readyAt);
        vm.expectEmit(true, true, false, false, address(escrow));
        emit IFlockedEscrow.TreasurySet(treasury, t2);
        escrow.executeTreasury(t2);
        assertEq(escrow.treasury(), t2);

        escrow.scheduleTreasury(treasury);
        escrow.cancelTreasury(treasury);
        vm.stopPrank();
        assertEq(escrow.treasury(), t2);
    }

    function test_treasury_newTreasuryCreditedAtFinalize() public {
        Fixture memory f = _proposed(2, 5, 0);
        address t2 = makeAddr("treasury2");
        vm.prank(admin);
        escrow.scheduleTreasury(t2);
        vm.warp(block.timestamp + 72 hours);
        vm.prank(admin);
        escrow.executeTreasury(t2);
        escrow.finalize(f.roundId);
        assertGt(escrow.withdrawable(t2), 0);
        assertEq(escrow.withdrawable(treasury), 0);
    }

    // ---------------------------------------------------------------- guardian

    function test_guardian_isItsOwnAdmin() public {
        bytes32 role = escrow.GUARDIAN_ROLE();
        // The admin multisig cannot grant or revoke the guardian directly.
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, role));
        escrow.revokeRole(role, guardian);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, role));
        escrow.grantRole(role, newGuardian);
        vm.stopPrank();

        // The guardian can rotate itself.
        vm.startPrank(guardian);
        escrow.grantRole(role, newGuardian);
        escrow.renounceRole(role, guardian);
        vm.stopPrank();
        assertTrue(escrow.hasRole(role, newGuardian));
        assertFalse(escrow.hasRole(role, guardian));
    }

    function test_guardian_replacementBehind7DayTimelock() public {
        bytes32 role = escrow.GUARDIAN_ROLE();
        // A second (compromised) guardian member is also removed by the replacement.
        address rogue = makeAddr("rogue");
        vm.prank(guardian);
        escrow.grantRole(role, rogue);

        vm.startPrank(admin);
        vm.expectRevert(IFlockedEscrow.ZeroAddress.selector);
        escrow.scheduleGuardianReplacement(address(0));
        escrow.scheduleGuardianReplacement(newGuardian);
        uint256 readyAt = block.timestamp + 7 days;
        vm.warp(readyAt - 1);
        bytes32 action = escrow.ACTION_GUARDIAN();
        vm.expectRevert(_notReady(action, abi.encode(newGuardian), readyAt));
        escrow.executeGuardianReplacement(newGuardian);
        vm.warp(readyAt);
        vm.expectEmit(true, false, false, false, address(escrow));
        emit IFlockedEscrow.GuardianReplaced(newGuardian);
        escrow.executeGuardianReplacement(newGuardian);
        vm.stopPrank();

        assertTrue(escrow.hasRole(role, newGuardian));
        assertFalse(escrow.hasRole(role, guardian));
        assertFalse(escrow.hasRole(role, rogue));
        assertEq(escrow.getRoleMemberCount(role), 1);
    }

    function test_guardian_replacementCancel() public {
        vm.startPrank(admin);
        escrow.scheduleGuardianReplacement(newGuardian);
        escrow.cancelGuardianReplacement(newGuardian);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                IFlockedEscrow.NotScheduled.selector, _id(escrow.ACTION_GUARDIAN(), abi.encode(newGuardian))
            )
        );
        escrow.executeGuardianReplacement(newGuardian);
        vm.stopPrank();
    }

    function test_pauserGrantAndRevoke() public {
        bytes32 role = escrow.PAUSER_ROLE();
        address p2 = makeAddr("pauser2");
        vm.prank(admin);
        escrow.grantRole(role, p2);
        vm.prank(p2);
        escrow.pause();
        vm.prank(admin);
        escrow.revokeRole(role, p2);
        vm.prank(p2);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, p2, role));
        escrow.unpause();
    }

    // ---------------------------------------------------------------- rescue

    function test_rescue_onlyAboveObligations() public {
        _populate(_cfg(), 2, 5, 0); // 35 USDC owed
        usdc.mint(address(escrow), 7e6); // sent by other means
        address to = makeAddr("rescueTo");

        vm.startPrank(admin);
        vm.expectRevert(IFlockedEscrow.ZeroAddress.selector);
        escrow.scheduleRescue(address(usdc), address(0), 1);
        escrow.scheduleRescue(address(usdc), to, 7e6 + 1);
        escrow.scheduleRescue(address(usdc), to, 7e6);
        uint256 readyAt = block.timestamp + 72 hours;
        vm.warp(readyAt - 1);
        bytes32 action = escrow.ACTION_RESCUE();
        vm.expectRevert(_notReady(action, abi.encode(address(usdc), to, uint256(7e6)), readyAt));
        escrow.executeRescue(address(usdc), to, 7e6);
        vm.warp(readyAt);
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.RescueExceedsSurplus.selector, 7e6 + 1, 7e6));
        escrow.executeRescue(address(usdc), to, 7e6 + 1);
        escrow.executeRescue(address(usdc), to, 7e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(to), 7e6);
        assertEq(usdc.balanceOf(address(escrow)), escrow.totalObligations());
    }

    function test_rescue_otherTokenAndCancel() public {
        MockUSDC other = new MockUSDC();
        other.mint(address(escrow), 3e6);
        address to = makeAddr("rescueTo");
        vm.startPrank(admin);
        escrow.scheduleRescue(address(other), to, 3e6);
        escrow.scheduleRescue(address(usdc), to, 1);
        escrow.cancelRescue(address(usdc), to, 1);
        vm.warp(block.timestamp + 72 hours);
        escrow.executeRescue(address(other), to, 3e6);
        vm.stopPrank();
        assertEq(other.balanceOf(to), 3e6);
    }

    function test_rescue_nothingWhenNoSurplus() public {
        _populate(_cfg(), 2, 5, 0);
        vm.startPrank(admin);
        escrow.scheduleRescue(address(usdc), admin, 1);
        vm.warp(block.timestamp + 72 hours);
        vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.RescueExceedsSurplus.selector, 1, 0));
        escrow.executeRescue(address(usdc), admin, 1);
        vm.stopPrank();
    }
}
