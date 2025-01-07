// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// Magically knows the hash of the RLP-encoded block at any given height.
// Note that this is NOT the block_hash.
interface IBlockHashOracle {
    function origin() external view returns (uint32);
    function blockhash(uint256 height) external view returns (uint256 hash);
}
