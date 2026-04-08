// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Mock that mimics Tron USDT: transfer() succeeds but returns false.
contract TronUSDTMock {
    mapping(address => uint256) public balances;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balances[msg.sender] >= value, "insufficient balance");
        balances[msg.sender] -= value;
        balances[to] += value;
        return false;
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool) {
        require(balances[from] >= value, "insufficient balance");
        balances[from] -= value;
        balances[to] += value;
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @dev Mock ERC20 that returns false on transfer without reverting.
contract FalseReturningERC20Mock {
    mapping(address => uint256) public balances;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(
        address,
        address,
        uint256
    ) external pure returns (bool) {
        return false;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @dev Harness that exposes the Tron-patched SafeERC20 functions for testing.
contract SafeERC20Harness {
    using SafeERC20 for IERC20;

    function safeTransfer(IERC20 token, address to, uint256 value) external {
        token.safeTransfer(to, value);
    }

    function safeTransferFrom(
        IERC20 token,
        address from,
        address to,
        uint256 value
    ) external {
        token.safeTransferFrom(from, to, value);
    }
}
