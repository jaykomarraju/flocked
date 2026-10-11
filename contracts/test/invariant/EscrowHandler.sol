// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";

import {FlockedEscrow} from "../../src/FlockedEscrow.sol";
import {IFlockedEscrow} from "../../src/interfaces/IFlockedEscrow.sol";
import {StakesMath} from "../../src/lib/StakesMath.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {TestMerkle} from "../utils/TestMerkle.sol";

/// @notice Drives the escrow through every lifecycle path. Each action checks its own preconditions and only makes
///         calls that must succeed (the suite runs with `fail_on_revert`), so an unexpected revert is a failure.
///         Proposals use arbitrary tallies (any split of the entrants) and optionally an over-generous payout tree
///         that gives every entrant every kind of leaf (and a non-entrant every kind too), so the per-kind claim
///         caps and the entrant check are what keep the round solvent. Every escrow event is tallied into per-round
///         ghost totals (paid out, fees credited, claims per account) that the invariants reconcile with the state.
contract EscrowHandler is Test {
    FlockedEscrow public immutable escrow;
    MockUSDC public immutable usdc;
    uint256 internal immutable signerPk;
    address internal immutable admin;
    address internal immutable operator;
    address internal immutable pauser;
    address internal immutable treasury;

    uint256 public constant MAX_ROUNDS = 8;
    uint256 public constant N_ACTORS = 16;

    address[] public actors;
    address[] public creators;
    address[] public guardianCandidates;
    /// @notice Never enters a round, but over-generous trees give it leaves.
    address public immutable stranger;

    /// @notice Who the handler expects to hold GUARDIAN_ROLE.
    address public expectedGuardian;
    address internal pendingReplacement;

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

    // Ghost totals from the escrow's events.
    /// @notice USDC paid to entrants per round (`Claimed` plus `RefundClaimed` amounts).
    mapping(uint256 => uint256) public paid;
    /// @notice Fees credited per round at finalize (`Credited` amounts, attributed to the next `RoundFinalized`).
    mapping(uint256 => uint256) public creditedFor;
    /// @notice `Claimed` plus `RefundClaimed` events per round and account.
    mapping(uint256 => mapping(address => uint256)) public claimEvents;
    /// @notice `Claimed` events per round and kind (0-2), and `RefundClaimed` events per round (index 3).
    mapping(uint256 => uint256[4]) internal _claimsByKind;
    /// @notice `Entered` events per round.
    mapping(uint256 => uint256) public enteredEvents;
    /// @notice Every `Credited` amount, and every `Withdrawn` amount.
    uint256 public creditedTotal;
    uint256 public withdrawnTotal;
    uint256 internal _pendingCredit;
    /// @notice Set if a claim that must revert (wrong status, non-entrant, second claim) succeeded.
    bool public exclusivityBroken;

    mapping(bytes32 => uint256) public calls;

    constructor(
        FlockedEscrow escrow_,
        MockUSDC usdc_,
        uint256 signerPk_,
        address admin_,
        address operator_,
        address pauser_,
        address treasury_
    ) {
        escrow = escrow_;
        usdc = usdc_;
        signerPk = signerPk_;
        admin = admin_;
        operator = operator_;
        pauser = pauser_;
        treasury = treasury_;
        for (uint256 i; i < N_ACTORS; i++) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
        creators.push(makeAddr("creatorA"));
        creators.push(makeAddr("creatorB"));
        creators.push(treasury_);
        expectedGuardian = escrow_.guardian();
        guardianCandidates.push(expectedGuardian);
        for (uint256 i; i < 3; i++) {
            guardianCandidates.push(makeAddr(string.concat("guardian", vm.toString(i))));
        }
        guardianCandidates.push(operator_); // an address that already holds another role
        stranger = makeAddr("stranger");
    }

    modifier record(bytes32 name) {
        calls[name]++;
        vm.recordLogs();
        _;
        _tallyLogs(vm.getRecordedLogs());
        _recordStatuses();
    }

    function claimsByKind(uint256 id, uint256 kind) external view returns (uint256) {
        return _claimsByKind[id][kind];
    }

    // ---------------------------------------------------------------- actions

    function createRound(uint256 seed) external record("createRound") {
        if (escrow.roundCount() >= MAX_ROUNDS) return;
        _createRound(uint256(keccak256(abi.encode(seed))), 2 days); // fuzz seeds are often 0, small or all ones
    }

    /// @dev One round from create to a settle-shaped proposal, with random parameters, tally and tree. Without it
    ///      random interleavings settle almost nothing (one run in 257 measured in W4-C): pauses, far warps by other
    ///      actions and vetoes end most rounds first. It stops early at random, leaving the round Open (to the other
    ///      actions) or SettleProposed (to `veto`, `finalize` and the claims).
    function settleScenario(uint256 seed, bool generousTree) external record("settleScenario") {
        if (escrow.roundCount() >= MAX_ROUNDS) return;
        seed = uint256(keccak256(abi.encode(seed, "scenario")));
        uint256 id = _createRound(seed, 1 hours);
        _recordStatuses(); // each step is a transition the state machine must allow
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        if (escrow.paused()) {
            vm.prank(admin);
            escrow.unpause();
        }
        vm.warp(rd.cfg.opensAt);
        uint256 count = 3 + (seed >> 120) % 10;
        uint256 len = bound(seed >> 136, 64, 2048);
        for (uint256 k; k < count; k++) {
            _enterOne(id, rd.cfg.stake, actors[(seed + k) % N_ACTORS], len);
        }
        if ((seed >> 160) % 5 == 0) return; // leave it Open
        vm.warp(escrow.beaconTime(rd.cfg.beaconRound));
        // `_split` shapes three tallies in four to settle; force the shaped branch here.
        _propose(id, (seed >> 168) | 1, generousTree);
        _recordStatuses();
        if ((seed >> 176) % 2 == 0) return; // leave the proposal to the challenge window
        rd = escrow.getRound(id);
        vm.warp(rd.claimsOpenAt);
        escrow.finalize(id);
    }

    function _createRound(uint256 seed, uint256 maxDuration) internal returns (uint256) {
        IFlockedEscrow.RoundConfig memory cfg;
        cfg.opensAt = uint64(block.timestamp + 1);
        cfg.closesAt = cfg.opensAt + uint64(bound(seed, 1 minutes, maxDuration));
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
        return escrow.createRound(cfg);
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
        _propose(id, uint256(keccak256(abi.encode(split))), generousTree);
    }

    /// @dev Posts a tally from `split` (any split of the entrants is a tally the operator could post).
    function _propose(uint256 id, uint256 split, bool generousTree) internal {
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
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
        vm.prank(escrow.guardian());
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
        if (!escrow.hasEntered(id, a)) return _expectNotEntrant(id, idx, a, kind);
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
        _beginProbe();
        bytes32[] memory proof = TestMerkle.proof(_leaves[id], idx);
        uint256 bal = usdc.balanceOf(address(escrow));
        deal(address(usdc), address(escrow), bal + 2_000e6);
        vm.prank(a);
        try escrow.claim(id, IFlockedEscrow.Kind(kind), proof) {
            overClaimed = true;
        } catch {
            deal(address(usdc), address(escrow), bal);
        }
        _endProbe();
    }

    /// @dev A leaf for an address that never entered must not pay, even with a valid proof.
    function _expectNotEntrant(uint256 id, uint256 idx, address a, uint8 kind) internal {
        calls["probeStranger"]++;
        _beginProbe();
        bytes32[] memory proof = TestMerkle.proof(_leaves[id], idx);
        vm.prank(a);
        vm.expectRevert(IFlockedEscrow.NotEntrant.selector);
        escrow.claim(id, IFlockedEscrow.Kind(kind), proof);
        _endProbe();
    }

    /// @dev Claim exclusivity: on any round, tries a claim path that must revert for the chosen account (an entrant,
    ///      someone who already claimed, or the stranger) and flags it if it pays. The escrow is topped up first, so a
    ///      probe fails on the missing check rather than on an empty balance.
    function probeExclusivity(uint256 roundSeed, uint256 actorSeed, uint8 kindSeed) external record("probe") {
        (bool ok, uint256 id) = _pickRound(roundSeed);
        if (!ok) return;
        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        IFlockedEscrow.Status st = rd.status;
        // claim and claimRefund finalize a due proposal first, so probe against the status they will see.
        if (_proposed(st) && block.timestamp >= rd.claimsOpenAt) {
            st = st == IFlockedEscrow.Status.SettleProposed
                ? IFlockedEscrow.Status.Settled
                : IFlockedEscrow.Status.Refunded;
        }
        address[] storage es = _entrants[id];
        address a = es.length == 0 || actorSeed % 4 == 0 ? stranger : es[(actorSeed >> 8) % es.length];
        IFlockedEscrow.Kind kind = IFlockedEscrow.Kind(kindSeed % 3);
        bytes32[] memory proof = new bytes32[](0);

        _beginProbe();
        uint256 bal = usdc.balanceOf(address(escrow));
        deal(address(usdc), address(escrow), bal + 2_000e6);
        vm.startPrank(a);
        if (st == IFlockedEscrow.Status.Settled) {
            // No refunds from a settled round, for anyone.
            try escrow.claimRefund(id) {
                exclusivityBroken = true;
            } catch {}
        } else if (st == IFlockedEscrow.Status.Refunded) {
            // No payouts from a refunded round; refunds only for entrants, once.
            try escrow.claim(id, kind, proof) {
                exclusivityBroken = true;
            } catch {}
            if (a == stranger || escrow.hasClaimed(id, a)) {
                try escrow.claimRefund(id) {
                    exclusivityBroken = true;
                } catch {}
            }
        } else {
            // Nothing is claimable before an outcome is final.
            try escrow.claim(id, kind, proof) {
                exclusivityBroken = true;
            } catch {}
            try escrow.claimRefund(id) {
                exclusivityBroken = true;
            } catch {}
        }
        vm.stopPrank();
        deal(address(usdc), address(escrow), bal);
        _endProbe();
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
        vm.prank(byGuardian ? escrow.guardian() : operator);
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

    /// @dev Pause is the pauser's; unpause is the admin's only (the pauser's attempt must revert).
    function togglePause() external record("togglePause") {
        if (escrow.paused()) {
            vm.prank(pauser);
            vm.expectRevert();
            escrow.unpause();
            vm.prank(admin);
            escrow.unpause();
        } else {
            vm.prank(pauser);
            escrow.pause();
        }
    }

    // ---------------------------------------------------------------- guardian (single holder)

    /// @dev The guardian hands the role to a candidate (possibly itself, or the operator).
    function transferGuardian(uint256 who) external record("transferGuardian") {
        address next = guardianCandidates[who % guardianCandidates.length];
        vm.prank(escrow.guardian());
        escrow.transferGuardian(next);
        expectedGuardian = next;
    }

    /// @dev Every direct grant, revoke or renounce of GUARDIAN_ROLE reverts, whoever calls it.
    function tryGuardianRoleChange(uint256 who, uint8 op) external record("tryGuardianRoleChange") {
        bytes32 role = escrow.GUARDIAN_ROLE();
        address current = escrow.guardian();
        address target = guardianCandidates[who % guardianCandidates.length];
        // Grant to anyone, revoke the holder, or renounce as the holder; each by the guardian, the admin or the target.
        address caller = [current, admin, target][(who >> 128) % 3];
        vm.startPrank(caller);
        vm.expectRevert(IFlockedEscrow.SingleGuardian.selector);
        if (op % 3 == 0) escrow.grantRole(role, target);
        else if (op % 3 == 1) escrow.revokeRole(role, current);
        else escrow.renounceRole(role, caller);
        vm.stopPrank();
    }

    /// @dev Schedules a 7-day replacement, or executes the pending one. It warps to it only one time in eight, since a
    ///      7-day jump times out every open round and would starve the settlement paths the other invariants need.
    function replaceGuardian(uint256 who) external record("replaceGuardian") {
        if (pendingReplacement == address(0)) {
            pendingReplacement = guardianCandidates[who % guardianCandidates.length];
            vm.prank(admin);
            escrow.scheduleGuardianReplacement(pendingReplacement);
            return;
        }
        bytes32 id = escrow.operationId(escrow.ACTION_GUARDIAN(), abi.encode(pendingReplacement));
        uint256 readyAt = escrow.timelockReadyAt(id);
        if (block.timestamp < readyAt) {
            if ((who >> 128) % 8 != 0) return;
            vm.warp(readyAt);
        }
        vm.prank(admin);
        escrow.executeGuardianReplacement(pendingReplacement);
        expectedGuardian = pendingReplacement;
        pendingReplacement = address(0);
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
        if (mode == 3) {
            for (uint8 k; k < 3; k++) {
                _pushLeaf(id, stranger, k);
            }
        }
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

    /// @dev Foundry records logs from reverted calls too, and a reverting claim may have finalized (and credited) first.
    ///      So a probe tallies the real logs so far, and drops whatever the probe emitted.
    function _beginProbe() internal {
        _tallyLogs(vm.getRecordedLogs());
    }

    /// @dev `getRecordedLogs` is declared view but drains the buffer, so this discards the probe's logs.
    function _endProbe() internal view {
        vm.getRecordedLogs();
    }

    /// @dev Tallies the escrow's events into the ghost totals.
    function _tallyLogs(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(escrow)) continue;
            bytes32 t = l.topics[0];
            if (t == IFlockedEscrow.Claimed.selector) {
                uint256 id = uint256(l.topics[1]);
                (uint8 kind, uint256 amount) = abi.decode(l.data, (uint8, uint256));
                paid[id] += amount;
                claimEvents[id][address(uint160(uint256(l.topics[2])))]++;
                _claimsByKind[id][kind]++;
            } else if (t == IFlockedEscrow.RefundClaimed.selector) {
                uint256 id = uint256(l.topics[1]);
                paid[id] += abi.decode(l.data, (uint256));
                claimEvents[id][address(uint160(uint256(l.topics[2])))]++;
                _claimsByKind[id][3]++;
            } else if (t == IFlockedEscrow.Entered.selector) {
                enteredEvents[uint256(l.topics[1])]++;
            } else if (t == IFlockedEscrow.Credited.selector) {
                uint256 amount = abi.decode(l.data, (uint256));
                _pendingCredit += amount;
                creditedTotal += amount;
            } else if (t == IFlockedEscrow.RoundFinalized.selector) {
                // _finalize credits the treasury and the creator just before it emits RoundFinalized.
                creditedFor[uint256(l.topics[1])] += _pendingCredit;
                _pendingCredit = 0;
            } else if (t == IFlockedEscrow.Withdrawn.selector) {
                withdrawnTotal += abi.decode(l.data, (uint256));
            }
        }
        assertEq(_pendingCredit, 0, "Credited without RoundFinalized");
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
