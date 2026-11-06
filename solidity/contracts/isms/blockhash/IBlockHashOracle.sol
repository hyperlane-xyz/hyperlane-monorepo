// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IBlockHashOracle {
    function origin() external view returns (uint32);

    function blockHash(uint256 height) external view returns (uint256);
}
