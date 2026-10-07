// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Hashes} from "@openzeppelin-contracts/utils/cryptography/Hashes.sol";

/// @notice Minimal sorted-pair Merkle tree for tests. Leaves use the StandardMerkleTree double hash, so proofs verify
///         with OpenZeppelin's `MerkleProof` exactly as the JS merkle-tree library proofs do.
library TestMerkle {
    function leaf(uint256 roundId, address account, uint8 kind) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(roundId, account, kind))));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "empty tree");
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = _up(level);
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory out) {
        bytes32[] memory buf = new bytes32[](64);
        uint256 n;
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 sib = index ^ 1;
            if (sib < level.length) buf[n++] = level[sib];
            level = _up(level);
            index /= 2;
        }
        out = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            out[i] = buf[i];
        }
    }

    function _up(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i; i < next.length; i++) {
            uint256 l = 2 * i;
            next[i] = l + 1 < level.length ? Hashes.commutativeKeccak256(level[l], level[l + 1]) : level[l];
        }
    }
}
