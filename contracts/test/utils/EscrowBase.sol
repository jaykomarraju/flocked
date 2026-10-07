// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {FlockedEscrow} from "../../src/FlockedEscrow.sol";
import {IFlockedEscrow} from "../../src/interfaces/IFlockedEscrow.sol";
import {StakesMath} from "../../src/lib/StakesMath.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {TestMerkle} from "./TestMerkle.sol";

/// @notice Shared deployment, ticket signing, entry and settlement helpers for the escrow tests.
abstract contract EscrowBase is Test {
    uint64 internal constant GENESIS = 1692803367; // drand quicknet
    uint64 internal constant PERIOD = 3;
    uint256 internal constant START = 1_760_000_000;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TICKET_TYPEHASH =
        keccak256("EntryTicket(uint256 roundId,address wallet,bytes32 personTag,uint64 expiry)");

    MockUSDC internal usdc;
    FlockedEscrow internal escrow;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");
    uint256 internal signerPk = 0xA11CE;
    address internal signer;

    uint256 private _playerNonce;

    /// @dev One proposed settlement: who is where, and the payout tree.
    struct Fixture {
        uint256 roundId;
        address[] option0;
        address[] option1;
        address[] voids;
        bytes32[] leaves;
        address[] leafAccounts;
        uint8[] leafKinds;
        StakesMath.Outcome outcome;
    }

    function setUp() public virtual {
        vm.warp(START);
        signer = vm.addr(signerPk);
        usdc = new MockUSDC();
        escrow = _deploy(address(usdc));
    }

    function _deploy(address token) internal returns (FlockedEscrow) {
        return new FlockedEscrow(MockUSDC(token), admin, guardian, operator, pauser, signer, treasury, GENESIS, PERIOD);
    }

    // ---------------------------------------------------------------- config and rounds

    /// @dev Smallest drand round whose beacon time is >= t.
    function _beaconRoundAt(uint256 t) internal pure returns (uint64) {
        return uint64((t - GENESIS + PERIOD - 1) / PERIOD + 1);
    }

    function _cfg() internal view returns (IFlockedEscrow.RoundConfig memory cfg) {
        cfg.opensAt = uint64(block.timestamp + 1 minutes);
        cfg.closesAt = cfg.opensAt + 1 hours;
        cfg.beaconRound = _beaconRoundAt(cfg.closesAt + 2 minutes);
        cfg.stake = 5e6;
        cfg.feeBps = 500;
        cfg.creatorBps = 100;
        cfg.capMultiple = 10;
        cfg.minEntrants = 3;
        cfg.creator = creator;
        cfg.questionHash = keccak256("Cats or dogs?|Cats|Dogs");
    }

    function _create(IFlockedEscrow.RoundConfig memory cfg) internal returns (uint256 roundId) {
        vm.prank(operator);
        roundId = escrow.createRound(cfg);
    }

    function _createDefault() internal returns (uint256) {
        return _create(_cfg());
    }

    function _warpOpen(uint256 roundId) internal {
        uint256 t = escrow.getRound(roundId).cfg.opensAt;
        if (block.timestamp < t) vm.warp(t);
    }

    function _warpBeacon(uint256 roundId) internal {
        vm.warp(escrow.beaconTime(escrow.getRound(roundId).cfg.beaconRound));
    }

    // ---------------------------------------------------------------- tickets and entries

    function _newPlayer() internal returns (address p) {
        p = address(uint160(uint256(keccak256(abi.encode("player", ++_playerNonce)))));
    }

    function _tag(uint256 roundId, address player) internal pure returns (bytes32) {
        return keccak256(abi.encode("personTag", roundId, player));
    }

    function _ticket(uint256 roundId, address wallet) internal view returns (IFlockedEscrow.EntryTicket memory t) {
        t = IFlockedEscrow.EntryTicket(roundId, wallet, _tag(roundId, wallet), uint64(block.timestamp + 5 minutes));
    }

    /// @dev The EIP-712 digest computed independently of the contract (name "Flocked", version "1").
    function _digest(address verifyingContract, IFlockedEscrow.EntryTicket memory t) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("Flocked"), keccak256("1"), block.chainid, verifyingContract)
        );
        bytes32 structHash = keccak256(abi.encode(TICKET_TYPEHASH, t.roundId, t.wallet, t.personTag, t.expiry));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _signWith(uint256 pk, address verifyingContract, IFlockedEscrow.EntryTicket memory t)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(verifyingContract, t));
        return abi.encodePacked(r, s, v);
    }

    function _sign(IFlockedEscrow.EntryTicket memory t) internal view returns (bytes memory) {
        return _signWith(signerPk, address(escrow), t);
    }

    function _ct(uint256 len) internal pure returns (bytes memory c) {
        c = new bytes(len);
        for (uint256 i; i < len; i++) {
            c[i] = bytes1(uint8(i * 7 + 1));
        }
    }

    function _fund(address player, uint256 amount) internal {
        usdc.mint(player, amount);
        vm.prank(player);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _enter(uint256 roundId, address player) internal {
        IFlockedEscrow.EntryTicket memory t = _ticket(roundId, player);
        _fund(player, escrow.getRound(roundId).cfg.stake);
        bytes memory sig = _sign(t);
        vm.prank(player);
        escrow.enter(roundId, _ct(96), t, sig);
    }

    function _enterNew(uint256 roundId) internal returns (address p) {
        p = _newPlayer();
        _enter(roundId, p);
    }

    function _enterMany(uint256 roundId, uint256 n) internal returns (address[] memory ps) {
        ps = new address[](n);
        for (uint256 i; i < n; i++) {
            ps[i] = _enterNew(roundId);
        }
    }

    // ---------------------------------------------------------------- settlement

    function _outcome(uint256 roundId, uint256 n0, uint256 n1, uint256 nVoid)
        internal
        view
        returns (StakesMath.Outcome memory)
    {
        IFlockedEscrow.RoundConfig memory c = escrow.getRound(roundId).cfg;
        return StakesMath.compute(c.stake, c.feeBps, c.creatorBps, c.capMultiple, c.minEntrants, n0, n1, nVoid);
    }

    /// @dev Creates `cfg`, enters n0 + n1 + nVoid fresh players, and builds the honest payout tree. Does not propose.
    function _populate(IFlockedEscrow.RoundConfig memory cfg, uint32 n0, uint32 n1, uint32 nVoid)
        internal
        returns (Fixture memory f)
    {
        f.roundId = _create(cfg);
        _warpOpen(f.roundId);
        f.option0 = _enterMany(f.roundId, n0);
        f.option1 = _enterMany(f.roundId, n1);
        f.voids = _enterMany(f.roundId, nVoid);
        f.outcome = _outcome(f.roundId, n0, n1, nVoid);
        if (f.outcome.status == StakesMath.STATUS_SETTLE) _buildTree(f);
    }

    function _buildTree(Fixture memory f) internal pure {
        (address[] memory winners, address[] memory losers) =
            f.outcome.winner == 0 ? (f.option0, f.option1) : (f.option1, f.option0);
        uint256 nRebate = f.outcome.r > 0 ? losers.length : 0;
        uint256 total = winners.length + nRebate + f.voids.length;
        f.leaves = new bytes32[](total);
        f.leafAccounts = new address[](total);
        f.leafKinds = new uint8[](total);
        uint256 k;
        for (uint256 i; i < winners.length; i++) {
            k = _push(f, k, winners[i], 0);
        }
        for (uint256 i; i < nRebate; i++) {
            k = _push(f, k, losers[i], 1);
        }
        for (uint256 i; i < f.voids.length; i++) {
            k = _push(f, k, f.voids[i], 2);
        }
    }

    function _push(Fixture memory f, uint256 k, address a, uint8 kind) private pure returns (uint256) {
        f.leaves[k] = TestMerkle.leaf(f.roundId, a, kind);
        f.leafAccounts[k] = a;
        f.leafKinds[k] = kind;
        return k + 1;
    }

    function _root(Fixture memory f) internal pure returns (bytes32) {
        return f.leaves.length == 0 ? bytes32(0) : TestMerkle.root(f.leaves);
    }

    /// @dev Populates a default-config round and proposes the honest tally at beacon time.
    function _proposed(uint32 n0, uint32 n1, uint32 nVoid) internal returns (Fixture memory f) {
        f = _populate(_cfg(), n0, n1, nVoid);
        _warpBeacon(f.roundId);
        vm.prank(operator);
        escrow.propose(f.roundId, n0, n1, nVoid, _root(f), keccak256("bundle"));
    }

    function _warpClaimsOpen(uint256 roundId) internal {
        vm.warp(escrow.getRound(roundId).claimsOpenAt);
    }

    function _proof(Fixture memory f, address account, uint8 kind) internal pure returns (bytes32[] memory) {
        for (uint256 i; i < f.leaves.length; i++) {
            if (f.leafAccounts[i] == account && f.leafKinds[i] == kind) return TestMerkle.proof(f.leaves, i);
        }
        revert("leaf not found");
    }

    function _claim(Fixture memory f, address account, uint8 kind) internal {
        bytes32[] memory p = _proof(f, account, kind);
        vm.prank(account);
        escrow.claim(f.roundId, IFlockedEscrow.Kind(kind), p);
    }
}
