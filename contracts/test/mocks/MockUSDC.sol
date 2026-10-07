// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin-contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin-contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Test USDC: 6 decimals, EIP-2612 permit, open minting, and a blocklist like Circle's.
contract MockUSDC is ERC20, ERC20Permit {
    error Blocked(address account);

    mapping(address => bool) public blocked;

    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}
