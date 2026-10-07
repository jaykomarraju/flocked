// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Pausable} from "@openzeppelin-contracts/utils/Pausable.sol";

import {FlockedEscrow} from "../src/FlockedEscrow.sol";
import {IFlockedEscrow} from "../src/interfaces/IFlockedEscrow.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {EscrowBase} from "./utils/EscrowBase.sol";

/// @notice CON-2 (ticket signature, wallet binding, expiry, per-person dedupe) and CON-10 (cross-escrow replay).
contract EscrowEnterTest is EscrowBase {
    uint256 internal id;
    address internal alice;

    function setUp() public override {
        super.setUp();
        id = _createDefault();
        _warpOpen(id);
        alice = _newPlayer();
        _fund(alice, 1_000e6);
    }

    function _enterAs(address who, IFlockedEscrow.EntryTicket memory t, bytes memory sig, bytes memory ct) internal {
        vm.prank(who);
        escrow.enter(id, ct, t, sig);
    }

    function _expectEnterRevert(
        address who,
        IFlockedEscrow.EntryTicket memory t,
        bytes memory sig,
        bytes memory ct,
        bytes memory err
    ) internal {
        vm.expectRevert(err);
        _enterAs(who, t, sig, ct);
    }

    // ---------------------------------------------------------------- happy path

    function test_enter_pullsStakeRecordsAndEmitsFullCiphertext() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        bytes memory ct = _ct(2048);
        bytes32 digest = _digest(address(escrow), t);
        assertEq(escrow.ticketDigest(t), digest);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IFlockedEscrow.Entered(id, alice, t.personTag, digest, ct);
        _enterAs(alice, t, sig, ct);

        IFlockedEscrow.Round memory rd = escrow.getRound(id);
        assertEq(rd.entryCount, 1);
        assertEq(rd.roundBalance, 5e6);
        assertEq(usdc.balanceOf(address(escrow)), 5e6);
        assertEq(usdc.balanceOf(alice), 1_000e6 - 5e6);
        assertTrue(escrow.hasEntered(id, alice));
        assertTrue(escrow.personTagUsed(id, t.personTag));
        assertEq(escrow.totalObligations(), 5e6);
    }

    function test_enter_domainUsesBlockChainId() public {
        bytes32 expected = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("Flocked"), keccak256("1"), block.chainid, address(escrow))
        );
        assertEq(escrow.domainSeparator(), expected);

        // A ticket signed under another chain ID's domain does not verify here.
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        uint256 realChain = block.chainid;
        vm.chainId(84532);
        bytes memory sigOtherChain = _sign(t);
        vm.chainId(realChain);
        _expectEnterRevert(
            alice, t, sigOtherChain, _ct(64), abi.encodeWithSelector(IFlockedEscrow.InvalidTicketSignature.selector)
        );
    }

    function test_enter_ticketValidAtExactExpiry() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        vm.warp(t.expiry);
        _enterAs(alice, t, sig, _ct(64));
        assertTrue(escrow.hasEntered(id, alice));
    }

    function test_enterWithPermit_pullsWithPermit() public {
        uint256 pk = 0xB0B;
        address bob = vm.addr(pk);
        usdc.mint(bob, 5e6);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, bob, 5e6, deadline);

        IFlockedEscrow.EntryTicket memory t = _ticket(id, bob);
        bytes memory sig = _sign(t);
        vm.prank(bob);
        escrow.enterWithPermit(id, _ct(64), t, sig, deadline, v, r, s);
        assertTrue(escrow.hasEntered(id, bob));
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_enterWithPermit_frontRunPermitStillEnters() public {
        uint256 pk = 0xB0B;
        address bob = vm.addr(pk);
        usdc.mint(bob, 5e6);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, bob, 5e6, deadline);
        // Someone submits the permit first; the entry's own permit call then fails and is ignored.
        usdc.permit(bob, address(escrow), 5e6, deadline, v, r, s);

        IFlockedEscrow.EntryTicket memory t = _ticket(id, bob);
        bytes memory sig = _sign(t);
        vm.prank(bob);
        escrow.enterWithPermit(id, _ct(64), t, sig, deadline, v, r, s);
        assertTrue(escrow.hasEntered(id, bob));
    }

    function test_enterWithPermit_revertsOnBadTicket() public {
        uint256 pk = 0xB0B;
        address bob = vm.addr(pk);
        usdc.mint(bob, 5e6);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, bob, 5e6, deadline);
        IFlockedEscrow.EntryTicket memory t = _ticket(id, bob);
        bytes memory sig = _signWith(0xBAD, address(escrow), t);
        vm.prank(bob);
        vm.expectRevert(IFlockedEscrow.InvalidTicketSignature.selector);
        escrow.enterWithPermit(id, _ct(64), t, sig, deadline, v, r, s);
    }

    function _permitSig(uint256 pk, address owner, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                address(escrow),
                value,
                usdc.nonces(owner),
                deadline
            )
        );
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    // ---------------------------------------------------------------- ticket signature and binding

    function test_enter_revertsOnWrongSigner() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        _expectEnterRevert(
            alice,
            t,
            _signWith(0xBAD, address(escrow), t),
            _ct(64),
            abi.encodeWithSelector(IFlockedEscrow.InvalidTicketSignature.selector)
        );
    }

    function test_enter_revertsOnTamperedTicket() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        t.expiry += 1;
        _expectEnterRevert(
            alice, t, sig, _ct(64), abi.encodeWithSelector(IFlockedEscrow.InvalidTicketSignature.selector)
        );
        t.expiry -= 1;
        t.personTag = keccak256("other person");
        _expectEnterRevert(
            alice, t, sig, _ct(64), abi.encodeWithSelector(IFlockedEscrow.InvalidTicketSignature.selector)
        );
    }

    function test_enter_revertsOnMalformedSignature() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        bytes memory short = new bytes(64);
        for (uint256 i; i < 64; i++) {
            short[i] = sig[i];
        }
        _expectEnterRevert(
            alice, t, short, _ct(64), abi.encodeWithSelector(IFlockedEscrow.InvalidTicketSignature.selector)
        );
        _expectEnterRevert(
            alice, t, new bytes(65), _ct(64), abi.encodeWithSelector(IFlockedEscrow.InvalidTicketSignature.selector)
        );
    }

    function test_enter_revertsWhenWalletIsNotSender() public {
        address bob = _newPlayer();
        _fund(bob, 5e6);
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice); // issued to alice
        bytes memory sig = _sign(t);
        _expectEnterRevert(bob, t, sig, _ct(64), abi.encodeWithSelector(IFlockedEscrow.TicketWalletMismatch.selector));
    }

    function test_enter_revertsOnTicketForOtherRound() public {
        uint256 other = _createDefault();
        IFlockedEscrow.EntryTicket memory t = _ticket(other, alice);
        bytes memory sig = _sign(t);
        _expectEnterRevert(alice, t, sig, _ct(64), abi.encodeWithSelector(IFlockedEscrow.TicketRoundMismatch.selector));
    }

    function test_enter_revertsOnExpiredTicket() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        vm.warp(t.expiry + 1);
        _expectEnterRevert(alice, t, sig, _ct(64), abi.encodeWithSelector(IFlockedEscrow.TicketExpired.selector));
    }

    function test_enter_revertsOnZeroPersonTag() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        t.personTag = bytes32(0);
        bytes memory sig = _sign(t);
        _expectEnterRevert(alice, t, sig, _ct(64), abi.encodeWithSelector(IFlockedEscrow.ZeroPersonTag.selector));
    }

    function test_enter_revertsWhenSignerDisabled() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        vm.prank(admin);
        escrow.setTicketSigner(address(0));
        _expectEnterRevert(alice, t, sig, _ct(64), abi.encodeWithSelector(IFlockedEscrow.TicketSignerDisabled.selector));
    }

    // ---------------------------------------------------------------- dedupe

    function test_enter_rejectsSecondEntryFromSameWallet() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        _enterAs(alice, t, _sign(t), _ct(64));
        // Even with a fresh person tag, the address has entered.
        t.personTag = keccak256("fresh tag");
        bytes memory sig = _sign(t);
        _expectEnterRevert(alice, t, sig, _ct(64), abi.encodeWithSelector(IFlockedEscrow.AlreadyEntered.selector));
    }

    function test_enter_rejectsSamePersonTagFromAnotherWallet() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        _enterAs(alice, t, _sign(t), _ct(64));

        address aliceSecondWallet = _newPlayer();
        _fund(aliceSecondWallet, 5e6);
        IFlockedEscrow.EntryTicket memory t2 = _ticket(id, aliceSecondWallet);
        t2.personTag = t.personTag;
        bytes memory sig2 = _sign(t2);
        _expectEnterRevert(
            aliceSecondWallet, t2, sig2, _ct(64), abi.encodeWithSelector(IFlockedEscrow.PersonTagUsed.selector)
        );
    }

    function test_enter_samePersonTagAllowedInAnotherRound() public {
        uint256 other = _createDefault();
        _warpOpen(other);
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        _enterAs(alice, t, _sign(t), _ct(64));
        IFlockedEscrow.EntryTicket memory t2 = IFlockedEscrow.EntryTicket(other, alice, t.personTag, t.expiry);
        bytes memory sig2 = _sign(t2);
        vm.prank(alice);
        escrow.enter(other, _ct(64), t2, sig2);
        assertTrue(escrow.hasEntered(other, alice));
    }

    // ---------------------------------------------------------------- ciphertext, window, pause, token

    function test_enter_ciphertextLengthBounds() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        _expectEnterRevert(
            alice, t, sig, _ct(63), abi.encodeWithSelector(IFlockedEscrow.CiphertextLength.selector, uint256(63))
        );
        _expectEnterRevert(
            alice, t, sig, _ct(2049), abi.encodeWithSelector(IFlockedEscrow.CiphertextLength.selector, uint256(2049))
        );
        _enterAs(alice, t, sig, _ct(64));
    }

    function test_enter_revertsBeforeOpensAt() public {
        uint256 later = _createDefault();
        IFlockedEscrow.EntryTicket memory t = _ticket(later, alice);
        bytes memory sig = _sign(t);
        vm.prank(alice);
        vm.expectRevert(IFlockedEscrow.RoundNotYetOpen.selector);
        escrow.enter(later, _ct(64), t, sig);
    }

    function test_enter_revertsAtClosesAt() public {
        vm.warp(escrow.getRound(id).cfg.closesAt - 1);
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        vm.warp(escrow.getRound(id).cfg.closesAt);
        _expectEnterRevert(alice, t, sig, _ct(64), abi.encodeWithSelector(IFlockedEscrow.RoundClosed.selector));
    }

    function test_enter_revertsWhenPaused() public {
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        vm.prank(pauser);
        escrow.pause();
        _expectEnterRevert(alice, t, sig, _ct(64), abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.enterWithPermit(id, _ct(64), t, sig, 0, 0, bytes32(0), bytes32(0));
    }

    function test_enter_revertsOnVoidedRound() public {
        vm.prank(operator);
        escrow.voidRound(id);
        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sig = _sign(t);
        _expectEnterRevert(
            alice,
            t,
            sig,
            _ct(64),
            abi.encodeWithSelector(IFlockedEscrow.WrongStatus.selector, id, IFlockedEscrow.Status.Refunded)
        );
    }

    function test_enter_revertsWhenTokenDeliversLessThanStake() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        FlockedEscrow e = _deploy(address(fot));
        vm.prank(operator);
        uint256 rid = e.createRound(_cfg());
        vm.warp(e.getRound(rid).cfg.opensAt);
        fot.mint(alice, 10e6);
        vm.prank(alice);
        fot.approve(address(e), type(uint256).max);
        IFlockedEscrow.EntryTicket memory t = _ticket(rid, alice);
        bytes memory sig = _signWith(signerPk, address(e), t);
        vm.prank(alice);
        vm.expectRevert(IFlockedEscrow.StakeTransferMismatch.selector);
        e.enter(rid, _ct(64), t, sig);
    }

    // ---------------------------------------------------------------- CON-10

    function test_enter_ticketSignedForOneEscrowRevertsOnAnother() public {
        FlockedEscrow second = _deploy(address(usdc));
        vm.prank(operator);
        uint256 rid = second.createRound(_cfg());
        assertEq(rid, id, "same round ID on both escrows");
        vm.warp(second.getRound(rid).cfg.opensAt);
        vm.prank(alice);
        usdc.approve(address(second), type(uint256).max);

        IFlockedEscrow.EntryTicket memory t = _ticket(id, alice);
        bytes memory sigForFirst = _signWith(signerPk, address(escrow), t);

        vm.prank(alice);
        vm.expectRevert(IFlockedEscrow.InvalidTicketSignature.selector);
        second.enter(rid, _ct(64), t, sigForFirst);

        // The same ticket is valid where it was issued.
        _enterAs(alice, t, sigForFirst, _ct(64));
        assertTrue(escrow.hasEntered(id, alice));
        assertFalse(second.hasEntered(rid, alice));
    }

    function test_mockUsdc_hasSixDecimals() public view {
        assertEq(MockUSDC(address(usdc)).decimals(), 6);
    }
}
