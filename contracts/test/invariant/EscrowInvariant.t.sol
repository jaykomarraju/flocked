// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console} from "forge-std/console.sol";

import {IFlockedEscrow} from "../../src/interfaces/IFlockedEscrow.sol";
import {EscrowBase} from "../utils/EscrowBase.sol";
import {EscrowHandler} from "./EscrowHandler.sol";

/// @notice CON-8 (no round both settled and refunded), CON-12 (USDC held >= outstanding obligations) and CON-7's
///         single guardian (GUARDIAN_ROLE always has exactly one holder).
contract EscrowInvariantTest is StdInvariant, EscrowBase {
    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(escrow, usdc, signerPk, admin, operator, pauser, treasury);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](18);
        selectors[0] = EscrowHandler.createRound.selector;
        selectors[1] = EscrowHandler.enter.selector;
        selectors[2] = EscrowHandler.propose.selector;
        selectors[3] = EscrowHandler.veto.selector;
        selectors[4] = EscrowHandler.finalize.selector;
        selectors[5] = EscrowHandler.claim.selector;
        selectors[6] = EscrowHandler.claimRefund.selector;
        selectors[7] = EscrowHandler.voidRound.selector;
        selectors[8] = EscrowHandler.refundTooFew.selector;
        selectors[9] = EscrowHandler.refundTimeout.selector;
        selectors[10] = EscrowHandler.withdraw.selector;
        selectors[11] = EscrowHandler.togglePause.selector;
        selectors[12] = EscrowHandler.donate.selector;
        selectors[13] = EscrowHandler.warp.selector;
        selectors[14] = EscrowHandler.claimAll.selector;
        selectors[15] = EscrowHandler.transferGuardian.selector;
        selectors[16] = EscrowHandler.tryGuardianRoleChange.selector;
        selectors[17] = EscrowHandler.replaceGuardian.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Every round's unpaid entitlement, computed from round state alone, plus credited fee balances.
    function _outstanding() internal view returns (uint256 total) {
        uint256 n = escrow.roundCount();
        for (uint256 id = 1; id <= n; id++) {
            IFlockedEscrow.Round memory rd = escrow.getRound(id);
            if (rd.status == IFlockedEscrow.Status.Settled) {
                (uint256 nM, uint256 nL) = rd.winner == 0 ? (rd.n0, rd.n1) : (rd.n1, rd.n0);
                total += (nM - rd.winClaims) * uint256(rd.winPayout) + (nL - rd.rebateClaims) * uint256(rd.rebatePayout)
                    + (uint256(rd.nVoid) - rd.voidClaims) * rd.cfg.stake;
            } else if (rd.status == IFlockedEscrow.Status.Refunded) {
                total += uint256(rd.entryCount - rd.refundClaims) * rd.cfg.stake;
            } else {
                total += rd.roundBalance;
            }
        }
        address[] memory accts = handler.trackedAccounts();
        for (uint256 i; i < accts.length; i++) {
            total += escrow.withdrawable(accts[i]);
        }
    }

    /// @notice CON-12: the escrow always holds at least what it owes.
    function invariant_usdcHeldCoversObligations() public view {
        assertGe(usdc.balanceOf(address(escrow)), _outstanding());
    }

    /// @notice The contract's own running total equals the independently computed obligations.
    function invariant_totalObligationsMatchesRounds() public view {
        assertEq(escrow.totalObligations(), _outstanding());
    }

    /// @notice CON-8: no round is ever both settled and refunded, and every transition follows the state machine.
    function invariant_neverBothSettledAndRefunded() public view {
        uint256 n = escrow.roundCount();
        for (uint256 id = 1; id <= n; id++) {
            assertFalse(handler.everSettled(id) && handler.everRefunded(id), "settled and refunded");
        }
        assertFalse(handler.badTransition(), "illegal status transition");
        assertFalse(handler.overClaimed(), "claim past a per-kind cap succeeded");
    }

    /// @notice Claims never exceed the posted tally, per kind.
    function invariant_claimsWithinTally() public view {
        uint256 n = escrow.roundCount();
        for (uint256 id = 1; id <= n; id++) {
            IFlockedEscrow.Round memory rd = escrow.getRound(id);
            (uint256 nM, uint256 nL) = rd.winner == 0 ? (rd.n0, rd.n1) : (rd.n1, rd.n0);
            if (rd.status == IFlockedEscrow.Status.Settled) {
                assertLe(rd.winClaims, nM);
                assertLe(rd.rebateClaims, nL);
                assertLe(rd.voidClaims, rd.nVoid);
                assertEq(rd.refundClaims, 0);
            } else {
                assertEq(uint256(rd.winClaims) + rd.rebateClaims + rd.voidClaims, 0);
                assertLe(rd.refundClaims, rd.entryCount);
            }
        }
    }

    /// @notice CON-7: GUARDIAN_ROLE always has exactly one holder, the one the handler last handed it to.
    function invariant_exactlyOneGuardian() public view {
        bytes32 role = escrow.GUARDIAN_ROLE();
        assertEq(escrow.getRoleMemberCount(role), 1, "guardian holders");
        assertEq(escrow.guardian(), handler.expectedGuardian(), "guardian");
        assertTrue(escrow.hasRole(role, escrow.guardian()));
    }

    /// @dev Debug aid: `forge test --mt invariant -vv` prints how far runs get.
    function afterInvariant() external view {
        uint256 settled;
        uint256 refunded;
        for (uint256 id = 1; id <= escrow.roundCount(); id++) {
            if (handler.everSettled(id)) settled++;
            if (handler.everRefunded(id)) refunded++;
        }
        console.log("rounds", escrow.roundCount(), "settled", settled);
        console.log("refunded", refunded, "claims", handler.calls("claim"));
        console.log(
            "guardian transfers", handler.calls("transferGuardian"), "replacements", handler.calls("replaceGuardian")
        );
    }
}
