// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {FlockedEscrow} from "../../src/FlockedEscrow.sol";
import {IFlockedEscrow} from "../../src/interfaces/IFlockedEscrow.sol";
import {StakesMath} from "../../src/lib/StakesMath.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {TestMerkle} from "../utils/TestMerkle.sol";

/// @notice Drives the escrow through every lifecycle path. Each action checks its own preconditions and only makes
///         calls that must succeed (the suite runs with `fail_on_revert`), so an unexpected revert is a failure.
///         Proposals use arbitrary tallies (any split of the entrants) and optionally an over-generous payout tree
///         that gives every entrant every kind of leaf, so the per-kind claim caps are what keep the round solvent.
contract EscrowHandler is Test {
    FlockedEscrow public immutable escrow;
    MockUSDC public immutable usdc;
    uint256 internal immutable signerPk;
    address internal immutable operator;
    address internal immutable guardian;
    address internal immutable pauser;
    address internal immutable treasury;

    uint256 public constant MAX_ROUNDS = 6;
    uint256 public constant N_ACTORS = 16;

    address[] public actors;
    address[] public creators;

    // Per-round ghost state.
    mapping(uint256 => address[]) internal _entrants;
    mapping(uint256 => bytes32[]) internal _leaves;
    mapping(uint256 => address[]) internal _leafAccounts;
    mapping(uint256 => uint8[]) internal _leafKinds;
    mapping(uint256 => bool) public everSettled;
    mapping(uint256 => bool) public everRefunded;
    mapping(uint256 => IFlockedEscrow.Status) public lastStatus;
    bool public badTransition;
    bool public overClaimed;

    mapping(bytes32 => uint256) public calls;

    constructor(
        FlockedEscrow escrow_,
        MockUSDC usdc_,
        uint256 signerPk_,
        address operator_,
        address guardian_,
        address pauser_,
        address treasury_
    ) {
        escrow = escrow_;
        usdc = usdc_;
        signerPk = signerPk_;
        operator = operator_;
        guardian = guardian_;
        pauser = pauser_;
        treasury = treasury_;
        for (uint256 i; i < N_ACTORS; i++) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
        creators.push(makeAddr("creatorA"));
        creators.push(makeAddr("creatorB"));
        creators.push(treasury_);
    }

    modifier record(bytes32 name) {
        calls[name]++;
        _;
        _recordStatuses();
    }

    // ---------------------------------------------------------------- actions

    function createRound(uint256 seed) external record("createRound") {
        if (escrow.roundCount() >= MAX_ROUNDS) return;
        seed = uint256(keccak256(abi.encode(seed))); // fuzz seeds are often 0, small or all ones
        IFlockedEscrow.RoundConfig memory cfg;
        cfg.opensAt = uint64(block.timestamp + 1);
        cfg.closesAt = cfg.opensAt + uint64(bound(seed, 1 minutes, 2 days));
        uint256 t = uint256(cfg.closesAt) + 60 + (seed >> 8) % 538; // beacon time <= t + PERIOD - 1
        cfg.beaconRound = uint64((t - escrow.GENESIS() + escrow.PERIOD() - 1) / escrow.PERIOD() + 1);
        cfg.stake = uint128(bound(seed >> 16, 1e6, 100e6));
        cfg.feeBps = uint16(bound(seed >> 48, 0, 500));
        cfg.creatorBps = uint16(bound(seed >> 64, 0, 100));
        cfg.capMultiple = uint8((seed >> 80) % 2 == 0 ? 1 + (seed >> 81) % 3 : 1 + (seed >> 81) % 10); // small caps make rebates
        cfg.minEntrants = uint32(bound(seed >> 96, 1, 5));
        cfg.creator = creators[(seed >> 112) % creators.length];
        cfg.questionHash = keccak256(abi.encode(seed));
        vm.prank(operator);
        escrow.createRound(cfg);
    }

    /// @dev Enters one to four actors (starting at `actorSeed`) into the round.
    function enter(uint256 roundSeed, uint256 actorSeed, uint256 lenSeed) external record("enter") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok || escrow.paused()) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (rd.status != IFlockedEscrow.Status.Open) return;
        if (block.timestamp < rd.cfg.opensAt) vm.warp(rd.cfg.opensAt);
        if (block.timestamp >= rd.cfg.closesAt) return;
        uint256 count = 1 + (lenSeed >> 16) % 4;
        for (uint256 k; k < count; k++) {
            _enterOne(id, rd.cfg.stake, actors[(actorSeed % N_ACTORS + k) % N_ACTORS], bound(lenSeed, 64, 2048));
        }
    }

    function _enterOne(uint256 id, uint256 stake, address a, uint256 len) internal {
        if (escrow.hasEntered(id, a)) return;
        usdc.mint(a, stake);
        vm.prank(a);
        usdc.approve(address(escrow), stake);
        IFlockedEscrow.EntryTicket memory t =
            IFlockedEscrow.EntryTicket(id, a, keccak256(abi.encode("tag", id, a)), uint64(block.timestamp + 5 minutes));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, escrow.ticketDigest(t));
        vm.prank(a);
        escrow.enter(id, new bytes(len), t, abi.encodePacked(r, s, v));
        _entrants[id].push(a);
    }

    function propose(uint256 roundSeed, uint256 split, bool generousTree) external record("propose") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (rd.status != IFlockedEscrow.Status.Open) return;
        uint256 bt = escrow.beaconTime(rd.cfg.beaconRound);
        if (block.timestamp < bt) vm.warp(bt);
        if (block.timestamp >= uint256(rd.cfg.closesAt) + escrow.REFUND_TIMEOUT()) return;

        // Any split of the entrants is a tally the operator could post.
        split = uint256(keccak256(abi.encode(split)));
        (uint256 n0, uint256 n1, uint256 nVoid) = _split(rd.entryCount, split);
        StakesMath.Outcome memory o = StakesMath.compute(
            rd.cfg.stake, rd.cfg.feeBps, rd.cfg.creatorBps, rd.cfg.capMultiple, rd.cfg.minEntrants, n0, n1, nVoid
        );

        bytes32 root;
        if (o.status == StakesMath.STATUS_SETTLE) {
            // Mode 0-2: every entrant gets a leaf of that kind; 3: of every kind; 4+: the honest tree.
            uint256 mode = generousTree ? (split >> 64) % 4 : 4;
            root = _buildTree(id, n0, n1, o.winner, o.r > 0, mode);
        } else {
            _clearTree(id);
        }
        vm.prank(operator);
        escrow.propose(id, uint32(n0), uint32(n1), uint32(nVoid), root, keccak256(abi.encode("bundle", id)));
    }

    function veto(uint256 roundSeed) external record("veto") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (!_proposed(rd.status) || block.timestamp >= rd.claimsOpenAt) return;
        vm.prank(guardian);
        escrow.veto(id, keccak256("evidence"));
    }

    function finalize(uint256 roundSeed) external record("finalize") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (!_proposed(rd.status)) return;
        if (block.timestamp < rd.claimsOpenAt) vm.warp(rd.claimsOpenAt);
        escrow.finalize(id);
    }

    function claim(uint256 roundSeed, uint256 leafSeed) external record("claim") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (rd.status == IFlockedEscrow.Status.SettleProposed && block.timestamp < rd.claimsOpenAt) {
            vm.warp(rd.claimsOpenAt);
        }
        if (rd.status != IFlockedEscrow.Status.Settled && rd.status != IFlockedEscrow.Status.SettleProposed) return;
        uint256 nLeaves = _leaves[id].length;
        if (nLeaves == 0) return;
        _tryClaim(id, leafSeed % nLeaves);
    }

    /// @dev Walks every leaf of the round, claiming wherever the contract must pay.
    function claimAll(uint256 roundSeed) external record("claimAll") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (rd.status == IFlockedEscrow.Status.SettleProposed && block.timestamp < rd.claimsOpenAt) {
            vm.warp(rd.claimsOpenAt);
        }
        if (rd.status != IFlockedEscrow.Status.Settled && rd.status != IFlockedEscrow.Status.SettleProposed) return;
        uint256 nLeaves = _leaves[id].length;
        for (uint256 i; i < nLeaves; i++) {
            _tryClaim(id, i);
        }
    }

    function _tryClaim(uint256 id, uint256 idx) internal {
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        address a = _leafAccounts[id][idx];
        uint8 kind = _leafKinds[id][idx];
        if (escrow.hasClaimed(id, a)) return _expectCapped(id, idx, a, kind);

        (uint256 nM, uint256 nL) = rd.winner == 0 ? (rd.n0, rd.n1) : (rd.n1, rd.n0);
        uint256 amount;
        if (kind == 0) {
            if (rd.winClaims >= nM) return _expectCapped(id, idx, a, kind);
            amount = rd.winPayout;
        } else if (kind == 1) {
            if (rd.rebateClaims >= nL) return _expectCapped(id, idx, a, kind);
            amount = rd.rebatePayout;
        } else {
            if (rd.voidClaims >= rd.nVoid) return _expectCapped(id, idx, a, kind);
            amount = rd.cfg.stake;
        }
        if (amount == 0) return;

        bytes32[] memory proof = TestMerkle.proof(_leaves[id], idx);
        uint256 before = usdc.balanceOf(a);
        vm.prank(a);
        escrow.claim(id, IFlockedEscrow.Kind(kind), proof);
        assertEq(usdc.balanceOf(a) - before, amount, "claim amount");
    }

    /// @dev A claim past the kind's cap, or a second claim, must revert. The escrow is topped up first so the probe
    ///      fails on the missing check rather than on an empty balance, then restored.
    function _expectCapped(uint256 id, uint256 idx, address a, uint8 kind) internal {
        calls["probe"]++;
        bytes32[] memory proof = TestMerkle.proof(_leaves[id], idx);
        uint256 bal = usdc.balanceOf(address(escrow));
        deal(address(usdc), address(escrow), bal + 2_000e6);
        vm.prank(a);
        try escrow.claim(id, IFlockedEscrow.Kind(kind), proof) {
            overClaimed = true;
        } catch {
            deal(address(usdc), address(escrow), bal);
        }
    }

    function claimRefund(uint256 roundSeed, uint256 actorSeed) external record("claimRefund") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        bool due = rd.status == IFlockedEscrow.Status.RefundProposed && block.timestamp >= rd.claimsOpenAt;
        if (rd.status != IFlockedEscrow.Status.Refunded && !due) return;
        address[] storage es = _entrants[id];
        if (es.length == 0) return;
        address a = es[actorSeed % es.length];
        if (escrow.hasClaimed(id, a)) return;
        uint256 before = usdc.balanceOf(a);
        vm.prank(a);
        escrow.claimRefund(id);
        assertEq(usdc.balanceOf(a) - before, rd.cfg.stake, "refund amount");
    }

    /// @dev Acts on one call in four, so rounds usually live long enough to settle.
    function voidRound(uint256 roundSeed, bool byGuardian) external record("voidRound") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok || (roundSeed >> 128) % 4 != 0) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (rd.status != IFlockedEscrow.Status.Open || block.timestamp >= rd.cfg.closesAt) return;
        vm.prank(byGuardian ? guardian : operator);
        escrow.voidRound(id);
    }

    function refundTooFew(uint256 roundSeed) external record("refundTooFew") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (rd.status != IFlockedEscrow.Status.Open || rd.entryCount >= rd.cfg.minEntrants) return;
        if (block.timestamp < rd.cfg.closesAt) {
            if ((roundSeed >> 128) % 4 != 0) return; // warp ahead only sometimes
            vm.warp(rd.cfg.closesAt);
        }
        escrow.refundTooFew(id);
    }

    function refundTimeout(uint256 roundSeed) external record("refundTimeout") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (rd.status != IFlockedEscrow.Status.Open) return;
        uint256 t = uint256(rd.cfg.closesAt) + escrow.REFUND_TIMEOUT();
        if (block.timestamp < t) {
            if ((roundSeed >> 128) % 8 != 0) return; // warp ahead only rarely
            vm.warp(t);
        }
        escrow.refundTimeout(id);
    }

    function withdraw(uint256 who) external record("withdraw") {
        address a = creators[who % creators.length];
        if (escrow.withdrawable(a) == 0) return;
        uint256 before = usdc.balanceOf(a);
        uint256 owed = escrow.withdrawable(a);
        vm.prank(a);
        escrow.withdraw();
        assertEq(usdc.balanceOf(a) - before, owed, "withdraw amount");
    }

    function togglePause() external record("togglePause") {
        bool paused = escrow.paused();
        vm.prank(pauser);
        if (paused) escrow.unpause();
        else escrow.pause();
    }

    function donate(uint256 amount) external record("donate") {
        usdc.mint(address(escrow), bound(amount, 1, 50e6));
    }

    function warp(uint256 dt) external record("warp") {
        vm.warp(block.timestamp + bound(dt, 1, 2 hours));
    }

    // ---------------------------------------------------------------- views for the invariants

    function trackedAccounts() external view returns (address[] memory) {
        return creators;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Three in four tallies are shaped to settle when the headcount allows; the rest are arbitrary splits.
    function _split(uint256 n, uint256 seed) internal pure returns (uint256 n0, uint256 n1, uint256 nVoid) {
        if (seed % 4 != 0 && n >= 3) {
            nVoid = (seed >> 8) % 2;
            uint256 m = n - nVoid;
            n0 = 1 + (seed >> 16) % (m - 1);
            n1 = m - n0;
            if (n0 == n1) {
                n1 -= 1;
                nVoid += 1;
            }
            return (n0, n1, nVoid);
        }
        n0 = n == 0 ? 0 : seed % (n + 1);
        n1 = n - n0 == 0 ? 0 : (seed >> 32) % (n - n0 + 1);
        nVoid = n - n0 - n1;
    }

    function _clearTree(uint256 id) internal {
        delete _leaves[id];
        delete _leafAccounts[id];
        delete _leafKinds[id];
    }

    function _buildTree(uint256 id, uint256 n0, uint256 n1, uint8 winner, bool rebates, uint256 mode)
        internal
        returns (bytes32)
    {
        _clearTree(id);
        address[] storage es = _entrants[id];
        for (uint256 i; i < es.length; i++) {
            if (mode < 4) {
                for (uint8 k; k < 3; k++) {
                    if (mode == 3 || mode == k) _pushLeaf(id, es[i], k);
                }
                continue;
            }
            // Honest tree for this tally: first n0 on option 0, next n1 on option 1, rest VOID.
            if (i >= n0 + n1) _pushLeaf(id, es[i], 2);
            else if ((i < n0 ? 0 : 1) == winner) _pushLeaf(id, es[i], 0);
            else if (rebates) _pushLeaf(id, es[i], 1);
        }
        return _leaves[id].length == 0 ? keccak256("empty") : TestMerkle.root(_leaves[id]);
    }

    function _pushLeaf(uint256 id, address a, uint8 kind) internal {
        _leaves[id].push(TestMerkle.leaf(id, a, kind));
        _leafAccounts[id].push(a);
        _leafKinds[id].push(kind);
    }

    function _pickRound(uint256 seed) internal view returns (bool, uint256) {
        uint256 n = escrow.roundCount();
        if (n == 0) return (false, 0);
        return (true, seed % n + 1);
    }

    function _proposed(IFlockedEscrow.Status s) internal pure returns (bool) {
        return s == IFlockedEscrow.Status.SettleProposed || s == IFlockedEscrow.Status.RefundProposed;
    }

    /// @dev Records status history and flags any transition outside the spec's state machine.
    function _recordStatuses() internal {
        uint256 n = escrow.roundCount();
        for (uint256 id = 1; id <= n; id++) {
            IFlockedEscrow.Status s = escrow.getRound(id).status;
            IFlockedEscrow.Status prev = lastStatus[id];
            if (s != prev && !_allowed(prev, s)) badTransition = true;
            if (s == IFlockedEscrow.Status.Settled) everSettled[id] = true;
            if (s == IFlockedEscrow.Status.Refunded) everRefunded[id] = true;
            lastStatus[id] = s;
        }
    }

    function _allowed(IFlockedEscrow.Status a, IFlockedEscrow.Status b) internal pure returns (bool) {
        if (a == IFlockedEscrow.Status.None) return b == IFlockedEscrow.Status.Open;
        if (a == IFlockedEscrow.Status.Open) {
            return b == IFlockedEscrow.Status.SettleProposed || b == IFlockedEscrow.Status.RefundProposed
                || b == IFlockedEscrow.Status.Refunded;
        }
        if (a == IFlockedEscrow.Status.SettleProposed) {
            return b == IFlockedEscrow.Status.Settled || b == IFlockedEscrow.Status.Refunded;
        }
        if (a == IFlockedEscrow.Status.RefundProposed) {
            return b == IFlockedEscrow.Status.Refunded || b == IFlockedEscrow.Status.Open;
        }
        return false; // Settled and Refunded are terminal
    }
}
