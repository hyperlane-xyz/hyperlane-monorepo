// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IBlockHashOracle
 * @notice Interface for an oracle that provides block hashes from a specific origin chain
 */
interface IBlockHashOracle {
    /**
     * @notice Returns the origin domain ID this oracle serves
     * @return The origin domain ID
     */
    function origin() external view returns (uint32);

    /**
     * @notice Returns the block hash for a given block height on the origin chain
     * @param height The block number to query
     * @return The block hash, or bytes32(0) if not available
     */
    function blockHash(uint256 height) external view returns (bytes32);
}
