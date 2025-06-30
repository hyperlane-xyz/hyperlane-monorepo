// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

interface IWETH {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
}
