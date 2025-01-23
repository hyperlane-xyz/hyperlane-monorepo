// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IBlockHashOracle {
    // TypeError: Variables cannot be declared in interfaces.
    // uint32 public immutable origin;
    function origin() external pure returns (uint32);

    function blockhash(uint256 height) external view returns (uint256);
}
