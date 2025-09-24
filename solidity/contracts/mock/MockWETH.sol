// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {IWETH} from "../token/interfaces/IWETH.sol";

contract MockWETH is IWETH {
    function allowance(
        address _owner,
        address _spender
    ) external view returns (uint256) {}

    function approve(
        address _spender,
        uint256 _amount
    ) external returns (bool) {
        return true;
    }

    function balanceOf(address _account) external view returns (uint256) {
        return 0;
    }

    function deposit() external payable {}

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        return true;
    }

    function withdraw(uint256 amount) external {}
}
