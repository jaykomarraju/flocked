// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console} from "forge-std/console.sol";

import {IFlockedEscrow} from "../../src/interfaces/IFlockedEscrow.sol";
import {StakesMath} from "../../src/lib/StakesMath.sol";
import {EscrowBase} from "../utils/EscrowBase.sol";
import {EscrowHandler} from "./EscrowHandler.sol";

/// @notice CON-8 (no round both settled and refunded), CON-12 (USDC held >= outstanding obligations), CON-7's
///         single guardian (GUARDIAN_ROLE always has exactly one holder), per-round conservation (spec "Settlement and
///         payout math", Invariant) and claim exclusivity (one claim per entrant per round, entrants only).
contract EscrowInvariantTest is StdInvariant, EscrowBase {
    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(escrow, usdc, signerPk, admin, operator, pauser, treasury);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](20);
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
        selectors[18] = EscrowHandler.probeExclusivity.selector;
        selectors[19] = EscrowHandler.settleScenario.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev A round's unpaid entitlement, computed from round state alone.
    function _roundOutstanding(IFlockedEscrow.Round memory rd) internal pure returns (uint256) {
        if (rd.status == IFlockedEscrow.Status.Settled) {
            (uint256 nM, uint256 nL) = rd.winner == 0 ? (rd.n0, rd.n1) : (rd.n1, rd.n0);
            return (nM - rd.winClaims) * uint256(rd.winPayout) + (nL - rd.rebateClaims) * uint256(rd.rebatePayout)
                + (uint256(rd.nVoid) - rd.voidClaims) * rd.cfg.stake;
        }
        if (rd.status == IFlockedEscrow.Status.Refunded) {
            return uint256(rd.entryCount - rd.refundClaims) * rd.cfg.stake;
        }
        return rd.roundBalance;
    }

    /// @dev Every round's unpaid entitlement plus credited fee balances.
    function _outstanding() internal view returns (uint256 total) {
        uint256 n = escrow.roundCount();
        for (uint256 id = 1; id <= n; id++) {
            total += _roundOutstanding(escrow.getRound(id));
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

    /// @notice Per-round conservation: what a round has paid out (from its events), plus the fees it credited, plus
    ///         what it still owes, is exactly its balance, which is `entryCount * stake`. Every settle proposal's
    ///         amounts satisfy the closed-form identity sum(payouts) + F + C + dust = T + V, vetoed ones included.
    function invariant_conservationPerRound() public view {
        uint256 n = escrow.roundCount();
        uint256 credited;
        for (uint256 id = 1; id <= n; id++) {
            IFlockedEscrow.Round memory rd = escrow.getRound(id);
            uint256 stake = rd.cfg.stake;
            assertEq(rd.roundBalance, uint256(rd.entryCount) * stake, "roundBalance != entryCount * stake");
            assertEq(handler.enteredEvents(id), rd.entryCount, "Entered events");
            assertEq(
                handler.paid(id) + handler.creditedFor(id) + _roundOutstanding(rd),
                rd.roundBalance,
                "round conservation"
            );

            uint256 fees = uint256(rd.fee) + rd.creatorFee + rd.dust;
            assertEq(handler.creditedFor(id), rd.status == IFlockedEscrow.Status.Settled ? fees : 0, "credited fees");
            if (rd.winner != StakesMath.NO_WINNER) {
                (uint256 nM, uint256 nL) = rd.winner == 0 ? (rd.n0, rd.n1) : (rd.n1, rd.n0);
                uint256 payouts = nM * rd.winPayout + nL * rd.rebatePayout + uint256(rd.nVoid) * stake;
                assertEq(payouts + fees, rd.roundBalance, "closed-form identity");
            }
            credited += handler.creditedFor(id);
        }
        // Fee balances: everything credited is either still withdrawable or was withdrawn.
        assertEq(credited, handler.creditedTotal(), "credits attributed to rounds");
        uint256 held;
        address[] memory accts = handler.trackedAccounts();
        for (uint256 i; i < accts.length; i++) {
            held += escrow.withdrawable(accts[i]);
        }
        assertEq(held + handler.withdrawnTotal(), handler.creditedTotal(), "fee conservation");
    }

    /// @notice Claim exclusivity: each account claims at most once per round (a payout or a refund, never both), only
    ///         entrants claim, `hasClaimed` matches the events, and per-kind event counts match the round's counters.
    function invariant_claimExclusivity() public view {
        assertFalse(handler.exclusivityBroken(), "a claim that must revert paid");
        uint256 n = escrow.roundCount();
        uint256 nActors = handler.N_ACTORS();
        for (uint256 id = 1; id <= n; id++) {
            for (uint256 i; i <= nActors; i++) {
                address a = i == nActors ? handler.stranger() : handler.actors(i);
                uint256 c = handler.claimEvents(id, a);
                assertLe(c, 1, "claimed twice");
                assertEq(escrow.hasClaimed(id, a), c == 1, "hasClaimed vs events");
                if (c == 1) assertTrue(escrow.hasEntered(id, a), "non-entrant claimed");
            }
            IFlockedEscrow.Round memory rd = escrow.getRound(id);
            assertEq(handler.claimsByKind(id, 0), rd.winClaims, "Win claims");
            assertEq(handler.claimsByKind(id, 1), rd.rebateClaims, "Rebate claims");
            assertEq(handler.claimsByKind(id, 2), rd.voidClaims, "VoidRefund claims");
            assertEq(handler.claimsByKind(id, 3), rd.refundClaims, "refund claims");
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
        console.log("probes", handler.calls("probe"), "stranger leaves", handler.calls("probeStranger"));
        console.log(
            "guardian transfers", handler.calls("transferGuardian"), "replacements", handler.calls("replaceGuardian")
        );
    }
}
