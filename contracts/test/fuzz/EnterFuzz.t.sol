// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFlockedEscrow} from "../../src/interfaces/IFlockedEscrow.sol";
import {EscrowBase} from "../utils/EscrowBase.sol";

/// @notice CON-11: fuzz `enter`.
contract EnterFuzzTest is EscrowBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _createDefault();
        _warpOpen(id);
    }

    function testFuzz_enter_ciphertextLength(uint256 len) public {
        len = bound(len, 0, 4096);
        address p = _newPlayer();
        _fund(p, 5e6);
        IFlockedEscrow.EntryTicket memory t = _ticket(id, p);
        bytes memory sig = _sign(t);
        bool ok = len >= 64 && len <= 2048;
        if (!ok) vm.expectRevert(abi.encodeWithSelector(IFlockedEscrow.CiphertextLength.selector, len));
        vm.prank(p);
        escrow.enter(id, _ct(len), t, sig);
        assertEq(escrow.hasEntered(id, p), ok);
    }

    function testFuzz_enter_onlyCurrentSignerAccepted(uint256 pk) public {
        pk = bound(pk, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        address p = _newPlayer();
        _fund(p, 5e6);
        IFlockedEscrow.EntryTicket memory t = _ticket(id, p);
        bytes memory sig = _signWith(pk, address(escrow), t);
        if (pk != signerPk) vm.expectRevert(IFlockedEscrow.InvalidTicketSignature.selector);
        vm.prank(p);
        escrow.enter(id, _ct(64), t, sig);
    }

    function testFuzz_enter_ticketBinding(address caller, address wallet, uint256 roundId, uint64 expiry, uint256 dt)
        public
    {
        vm.assume(caller != address(0) && caller != address(escrow) && caller != address(usdc));
        dt = bound(dt, 0, 59 minutes);
        vm.warp(block.timestamp + dt);
        _fund(caller, 5e6);
        IFlockedEscrow.EntryTicket memory t =
            IFlockedEscrow.EntryTicket(roundId, wallet, keccak256(abi.encode(caller, wallet)), expiry);
        bytes memory sig = _sign(t);

        bytes4 err;
        if (roundId != id) err = IFlockedEscrow.TicketRoundMismatch.selector;
        else if (wallet != caller) err = IFlockedEscrow.TicketWalletMismatch.selector;
        else if (block.timestamp > expiry) err = IFlockedEscrow.TicketExpired.selector;
        if (err != bytes4(0)) vm.expectRevert(err);
        vm.prank(caller);
        escrow.enter(id, _ct(64), t, sig);
        assertEq(escrow.hasEntered(id, caller), err == bytes4(0));
    }

    function testFuzz_enter_accumulatesBalance(uint8 n, uint128 stake) public {
        n = uint8(bound(n, 1, 40));
        IFlockedEscrow.RoundConfig memory cfg = _cfg();
        cfg.stake = uint128(bound(stake, 1e6, 100e6));
        uint256 rid = _create(cfg);
        _warpOpen(rid);
        _enterMany(rid, n);
        IFlockedEscrow.Round memory rd = escrow.getRound(rid);
        assertEq(rd.entryCount, n);
        assertEq(rd.roundBalance, uint256(n) * cfg.stake);
        assertEq(usdc.balanceOf(address(escrow)), uint256(n) * cfg.stake);
        assertEq(escrow.totalObligations(), uint256(n) * cfg.stake);
    }

    function testFuzz_enter_personTagDedupe(bytes32 tag) public {
        vm.assume(tag != bytes32(0));
        address a = _newPlayer();
        address b = _newPlayer();
        _fund(a, 5e6);
        _fund(b, 5e6);
        IFlockedEscrow.EntryTicket memory ta = IFlockedEscrow.EntryTicket(id, a, tag, uint64(block.timestamp + 300));
        IFlockedEscrow.EntryTicket memory tb = IFlockedEscrow.EntryTicket(id, b, tag, uint64(block.timestamp + 300));
        bytes memory sa = _sign(ta);
        bytes memory sb = _sign(tb);
        vm.prank(a);
        escrow.enter(id, _ct(64), ta, sa);
        vm.prank(b);
        vm.expectRevert(IFlockedEscrow.PersonTagUsed.selector);
        escrow.enter(id, _ct(64), tb, sb);
    }
}
