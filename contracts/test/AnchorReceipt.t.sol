// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin-contracts/utils/cryptography/ECDSA.sol";

import {FlockedAnchor} from "../src/FlockedAnchor.sol";
import {IFlockedAnchor} from "../src/interfaces/IFlockedAnchor.sol";
import {AnchorBase} from "./AnchorBase.t.sol";

/// @notice Entry receipts: the P2.2 EIP-712 type and domain, `receiptDigest`, `verifyReceipt`, and a receipt signed
///         off-chain with viem's `signTypedData` (packages/abi/test/fixtures/receipt.json) recovering on-chain.
contract AnchorReceiptTest is AnchorBase {
    string internal constant FIXTURE = "../packages/abi/test/fixtures/receipt.json";

    function _receipt() internal pure returns (IFlockedAnchor.Receipt memory r) {
        r.roundId = bytes16(keccak256("round"));
        r.mode = 0;
        r.userIdHash = keccak256(abi.encode(r.roundId, "user-1"));
        r.stake = 100;
        r.commitment = keccak256("ciphertext");
        r.seq = 7;
        r.closesAt = uint64(START + 1 hours);
        r.beaconRound = 22_390_119;
    }

    function _sign(uint256 pk, IFlockedAnchor.Receipt memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, anchor.receiptDigest(r));
        return abi.encodePacked(rr, s, v);
    }

    function test_receiptDigest_matchesEip712() public view {
        IFlockedAnchor.Receipt memory r = _receipt();
        bytes32 typehash = keccak256(
            "Receipt(bytes16 roundId,uint8 mode,bytes32 userIdHash,uint64 stake,bytes32 commitment,uint32 seq,uint64 closesAt,uint64 beaconRound)"
        );
        assertEq(anchor.RECEIPT_TYPEHASH(), typehash);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Flocked"),
                keccak256("1"),
                block.chainid,
                address(anchor)
            )
        );
        assertEq(anchor.domainSeparator(), domain);
        bytes32 structHash = keccak256(
            abi.encode(
                typehash, r.roundId, r.mode, r.userIdHash, r.stake, r.commitment, r.seq, r.closesAt, r.beaconRound
            )
        );
        assertEq(anchor.receiptDigest(r), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    function test_verifyReceipt_currentSignerOnly() public {
        IFlockedAnchor.Receipt memory r = _receipt();
        bytes memory sig = _sign(receiptPk, r);
        assertTrue(anchor.verifyReceipt(r, sig));

        // Another key, a changed field, a malformed signature.
        assertFalse(anchor.verifyReceipt(r, _sign(0xBAD, r)));
        IFlockedAnchor.Receipt memory changed = _receipt();
        changed.seq = 8;
        assertFalse(anchor.verifyReceipt(changed, sig));
        assertFalse(anchor.verifyReceipt(r, new bytes(65)));
        assertFalse(anchor.verifyReceipt(r, hex"1234"));

        // Disabled receipts verify nothing; after a rotation, only the new signer's receipts verify.
        vm.prank(admin);
        anchor.setReceiptSigner(address(0));
        assertFalse(anchor.verifyReceipt(r, sig));
        uint256 newPk = uint256(keccak256("flocked.test.receipt-signer.2"));
        vm.startPrank(admin);
        anchor.scheduleReceiptSigner(vm.addr(newPk));
        vm.warp(block.timestamp + 72 hours);
        anchor.executeReceiptSigner(vm.addr(newPk));
        vm.stopPrank();
        assertFalse(anchor.verifyReceipt(r, sig));
        assertTrue(anchor.verifyReceipt(r, _sign(newPk, r)));
    }

    function test_receipt_domainBindsChainAndContract() public {
        IFlockedAnchor.Receipt memory r = _receipt();
        bytes memory sig = _sign(receiptPk, r);
        FlockedAnchor other = new FlockedAnchor(admin, anchorer, receiptSigner, GENESIS, PERIOD);
        assertFalse(other.verifyReceipt(r, sig));
        vm.chainId(8453);
        assertFalse(anchor.verifyReceipt(r, sig));
    }

    /// @notice Acceptance check: a receipt signed with viem's `signTypedData` recovers on-chain.
    function test_viemSignedReceipt_recoversOnChain() public {
        string memory json = vm.readFile(FIXTURE);
        address at = vm.parseJsonAddress(json, ".verifyingContract");
        address signer = vm.parseJsonAddress(json, ".signer");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        deployCodeTo("FlockedAnchor.sol:FlockedAnchor", abi.encode(admin, anchorer, signer, GENESIS, PERIOD), at);
        FlockedAnchor a = FlockedAnchor(at);

        IFlockedAnchor.Receipt memory r;
        r.roundId = bytes16(vm.parseJsonBytes(json, ".receipt.roundId"));
        r.mode = uint8(vm.parseJsonUint(json, ".receipt.mode"));
        r.userIdHash = vm.parseJsonBytes32(json, ".receipt.userIdHash");
        r.stake = uint64(vm.parseJsonUint(json, ".receipt.stake"));
        r.commitment = vm.parseJsonBytes32(json, ".receipt.commitment");
        r.seq = uint32(vm.parseJsonUint(json, ".receipt.seq"));
        r.closesAt = uint64(vm.parseJsonUint(json, ".receipt.closesAt"));
        r.beaconRound = uint64(vm.parseJsonUint(json, ".receipt.beaconRound"));
        bytes memory sig = vm.parseJsonBytes(json, ".signature");

        assertEq(a.receiptDigest(r), vm.parseJsonBytes32(json, ".digest"), "digest differs from viem's hashTypedData");
        assertEq(ECDSA.recover(a.receiptDigest(r), sig), signer);
        assertTrue(a.verifyReceipt(r, sig));
    }
}
