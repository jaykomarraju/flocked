// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title StakesMath
/// @notice The Stakes closed form (Product_Spec.md, "Settlement and payout math"). Every entry has the same stake s,
///         so the outcome depends only on the headcounts. Integer arithmetic, rounding down. Mirrors
///         `settleStakesClosedForm` in the TypeScript settle package (formula version 1).
library StakesMath {
    /// @dev `IFlockedEscrow.Status.SettleProposed`.
    uint8 internal constant STATUS_SETTLE = 2;
    /// @dev `IFlockedEscrow.Status.RefundProposed`.
    uint8 internal constant STATUS_REFUND = 3;
    /// @dev `winner` for a refund.
    uint8 internal constant NO_WINNER = 255;

    uint8 internal constant REASON_TOO_FEW = 1;
    uint8 internal constant REASON_ONE_SIDED = 2;
    uint8 internal constant REASON_TIE = 3;

    uint256 internal constant BPS = 10_000;

    /// @dev Field names follow the P1.1 vector format.
    struct Outcome {
        uint8 status;
        uint8 refundReason;
        uint8 winner;
        uint256 lossPool; // Lp = N_L * s
        uint256 fee; // F
        uint256 creatorFee; // C
        uint256 distributable; // D = Lp - F - C
        uint256 w; // per-winner winnings
        uint256 rebatePool; // R = D - N_M * w
        uint256 r; // per-loser rebate
        uint256 dust; // R - N_L * r
        uint256 winPayout; // s + w
        uint256 rebatePayout; // r
        uint256 voidRefund; // s
        uint256 roundBalance; // (n0 + n1 + nVoid) * s
    }

    /// @notice The refund reason for a tally, or 0 if it settles.
    /// @dev Reasons in spec order: 1 too few valid entries, 2 one-sided, 3 headcount tie.
    function refundReason(uint256 minEntrants, uint256 n0, uint256 n1) internal pure returns (uint8) {
        if (n0 + n1 < minEntrants) return REASON_TOO_FEW;
        if (n0 == 0 || n1 == 0) return REASON_ONE_SIDED;
        if (n0 == n1) return REASON_TIE;
        return 0;
    }

    /// @notice Computes the closed-form outcome for a posted tally.
    /// @param stake s, in USDC base units.
    /// @param feeBps Treasury fee on the loss pool.
    /// @param creatorBps Creator fee on the loss pool.
    /// @param capMultiple Winnings cap as a multiple of s.
    /// @param minEntrants Minimum valid entries for a settlement.
    /// @param n0 Valid entries on option 0.
    /// @param n1 Valid entries on option 1.
    /// @param nVoid VOID entries.
    function compute(
        uint256 stake,
        uint256 feeBps,
        uint256 creatorBps,
        uint256 capMultiple,
        uint256 minEntrants,
        uint256 n0,
        uint256 n1,
        uint256 nVoid
    ) internal pure returns (Outcome memory o) {
        o.voidRefund = stake;
        o.roundBalance = (n0 + n1 + nVoid) * stake;

        uint8 reason = refundReason(minEntrants, n0, n1);
        if (reason != 0) {
            o.status = STATUS_REFUND;
            o.refundReason = reason;
            o.winner = NO_WINNER;
            return o;
        }

        // M is the option with the smaller headcount; no tie reaches here.
        (uint256 nM, uint256 nL) = n0 < n1 ? (n0, n1) : (n1, n0);
        o.status = STATUS_SETTLE;
        o.winner = n0 < n1 ? 0 : 1;

        o.lossPool = nL * stake;
        o.fee = o.lossPool * feeBps / BPS;
        o.creatorFee = o.lossPool * creatorBps / BPS;
        o.distributable = o.lossPool - o.fee - o.creatorFee;

        uint256 uncapped = o.distributable / nM;
        uint256 cap = capMultiple * stake;
        o.w = uncapped < cap ? uncapped : cap;
        o.rebatePool = o.distributable - nM * o.w;
        o.r = o.rebatePool / nL;
        o.dust = o.rebatePool - nL * o.r;

        o.winPayout = stake + o.w;
        o.rebatePayout = o.r;
    }
}
